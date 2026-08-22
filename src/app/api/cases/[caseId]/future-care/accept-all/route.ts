import { prisma } from "@/lib/db";
import { reviewDecisionFields, refreshAfterReview, recordRefreshObligation } from "@/lib/engine/reviewDecision";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { refreshCaseAttestations } from "@/lib/engine/attestationService";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import { generateReviews } from "@/lib/engine/generate";
import { lifecycleFor } from "@/lib/engine/lifecycle";
import { ok, handleError } from "@/lib/api";

// Bulk physician sign-off (Module 12): approve every still-pending future-care
// item in a single action. Explicit prior decisions (MODIFIED / REJECTED) are
// left untouched so a reviewer's rejections are not silently reversed.
export async function POST(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "physician.review", { caseId: params.caseId });
    // Bulk review decision: same credential boundary as a single decision —
    // enforced for enterprise/demo firms, logged as credential.gap otherwise.
    await enforceReviewCredential(ctx, "PHYSICIAN", { action: "futurecare.accept_all", caseId: params.caseId });
    await requireCase(ctx, params.caseId);

    // Snapshot the pending set first so the batch writes a per-item ledger
    // row — bulk approval must be as auditable as an individual decision.
    const pending = await prisma.futureCareItem.findMany({
      where: { caseId: params.caseId, physicianStatus: "PENDING", supersededAt: null },
      // `origin` is needed to classify: an approved RECORD_RECOMMENDED item and
      // an approved template are both adopted, and the classifier says so from
      // one place rather than each route guessing.
      select: { id: true, lineageId: true, lifecycleStatus: true, origin: true, supportClass: true },
    });
    // Each approval is conditional on the exact item version the confirmation
    // covered: an item that was decided, changed, or superseded between the
    // snapshot and the write is REFUSED (skipped), never silently approved —
    // and the ledger records only decisions that actually took effect.
    // DECISION AND LEDGER IN ONE TRANSACTION. These were separate writes, so a
    // failure between them could leave an approval standing with no audit entry
    // — the one record a law firm cannot afford to be missing.
    //
    // Each approval stays conditional on the exact item version the
    // confirmation covered: an item decided, changed or superseded since the
    // snapshot is refused inside the transaction, and only decisions that
    // actually took effect are ledgered.
    const approved: typeof pending = [];
    await prisma.$transaction(async (tx) => {
      for (const p of pending) {
        const res = await tx.futureCareItem.updateMany({
          where: { id: p.id, physicianStatus: "PENDING", supersededAt: null },
          // The same fields an individual approval writes.
          data: reviewDecisionFields(p as never, "APPROVED", "PHYSICIAN_APPROVED") as never,
        });
        if (res.count === 1) approved.push(p);
      }
      if (approved.length > 0) {
        await tx.recommendationTransition.createMany({
          data: approved.map((p) => ({
            caseId: params.caseId,
            firmId: ctx.firm.id,
            lineageId: p.lineageId,
            itemId: p.id,
            userId: ctx.user.id,
            role: ctx.user.role,
            priorStatus: p.lifecycleStatus,
            newStatus: lifecycleFor("APPROVED"),
            comment: "Bulk approval (accept-all)",
            reasonCode: "ACCEPT_ALL",
          })),
        });
      }
    });

    // THE SAME refreshes an individual approval triggers. This ran
    // `generateReviews` alone, so approving forty items at once left the
    // reasoning, the validation findings and the signatures describing a plan
    // that no longer existed — while approving the same forty one at a time did
    // not. The safeguards a decision triggers cannot depend on which button
    // produced it.
    const refresh = await refreshAfterReview(
      { generateReviews, persistCaseValidation, persistCaseReasoning, refreshCaseAttestations },
      params.caseId,
      ctx.firm.id,
      { recommendationIds: approved.map((p) => p.id), actorUserId: ctx.user.id },
    );
    // Durable and export-blocking, not a console line. Reporting an
    // unconditional success for a case whose validation, reasoning or
    // signatures did not refresh is the same defect as never running them.
    await recordRefreshObligation(prisma as never, params.caseId, ctx.firm.id, refresh.failed);
    await audit(ctx, "physician.review", { type: "case", id: params.caseId, caseId: params.caseId, meta: { action: "accept-all", count: approved.length, refusedStale: pending.length - approved.length, refreshFailed: refresh.failed } });
    return ok({
      count: approved.length,
      refresh: refresh.failed.length ? { status: "ATTENTION_REQUIRED", failed: refresh.failed } : { status: "COMPLETE" },
    });
  } catch (err) {
    return handleError(err);
  }
}
