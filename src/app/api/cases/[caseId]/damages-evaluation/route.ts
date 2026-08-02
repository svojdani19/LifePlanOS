import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, TenantError } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { ok, handleError } from "@/lib/api";
import { evaluateFutureDamages, FDE_LOGIC_VERSION, type FdeInput } from "@/lib/engine/damagesEvaluation";

// Future Damages Evaluation (MDIP — docs/28). GET returns the latest persisted
// evaluation with a computed freshness flag; POST snapshots the case's REAL
// structured data, runs the pure fde-1 engine, persists the result, and marks
// every prior row stale. The engine is deterministic and never invents facts —
// this route only assembles the snapshot and stores the verdict.

/** Assemble the engine input from persisted case data only. */
async function buildSnapshot(caseId: string): Promise<FdeInput> {
  const [conditions, items, findings, documentsCount, chronologyCount, vocationalEntryCount, econAssumptionCount, interviewCount] =
    await Promise.all([
      prisma.condition.findMany({
        where: { caseId },
        select: { name: true, relatedness: true, evidenceSources: true },
      }),
      prisma.futureCareItem.findMany({
        where: { caseId, supersededAt: null },
        select: {
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
        where: { caseId },
        select: { result: true, issue: true, severity: true, exportBlocking: true },
      }),
      prisma.document.count({ where: { caseId } }),
      prisma.chronologyEvent.count({ where: { caseId } }),
      prisma.vocationalEntry.count({ where: { caseId, supersededById: null } }),
      prisma.economicAssumption.count({ where: { caseId, supersededById: null } }),
      prisma.interviewFinding.count({ where: { caseId } }),
    ]);

  // Missing-record signals: persisted finding texts that mention missing
  // records — derived, never invented (the engine treats them verbatim).
  const missingRecordSignals = findings
    .filter((f) => /missing/i.test(`${f.result} ${f.issue}`) && /record|document|report|page/i.test(`${f.result} ${f.issue}`))
    .map((f) => f.issue);

  return {
    conditions: conditions.map((c) => ({
      name: c.name,
      relatedness: c.relatedness,
      evidenceSourceCount: Array.isArray(c.evidenceSources) ? c.evidenceSources.length : 0,
    })),
    items: items.map((i) => ({
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
    findings: findings.map((f) => ({ result: f.result, severity: f.severity, exportBlocking: f.exportBlocking })),
    documentsCount,
    chronologyCount,
    vocationalEntryCount,
    econAssumptionCount,
    interviews: interviewCount > 0,
    missingRecordSignals,
  };
}

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    const c = await requireCase(ctx, params.caseId);
    const evaluation = await prisma.futureDamagesEvaluation.findFirst({
      where: { caseId: params.caseId, firmId: ctx.firm.id },
      orderBy: { evaluatedAt: "desc" },
    });
    // Freshness is COMPUTED against the case, not just the stored flag: any
    // case edit after the evaluation makes the stored verdict stale.
    const isStale = evaluation ? evaluation.isStale || evaluation.evaluatedAt < c.updatedAt : false;
    return ok({ evaluation, isStale });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
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

    const snapshot = await buildSnapshot(params.caseId);
    const result = evaluateFutureDamages(snapshot);

    const row = await prisma.futureDamagesEvaluation.create({
      data: {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        logicVersion: FDE_LOGIC_VERSION,
        evaluatedById: ctx.user.id,
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
      },
    });
    // Every earlier evaluation is superseded by this one.
    await prisma.futureDamagesEvaluation.updateMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id, id: { not: row.id } },
      data: { isStale: true },
    });

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
