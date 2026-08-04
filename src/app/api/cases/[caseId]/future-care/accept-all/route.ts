import { prisma } from "@/lib/db";
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
      select: { id: true, lineageId: true, lifecycleStatus: true },
    });
    // Each approval is conditional on the exact item version the confirmation
    // covered: an item that was decided, changed, or superseded between the
    // snapshot and the write is REFUSED (skipped), never silently approved —
    // and the ledger records only decisions that actually took effect.
    const approved: typeof pending = [];
    for (const p of pending) {
      const res = await prisma.futureCareItem.updateMany({
        where: { id: p.id, physicianStatus: "PENDING", supersededAt: null },
        data: { physicianStatus: "APPROVED" },
      });
      if (res.count === 1) approved.push(p);
    }
    if (approved.length > 0) {
      await prisma.recommendationTransition.createMany({
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

    // Reviews reference physician status, so refresh them once after the batch.
    await generateReviews(params.caseId);
    await audit(ctx, "physician.review", { type: "case", id: params.caseId, caseId: params.caseId, meta: { action: "accept-all", count: approved.length, refusedStale: pending.length - approved.length } });
    return ok({ count: approved.length });
  } catch (err) {
    return handleError(err);
  }
}
