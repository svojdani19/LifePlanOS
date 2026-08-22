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
// ── The permission, stated as it actually is ────────────────────────────────
// This claimed to require "the same grant the review routes require" and then
// checked futurecare.edit with no credential gate, while the review routes
// require physician.review AND a verified PHYSICIAN credential. The comment
// described a stronger gate than the code enforced, which is worse than a weak
// gate: a reader auditing the policy would have signed off on the wrong thing.
//
// futurecare.edit is the correct requirement, and the reason is that this
// endpoint records no clinical judgment. It recomputes reviews, validation,
// reasoning and attestations from state that already exists; the physician's
// decision was made, recorded transactionally, and is not revisited here.
// Requiring a physician credential to press retry would leave a planner unable
// to repair derived artifacts after a transient failure, while adding no
// safety — there is no decision for a credential to authorise.
//
// The audit action is its own (`futurecare.refresh_retry`), not
// `physician.review`. Filing a recompute under the review action would put
// entries in the clinical-review trail for something no clinician did.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ caseId: string }> };

export async function POST(_req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "futurecare.edit", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);

    const refresh = await refreshAfterReview(
      { generateReviews, persistCaseValidation, persistCaseReasoning, refreshCaseAttestations },
      params.caseId,
      ctx.firm.id,
    );
    await recordRefreshObligation(prisma as never, params.caseId, ctx.firm.id, refresh.failed);
    await audit(ctx, "futurecare.refresh_retry", {
      type: "case",
      id: params.caseId,
      caseId: params.caseId,
      meta: { refreshFailed: refresh.failed },
    });
    return ok({
      refresh: refresh.failed.length ? { status: "ATTENTION_REQUIRED", failed: refresh.failed } : { status: "COMPLETE" },
    });
  } catch (err) {
    return handleError(err);
  }
}
