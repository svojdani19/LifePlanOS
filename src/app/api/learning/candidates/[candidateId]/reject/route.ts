import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, audit } from "@/lib/tenant";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import { rejectCandidate } from "@/lib/learning/candidateService";
import { requiredApprovalCredential, requiredApprovalPermission, type ApprovalClass } from "@/lib/learning/approvalClass";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Refuse a learned lesson.
//
// Gated identically to approval, and on purpose. Refusing a clinical lesson is
// as much a clinical judgment as accepting one — if only approval were gated,
// an administrator could quietly reject every clinical lesson a physician would
// have adopted, and shape the firm's learning by subtraction.
//
// A rejection is a decision, not a deletion. The candidate keeps its evaluation
// and gains a reviewer and a reason, so what the firm declined to learn stays
// on the record beside what it accepted.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ candidateId: string }> };

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();

    const candidate = await prisma.learningCandidate.findFirst({
      where: { id: params.candidateId, firmId: ctx.firm.id },
      select: { id: true, approvalClass: true, mechanism: true, failureCode: true },
    });
    // 404 before any permission branch would leak nothing useful either way —
    // the row is already firm-scoped, so a miss means it is not this tenant's.
    if (!candidate) return ok({ error: "Learning candidate not found" }, 404);

    const cls = (candidate.approvalClass as ApprovalClass) ?? "CLINICAL";
    requireCanonicalPermission(ctx, requiredApprovalPermission(cls));

    const needed = requiredApprovalCredential(cls);
    if (needed) await enforceReviewCredential(ctx, needed, { action: "learning.reject_clinical" });

    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (!reason.trim()) return ok({ error: "A rejection must record a reason" }, 422);

    const updated = await rejectCandidate(candidate.id, { userId: ctx.user.id, firmId: ctx.firm.id }, reason);

    await audit(ctx, "learning.reject", {
      type: "learning_candidate",
      id: candidate.id,
      meta: { approvalClass: cls, mechanism: candidate.mechanism, failureCode: candidate.failureCode },
    });
    return ok({ candidate: updated });
  } catch (err) {
    return handleError(err);
  }
}
