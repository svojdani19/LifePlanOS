import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { PipelineBusyError, PipelineLeaseLostError, PipelineRerunOverflowError } from "@/lib/engine/pipelineLock";
import { runCasePipeline } from "@/lib/engine/runPipeline";
import { ok, handleError } from "@/lib/api";

// Run the full AI pipeline: chronology → causation → future care → costs → reviews.
//
// Generation and its three finalizers used to be four separate awaits here,
// with the lock covering only the first. That put validation, reasoning and
// attestation refresh outside the lease — reading a plan another caller was
// free to rewrite — and, because the coalescing loop lives inside the lock,
// left the FINAL generation pass with no finalizers after it at all. They now
// travel together as one unit of work; see engine/runPipeline.ts.
export async function POST(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    await requireCase(ctx, params.caseId);

    let result;
    try {
      result = await runCasePipeline(params.caseId, ctx.firm.id, { userId: ctx.user.id, role: ctx.user.role });
    } catch (err) {
      // A run was already in flight — started by this user, or in the
      // background by records review. Running a second one concurrently is
      // what duplicated every condition and care item, so this request does
      // not run. The holder owes one more complete pass, so the plan still
      // ends up reflecting everything that had been asked for.
      if (err instanceof PipelineBusyError) {
        return ok({ error: "This plan is already being regenerated. The run in progress will pick up your changes — reload in a moment." }, 409);
      }
      // The lease was taken mid-run, so this run stopped rather than race the
      // one that took it. Same answer to the caller: nothing of yours is lost,
      // look again in a moment.
      if (err instanceof PipelineLeaseLostError) {
        return ok({ error: "This plan was picked up by another regeneration while yours was running. Reload to see the current plan." }, 409);
      }
      // The case kept being marked out of date across every allowed pass. The
      // obligation is still recorded, so nothing is lost — but this is a fault,
      // not contention, and it must be visible rather than retried silently.
      if (err instanceof PipelineRerunOverflowError) {
        await audit(ctx, "plan.rerun_overflow", {
          type: "case",
          id: params.caseId,
          caseId: params.caseId,
          meta: { passes: err.passes },
        });
        return ok({ error: "This plan was regenerated repeatedly and the case is still being marked out of date. The pending regeneration is still recorded; please report this case." }, 500);
      }
      throw err;
    }

    await prisma.case.update({ where: { id: params.caseId }, data: { status: "FUTURE_CARE" } });
    await recordUsage(ctx, "AI_GENERATION", { caseId: params.caseId, meta: { module: "plan" } });
    await audit(ctx, "plan.generate", { type: "case", id: params.caseId, caseId: params.caseId, meta: result });
    // A finalizer that failed is best-effort by contract, but never silent:
    // the audit trail records which stage, so a plan whose findings are stale
    // can be recognised as such rather than assumed fresh.
    if (result.finalizerErrors.length > 0) {
      await audit(ctx, "plan.finalizer_failed", {
        type: "case",
        id: params.caseId,
        caseId: params.caseId,
        meta: { stages: result.finalizerErrors.map((e) => e.stage) },
      });
    }
    // P2.R1 §4 — explicit supersession audit when reviewed items were preserved.
    if (result.superseded > 0) {
      await audit(ctx, "recommendation.supersede", { type: "case", id: params.caseId, caseId: params.caseId, meta: { count: result.superseded, reason: "plan regeneration" } });
    }

    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
