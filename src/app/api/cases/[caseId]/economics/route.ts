import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma";
import { requireApiContext, requireCanonicalPermission, requireCase, audit, type TenantContext } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import {
  computeEconomicLoss,
  scenarioCompare,
  sensitivityTable,
  type EconInputs,
  type EconResult,
} from "@/lib/engine/economics";
import {
  assumptionsToInputs,
  overridesToPartialInputs,
  economistReadiness,
  ASSUMPTION_KEYS,
  MEDICAL_OMISSION_NOTE,
  type StoredEconResult,
  type ScenarioRow,
} from "@/lib/reports/economist";

// ─────────────────────────────────────────────────────────────────────────────
// P5 Forensic Economist workflow — assumptions + scenarios API.
//
//   GET                — current (non-superseded) assumptions, scenarios, the
//                        readiness ladder, and the known-key metadata.
//   POST               — enter one assumption {key,value,unit,source,...}.
//                        Creates a new version and supersedes the prior
//                        current row for that key. Nothing is ever defaulted.
//   POST ?compute=1    — map current assumptions → EconInputs (422 listing
//                        missing keys — NEVER defaulted), run the
//                        deterministic engine (computeEconomicLoss +
//                        scenarioCompare + discount-rate sensitivityTable),
//                        and upsert EconomicScenario rows. The medical PV
//                        comes ONLY from the latest FINAL LCP/MCP ReportExport
//                        and its provenance is stored in result.medicalSource;
//                        with no such export the component is omitted with an
//                        explicit note.
//
// Writing requires the economist seat (physician.review — experts occupy
// PHYSICIAN_REVIEWER seats for the pilot, docs/25) or futurecare.edit.
// ─────────────────────────────────────────────────────────────────────────────

function requireEconomistSeat(ctx: TenantContext, caseId: string): void {
  requireCanonicalPermission(ctx, "economic.edit", { caseId });
}

async function loadCurrentAssumptions(caseId: string, firmId: string) {
  const rows = await prisma.economicAssumption.findMany({
    where: { caseId, firmId, supersededById: null },
    orderBy: [{ key: "asc" }, { createdAt: "asc" }],
  });
  // Attach expert display names (no relation on the model).
  const expertIds = [...new Set(rows.map((r) => r.expertId))];
  const experts = expertIds.length
    ? await prisma.user.findMany({ where: { id: { in: expertIds }, firmId }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(experts.map((e) => [e.id, e.name]));
  return rows.map((r) => ({ ...r, expertName: nameOf.get(r.expertId) ?? null }));
}

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    requireCanonicalPermission(ctx, "economic.view", { caseId: params.caseId });

    const [assumptions, scenarios] = await Promise.all([
      loadCurrentAssumptions(params.caseId, ctx.firm.id),
      prisma.economicScenario.findMany({ where: { caseId: params.caseId, firmId: ctx.firm.id }, orderBy: { createdAt: "asc" } }),
    ]);
    const { missing } = assumptionsToInputs(assumptions);
    // Pre-approval readiness for the workspace banner (report-level economist
    // approval/attestation is layered on by the report workflow, not here).
    const readiness = economistReadiness(
      assumptions,
      scenarios.map((s) => ({ name: s.name, result: s.result as StoredEconResult | null, computedAt: s.computedAt })),
      false,
      false,
    );
    return ok({ assumptions, scenarios, missing, readiness, keys: ASSUMPTION_KEYS });
  } catch (err) {
    return handleError(err);
  }
}

const assumptionSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(200),
  unit: z.string().min(1).max(50),
  // Every assumption MUST cite a source — a bare value is not accepted.
  source: z.string().min(3).max(1000),
  effectiveDate: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "effectiveDate must be a valid date")
    .optional(),
  rationale: z.string().max(2000).optional(),
});

const computeSchema = z.object({
  scenarios: z
    .array(
      z.object({
        name: z.string().min(1).max(50),
        overrides: z.record(z.union([z.number(), z.string()])),
      }),
    )
    .max(10)
    .optional(),
});

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    requireEconomistSeat(ctx, params.caseId);

    const url = new URL(req.url);
    const isCompute = url.searchParams.get("compute") === "1";
    // Economist authorship (assumptions/scenarios): review-class credential
    // boundary — enforced for enterprise/demo firms, credential.gap otherwise.
    await enforceReviewCredential(ctx, "ECONOMIST", {
      action: isCompute ? "economics.compute" : "economics.assumption",
      caseId: params.caseId,
    });
    if (isCompute) return compute(ctx, params.caseId, await req.json());

    const input = assumptionSchema.parse(await req.json());
    const prior = await prisma.economicAssumption.findFirst({
      where: { caseId: params.caseId, firmId: ctx.firm.id, key: input.key, supersededById: null },
    });
    const priorCount = await prisma.economicAssumption.count({
      where: { caseId: params.caseId, firmId: ctx.firm.id, key: input.key },
    });
    const created = await prisma.economicAssumption.create({
      data: {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        key: input.key,
        value: input.value,
        unit: input.unit,
        source: input.source,
        effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
        expertId: ctx.user.id,
        rationale: input.rationale ?? null,
        origin: "USER",
        version: priorCount + 1,
      },
    });
    // Supersede-on-edit: the prior current row for this key now points at its
    // successor; history is never deleted.
    if (prior) {
      await prisma.economicAssumption.update({ where: { id: prior.id }, data: { supersededById: created.id } });
    }
    await audit(ctx, "economics.assumption", {
      type: "economicAssumption",
      id: created.id,
      caseId: params.caseId,
      meta: { key: input.key, version: created.version, supersededId: prior?.id ?? null },
    });
    return ok({ assumption: created });
  } catch (err) {
    return handleError(err);
  }
}

// ── Compute ──────────────────────────────────────────────────────────────────

function toStored(result: EconResult, extra: Pick<StoredEconResult, "medicalSource" | "medicalNote" | "sensitivity">): Prisma.InputJsonValue {
  const stored: StoredEconResult = {
    pastLoss: result.pastLoss,
    futureLoss: result.futureLoss,
    benefits: result.benefits,
    householdServices: result.householdServices,
    medicalCostPresentValue: result.medicalCostPresentValue,
    totalPresentValue: result.totalPresentValue,
    inputsHash: result.inputsHash,
    inputs: result.inputs,
    medicalSource: extra.medicalSource ?? null,
    ...(extra.medicalNote !== undefined ? { medicalNote: extra.medicalNote } : {}),
    ...(extra.sensitivity !== undefined ? { sensitivity: extra.sensitivity } : {}),
  };
  // Strip undefined values for the Json column.
  return JSON.parse(JSON.stringify(stored)) as Prisma.InputJsonValue;
}

async function upsertScenario(
  caseId: string,
  firmId: string,
  name: string,
  overrides: Record<string, unknown>,
  result: Prisma.InputJsonValue,
  computedAt: Date,
) {
  const existing = await prisma.economicScenario.findFirst({ where: { caseId, firmId, name } });
  if (existing) {
    return prisma.economicScenario.update({
      where: { id: existing.id },
      data: { overrides: overrides as Prisma.InputJsonValue, result, computedAt },
    });
  }
  return prisma.economicScenario.create({
    data: { caseId, firmId, name, overrides: overrides as Prisma.InputJsonValue, result, computedAt },
  });
}

async function compute(ctx: TenantContext, caseId: string, body: unknown) {
  const input = computeSchema.parse(body);
  const requested = input.scenarios ?? [];
  if (requested.some((s) => s.name === "base")) {
    return ok({ error: 'Scenario name "base" is reserved — the base scenario is always computed from the current assumptions.' }, 422);
  }

  const assumptions = await loadCurrentAssumptions(caseId, ctx.firm.id);
  const mapped = assumptionsToInputs(assumptions);
  if (!mapped.inputs) {
    // NEVER default a missing assumption — refuse and name every gap.
    return ok(
      { error: "Required economic assumptions are missing or invalid. Enter each one explicitly; nothing is defaulted.", missing: mapped.missing },
      422,
    );
  }

  // Medical PV: ONLY from the latest FINAL LCP/MCP export for this case.
  const medicalExport = await prisma.reportExport.findFirst({
    where: {
      caseId,
      firmId: ctx.firm.id,
      draft: false,
      reportType: { in: ["LIFE_CARE_PLAN", "MEDICAL_COST_PROJECTION"] },
    },
    orderBy: { createdAt: "desc" },
  });
  const medicalSource = medicalExport
    ? { exportId: medicalExport.id, reportType: medicalExport.reportType ?? "LIFE_CARE_PLAN", presentValue: medicalExport.totalPresentValue }
    : null;
  const baseInputs: EconInputs = {
    ...mapped.inputs,
    ...(medicalSource ? { medicalCostPresentValue: medicalSource.presentValue } : {}),
  };

  // Scenario overrides arrive in assumption space (same unit as the current
  // row for the key); map each to an EconInputs partial or refuse.
  const overridePartials: Record<string, Partial<EconInputs>> = {};
  const overrideErrors: string[] = [];
  for (const s of requested) {
    const r = overridesToPartialInputs(assumptions, s.overrides as Record<string, number | string>);
    if (!r.partial) overrideErrors.push(...r.errors.map((e) => `${s.name}: ${e}`));
    else overridePartials[s.name] = r.partial;
  }
  if (overrideErrors.length > 0) {
    return ok({ error: "Scenario overrides are invalid.", missing: overrideErrors }, 422);
  }

  let baseResult: EconResult;
  let scenarioResults: Record<string, EconResult>;
  let sensitivity: { param: string; rows: { value: number; totalPresentValue: number }[] };
  try {
    baseResult = computeEconomicLoss(baseInputs);
    scenarioResults = scenarioCompare(baseInputs, overridePartials);
    const d = baseInputs.discountRate;
    const candidates = [d - 0.02, d - 0.01, d, d + 0.01, d + 0.02].filter((v) => v > -0.99);
    sensitivity = { param: "discountRate", rows: sensitivityTable(baseInputs, "discountRate", candidates) };
  } catch (err) {
    // The deterministic engine refuses invalid inputs — surface, never patch.
    const message = err instanceof Error ? err.message : "Economic engine rejected the inputs";
    return ok({ error: message }, 422);
  }

  const medicalNote = medicalSource ? undefined : MEDICAL_OMISSION_NOTE;
  const computedAt = new Date();
  const saved = [
    await upsertScenario(caseId, ctx.firm.id, "base", {}, toStored(baseResult, { medicalSource, medicalNote, sensitivity }), computedAt),
  ];
  for (const s of requested) {
    saved.push(
      await upsertScenario(
        caseId,
        ctx.firm.id,
        s.name,
        s.overrides,
        toStored(scenarioResults[s.name], { medicalSource, medicalNote }),
        computedAt,
      ),
    );
  }

  await audit(ctx, "economics.compute", {
    type: "economicScenario",
    caseId,
    meta: {
      scenarios: saved.map((s) => s.name),
      inputsHash: baseResult.inputsHash,
      medicalExportId: medicalSource?.exportId ?? null,
    },
  });

  const scenarios: ScenarioRow[] = saved.map((s) => ({
    name: s.name,
    overrides: s.overrides as Record<string, unknown>,
    result: s.result as StoredEconResult | null,
    computedAt: s.computedAt,
  }));
  return ok({ scenarios });
}
