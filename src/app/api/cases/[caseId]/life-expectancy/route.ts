import { z } from "zod";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { recomputeCosts } from "@/lib/engine/generate";
import { persistCaseValidation } from "@/lib/engine/validation";
import {
  baselineLifeExpectancy,
  composeBasis,
  physicianBasis,
  parseBasis,
  type BasisSex,
  type LifeExpectancyBasis,
} from "@/lib/engine/lifeExpectancy";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Life-expectancy basis (roadmap item: sourced projection horizon).
//   GET — the recorded basis plus the live actuarial baseline for the patient's
//         current age and sex, so the UI can show both without computing.
//   PUT — record the basis. The determined figure is always recomputed
//         server-side from the baseline + adjustments (never taken from the
//         client), synced onto Case.lifeExpectancyYears, ledgered as an
//         AssumptionChange, and cost projections are recomputed from it.
// ─────────────────────────────────────────────────────────────────────────────

function liveBaseline(kase: { dateOfBirth: Date | null; sex: string }) {
  if (!kase.dateOfBirth) return null;
  const age = (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000);
  return baselineLifeExpectancy(age, kase.sex as BasisSex);
}

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    const kase = await requireCase(ctx, params.caseId);
    return ok({
      basis: parseBasis((kase as { lifeExpectancyBasis?: unknown }).lifeExpectancyBasis),
      yearsInUse: kase.lifeExpectancyYears,
      actuarialBaseline: liveBaseline(kase),
    });
  } catch (err) {
    return handleError(err);
  }
}

const adjustmentSchema = z.object({
  deltaYears: z.number().min(-80).max(40),
  reason: z.string().min(1).max(500),
  source: z.string().min(1).max(500),
});

const putSchema = z.discriminatedUnion("mode", [
  // Derive the actuarial baseline from DOB + sex, with optional documented
  // adjustments (rated age, condition-specific literature, …).
  z.object({ mode: z.literal("actuarial"), adjustments: z.array(adjustmentSchema).max(10).default([]), note: z.string().max(1000).optional() }),
  // Record a physician-determined figure with its stated source and rationale.
  z.object({ mode: z.literal("physician"), years: z.number().min(0.5).max(110), source: z.string().min(1).max(500), reason: z.string().min(1).max(500) }),
  // Physician sign-off on the recorded basis.
  z.object({ mode: z.literal("approve") }),
  // Remove the recorded basis (the unstated-basis finding returns).
  z.object({ mode: z.literal("clear") }),
]);

export async function PUT(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    const kase = await requireCase(ctx, params.caseId);
    const input = putSchema.parse(await req.json());
    const prior = parseBasis((kase as { lifeExpectancyBasis?: unknown }).lifeExpectancyBasis);

    if (input.mode === "approve") {
      requirePermission(ctx, "physician.review");
      if (!prior) return ok({ error: "No life-expectancy basis is recorded to approve." }, 400);
      const approved: LifeExpectancyBasis = {
        ...prior,
        approvedById: ctx.user.id,
        approvedByName: ctx.user.name,
        approvedByRole: ctx.user.role,
        approvedAt: new Date().toISOString(),
      };
      await prisma.case.update({ where: { id: params.caseId }, data: { lifeExpectancyBasis: approved as never } });
      await audit(ctx, "case.life_expectancy_approve", { type: "case", id: params.caseId, caseId: params.caseId });
      await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
      return ok({ basis: approved });
    }

    requirePermission(ctx, "case.edit");

    if (input.mode === "clear") {
      await prisma.case.update({ where: { id: params.caseId }, data: { lifeExpectancyBasis: Prisma.DbNull } });
      await audit(ctx, "case.life_expectancy_clear", { type: "case", id: params.caseId, caseId: params.caseId });
      await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
      return ok({ basis: null });
    }

    const baseline = liveBaseline(kase);
    let basis: LifeExpectancyBasis;
    if (input.mode === "actuarial") {
      if (!baseline) return ok({ error: "The actuarial baseline requires the patient's date of birth on intake." }, 400);
      const stamped = input.adjustments.map((a) => ({
        ...a,
        enteredById: ctx.user.id,
        enteredByName: ctx.user.name,
        enteredByRole: ctx.user.role,
        enteredAt: new Date().toISOString(),
      }));
      basis = composeBasis(baseline, stamped, input.note ?? null);
    } else {
      basis = physicianBasis(input.years, input.source, input.reason, baseline);
      basis.adjustments = basis.adjustments.map((a) => ({
        ...a,
        enteredById: ctx.user.id,
        enteredByName: ctx.user.name,
        enteredByRole: ctx.user.role,
        enteredAt: new Date().toISOString(),
      }));
    }

    // Sync the figure the cost engine uses, ledger the change, recompute.
    const priorYears = kase.lifeExpectancyYears;
    await prisma.case.update({
      where: { id: params.caseId },
      data: { lifeExpectancyBasis: basis as never, lifeExpectancyYears: basis.determinedYears },
    });
    if (priorYears == null || Math.abs(priorYears - basis.determinedYears) > 1e-9) {
      await prisma.assumptionChange.create({
        data: {
          caseId: params.caseId,
          firmId: ctx.firm.id,
          field: "lifeExpectancyYears",
          originalValue: priorYears,
          revisedValue: basis.determinedYears,
          reason:
            basis.method === "PHYSICIAN_DETERMINED"
              ? `Physician determination (${basis.adjustments[0]?.source ?? "stated"})`
              : `Basis recorded: ${basis.baselineLabel}${basis.adjustments.length ? ` with ${basis.adjustments.length} documented adjustment(s)` : ""}`,
          userId: ctx.user.id,
        },
      });
    }
    const totals = await recomputeCosts(params.caseId);
    await audit(ctx, "case.life_expectancy_basis", {
      type: "case",
      id: params.caseId,
      caseId: params.caseId,
      meta: { method: basis.method, determinedYears: basis.determinedYears, adjustments: basis.adjustments.length },
    });
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
    return ok({ basis, totals });
  } catch (err) {
    return handleError(err);
  }
}
