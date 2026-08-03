import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, TenantError } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { ok, handleError } from "@/lib/api";
import { evaluateFutureDamages, FDE_LOGIC_VERSION, type FdeInput } from "@/lib/engine/damagesEvaluation";
import { computeInputsHash, type FdeRowIds } from "@/lib/engine/damagesFingerprint";
import type { FutureDamagesEvaluation, Prisma } from "@/generated/prisma";

// Future Damages Evaluation (MDIP — docs/28). GET returns the latest persisted
// evaluation with a computed freshness flag; POST snapshots the case's REAL
// structured data, runs the pure fde-1 engine, persists the result, and marks
// every prior row stale. The engine is deterministic and never invents facts —
// this route only assembles the snapshot and stores the verdict.

/** Assemble the engine input from persisted case data only, plus the identity
 *  of every row behind it (for the inputs fingerprint). */
async function buildSnapshot(caseId: string): Promise<{ input: FdeInput; rowIds: FdeRowIds }> {
  const [conditions, items, findings, documents, chronologyEvents, vocationalEntries, economicAssumptions, interviewFindings] =
    await Promise.all([
      prisma.condition.findMany({
        where: { caseId },
        select: { id: true, name: true, relatedness: true, evidenceSources: true },
      }),
      prisma.futureCareItem.findMany({
        where: { caseId, supersededAt: null },
        select: {
          id: true,
          service: true,
          category: true,
          probability: true,
          physicianStatus: true,
          isLifetime: true,
          durationYears: true,
          presentValue: true,
          contingencyOnly: true,
          origin: true,
        },
      }),
      prisma.validationFinding.findMany({
        where: { caseId, status: "OPEN" },
        select: { id: true, result: true, issue: true, severity: true, exportBlocking: true },
      }),
      prisma.document.findMany({ where: { caseId } }),
      prisma.chronologyEvent.findMany({ where: { caseId } }),
      prisma.vocationalEntry.findMany({ where: { caseId, supersededById: null } }),
      prisma.economicAssumption.findMany({ where: { caseId, supersededById: null } }),
      prisma.interviewFinding.findMany({ where: { caseId } }),
    ]);

  // Missing-record signals: persisted finding texts that mention missing
  // records — derived, never invented (the engine treats them verbatim).
  const missingRecordFindings = findings
    .filter((f) => /missing/i.test(`${f.result} ${f.issue}`) && /record|document|report|page/i.test(`${f.result} ${f.issue}`))
  const missingRecordSignals = missingRecordFindings.map((f) => f.issue);

  const input: FdeInput = {
    conditions: conditions.map((c) => ({
      id: c.id,
      name: c.name,
      relatedness: c.relatedness,
      evidenceSourceCount: Array.isArray(c.evidenceSources) ? c.evidenceSources.length : 0,
    })),
    items: items.map((i) => ({
      id: i.id,
      service: i.service,
      category: i.category,
      probability: i.probability,
      physicianStatus: i.physicianStatus,
      isLifetime: i.isLifetime,
      durationYears: i.durationYears,
      presentValue: i.presentValue,
      contingencyOnly: i.contingencyOnly,
      origin: i.origin,
    })),
    findings: findings.map((f) => ({ id: f.id, result: f.result, severity: f.severity, exportBlocking: f.exportBlocking })),
    documentsCount: documents.length,
    chronologyCount: chronologyEvents.length,
    vocationalEntryCount: vocationalEntries.length,
    econAssumptionCount: economicAssumptions.length,
    interviews: interviewFindings.length > 0,
    missingRecordSignals,
    sourceIds: {
      documents: documents.map((r) => r.id),
      chronologyEvents: chronologyEvents.map((r) => r.id),
      vocationalEntries: vocationalEntries.map((r) => r.id),
      economicAssumptions: economicAssumptions.map((r) => r.id),
      interviewFindings: interviewFindings.map((r) => r.id),
      missingRecordFindings: missingRecordFindings.map((r) => r.id),
    },
  };
  const rowIds: FdeRowIds = {
    conditionIds: conditions.map((c) => c.id),
    itemIds: items.map((i) => i.id),
    findingIds: findings.map((f) => f.id),
    sourceRecords: [
      ...documents.map((material) => ({ kind: "document", id: material.id, material })),
      ...chronologyEvents.map((material) => ({ kind: "chronology-event", id: material.id, material })),
      ...vocationalEntries.map((material) => ({ kind: "vocational-entry", id: material.id, material })),
      ...economicAssumptions.map((material) => ({ kind: "economic-assumption", id: material.id, material })),
      ...interviewFindings.map((material) => ({ kind: "interview-finding", id: material.id, material })),
    ],
  };
  return { input, rowIds };
}

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    const c = await requireCase(ctx, params.caseId);
    const evaluation = await prisma.futureDamagesEvaluation.findFirst({
      where: { caseId: params.caseId, firmId: ctx.firm.id },
      orderBy: { evaluatedAt: "desc" },
    });
    // Freshness is COMPUTED, not just the stored flag. Fingerprinted rows
    // compare the stored inputs hash against the case's CURRENT inputs — this
    // catches child-table changes (new care items, findings, …) that never
    // bump Case.updatedAt, and ignores cosmetic case edits that do. Legacy
    // rows without a hash fall back to the timestamp comparison.
    let isStale = false;
    if (evaluation) {
      if (evaluation.isStale) {
        isStale = true;
      } else if (evaluation.inputsHash) {
        const { input, rowIds } = await buildSnapshot(params.caseId);
        isStale = evaluation.inputsHash !== computeInputsHash(input, rowIds);
      } else {
        isStale = evaluation.evaluatedAt < c.updatedAt;
      }
    }
    // Resolve the evaluator's display name (id alone is useless in the UI).
    const evaluatedBy = evaluation
      ? await prisma.user.findFirst({
          where: { id: evaluation.evaluatedById, firmId: ctx.firm.id },
          select: { id: true, name: true },
        })
      : null;
    return ok({ evaluation, isStale, evaluatedByName: evaluatedBy?.name ?? null });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    // Evaluating writes a case-level opinion record: allowed for anyone who can
    // shape the plan (futurecare.edit) or produce reports (report.export) —
    // this covers planners, physicians, attorneys, and admins, but not intake.
    if (!can(ctx.user.role, "futurecare.edit") && !can(ctx.user.role, "report.export")) {
      throw new TenantError("Your role cannot run a damages evaluation.", "FORBIDDEN", 403);
    }
    await requireCase(ctx, params.caseId);

    const { input, rowIds } = await buildSnapshot(params.caseId);
    const result = evaluateFutureDamages(input);
    const inputsHash = computeInputsHash(input, rowIds);

    const data = {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        // caseRevision stays null: the Case model carries no revision counter
        // today. If one is ever added, populate it here.
        logicVersion: FDE_LOGIC_VERSION,
        evaluatedById: ctx.user.id,
        inputsHash,
        overallOutcome: result.overallOutcome,
        recommendedPrimaryProduct: result.recommendedPrimaryProduct,
        recommendedAdditionalProducts: result.recommendedAdditionalProducts,
        readinessState: result.readinessState,
        supportingFactors: result.supportingFactors as never,
        weakeningFactors: result.weakeningFactors as never,
        missingInformation: result.missingInformation as never,
        unresolvedValidationIssues: result.unresolvedValidationIssues,
        estimatedMedicalRange: (result.estimatedMedicalRange ?? undefined) as never,
        confidenceDimensions: result.confidenceDimensions as never,
        nextActions: result.nextActions,
        sourceFactIds: result.sourceFactIds,
        isStale: false,
      } satisfies Prisma.FutureDamagesEvaluationUncheckedCreateInput;

    // Supersede + create is one SERIALIZABLE transaction. A concurrent writer
    // cannot leave two evaluations marked current; serialization conflicts are
    // retried once with a fresh database snapshot.
    let row: FutureDamagesEvaluation | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        row = await prisma.$transaction(
          async (tx) => {
            await tx.futureDamagesEvaluation.updateMany({
              where: { caseId: params.caseId, firmId: ctx.firm.id, isStale: false },
              data: { isStale: true },
            });
            return tx.futureDamagesEvaluation.create({ data });
          },
          { isolationLevel: "Serializable" },
        );
        break;
      } catch (err) {
        const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : null;
        if ((code !== "P2034" && code !== "P2002") || attempt === 1) throw err;
      }
    }
    if (!row) throw new TenantError("The evaluation could not be persisted safely.", "FORBIDDEN", 409);

    await audit(ctx, "damages.evaluate", {
      type: "futureDamagesEvaluation",
      id: row.id,
      caseId: params.caseId,
      meta: { outcome: result.overallOutcome, logicVersion: FDE_LOGIC_VERSION },
    });
    // notify: evaluation.complete (wired by engagement agent)

    return ok({ evaluation: row, isStale: false });
  } catch (err) {
    return handleError(err);
  }
}
