import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { ok, handleError } from "@/lib/api";

// Clinical Reasoning Engine — the structured, per-recommendation assessment that
// determines whether each future-care recommendation is medically supportable
// before any narrative is written. GET returns the stored assessments; POST
// (re)computes and persists them (reason first, write second).

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const assessments = await prisma.clinicalReasoningAssessment.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id, status: { not: "SUPERSEDED" } },
      orderBy: { createdAt: "asc" },
    });
    return ok({ assessments });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    // Incremental reassessment (§19): { recommendationId } reassesses one line;
    // no body reassesses the whole case. Idempotent either way.
    const body = await req.json().catch(() => ({}));
    const recommendationId = typeof body?.recommendationId === "string" ? body.recommendationId : undefined;
    const assessments = await persistCaseReasoning(params.caseId, ctx.firm.id, {
      recommendationIds: recommendationId ? [recommendationId] : undefined,
      actorUserId: ctx.user.id,
    });
    await audit(ctx, "reasoning.run", { type: "case", id: params.caseId, caseId: params.caseId, meta: { assessments: assessments.length, incremental: !!recommendationId } });
    return ok({ assessments });
  } catch (err) {
    return handleError(err);
  }
}
