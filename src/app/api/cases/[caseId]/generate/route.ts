import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { generatePlan } from "@/lib/engine/generate";
import { PipelineBusyError } from "@/lib/engine/pipelineLock";
import { persistCaseValidation } from "@/lib/engine/validation";
import { refreshCaseAttestations } from "@/lib/engine/attestationService";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { ok, handleError } from "@/lib/api";

// Run the full AI pipeline: chronology → causation → future care → costs → reviews.
export async function POST(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    await requireCase(ctx, params.caseId);

    let result;
    try {
      result = await generatePlan(params.caseId, { userId: ctx.user.id, role: ctx.user.role });
    } catch (err) {
      // A run was already in flight — started by this user, or in the
      // background by records review. Running a second one concurrently is
      // what duplicated every condition and care item, so this request does
      // not run. The holder owes one more pass, so the plan still ends up
      // reflecting everything that had been asked for.
      if (err instanceof PipelineBusyError) {
        return ok({ error: "This plan is already being regenerated. The run in progress will pick up your changes — reload in a moment." }, 409);
      }
      throw err;
    }
    // Persist the integrity findings for the fresh plan so the review workflow
    // can show them without building a report. Best-effort — never blocks.
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
    // Clinical Reasoning Engine — reason first: assess every recommendation of
    // the fresh plan so the structured assessment backs the narrative. Best-effort.
    await persistCaseReasoning(params.caseId, ctx.firm.id).catch(() => {});
    // Regeneration can materially change signed-over recommendations —
    // re-verify active attestations (EPIC-005).
    await refreshCaseAttestations(params.caseId).catch(() => {});

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
