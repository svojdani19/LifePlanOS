import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { generateReviews } from "@/lib/engine/generate";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { refreshCaseAttestations } from "@/lib/engine/attestationService";
import { refreshAfterReview, recordRefreshObligation } from "@/lib/engine/reviewDecision";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Retry the post-review refresh.
//
// A review decision obliges four refreshes — reviews, validation, reasoning,
// attestations. When one fails the decision still stands (it is recorded
// transactionally), but the plan's own statements can be describing the case as
// it was before. That obligation is persisted as an export-blocking finding;
// this is how it gets discharged.
//
// IDEMPOTENT by construction: every stage is a recompute-from-current-state,
// and `recordRefreshObligation` replaces the prior obligation rather than
// adding to it. Running this on a healthy case is a no-op that clears nothing
// because there is nothing to clear.
//
// No new workflow: same route shape, same permission, same audit action as the
// review routes it repairs after.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ caseId: string }> };

export async function POST(_req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    // The same grant the review routes require: retrying a refresh is part of
    // the review act, not a separate privilege.
    requireCanonicalPermission(ctx, "futurecare.edit", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);

    const refresh = await refreshAfterReview(
      { generateReviews, persistCaseValidation, persistCaseReasoning, refreshCaseAttestations },
      params.caseId,
      ctx.firm.id,
    );
    await recordRefreshObligation(prisma as never, params.caseId, ctx.firm.id, refresh.failed);
    await audit(ctx, "physician.review", {
      type: "case",
      id: params.caseId,
      caseId: params.caseId,
      meta: { action: "refresh-retry", refreshFailed: refresh.failed },
    });
    return ok({
      refresh: refresh.failed.length ? { status: "ATTENTION_REQUIRED", failed: refresh.failed } : { status: "COMPLETE" },
    });
  } catch (err) {
    return handleError(err);
  }
}
