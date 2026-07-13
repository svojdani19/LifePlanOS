import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { generatePlan } from "@/lib/engine/generate";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { ok, handleError } from "@/lib/api";

// Run the full AI pipeline: chronology → causation → future care → costs → reviews.
export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    await requireCase(ctx, params.caseId);

    const result = await generatePlan(params.caseId, { userId: ctx.user.id, role: ctx.user.role });
    // Persist the integrity findings for the fresh plan so the review workflow
    // can show them without building a report. Best-effort — never blocks.
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
    // Clinical Reasoning Engine — reason first: assess every recommendation of
    // the fresh plan so the structured assessment backs the narrative. Best-effort.
    await persistCaseReasoning(params.caseId, ctx.firm.id).catch(() => {});

    await prisma.case.update({ where: { id: params.caseId }, data: { status: "FUTURE_CARE" } });
    await recordUsage(ctx, "AI_GENERATION", { caseId: params.caseId, meta: { module: "plan" } });
    await audit(ctx, "plan.generate", { type: "case", id: params.caseId, caseId: params.caseId, meta: result });
    // P2.R1 §4 — explicit supersession audit when reviewed items were preserved.
    if (result.superseded > 0) {
      await audit(ctx, "recommendation.supersede", { type: "case", id: params.caseId, caseId: params.caseId, meta: { count: result.superseded, reason: "plan regeneration" } });
    }

    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
