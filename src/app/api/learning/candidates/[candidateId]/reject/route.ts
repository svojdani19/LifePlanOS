import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, audit } from "@/lib/tenant";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import { rejectCandidate, CandidateStateError } from "@/lib/learning/candidateService";
import { parseApprovalClass, requiredApprovalCredential, requiredApprovalPermission } from "@/lib/learning/approvalClass";
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

    // PARSED, not cast. A cast is a claim about a database string, and the
    // column can hold an empty value from a partial write, a legacy label, or
    // a class added after this build shipped — each of which is a valid
    // TypeScript ApprovalClass and none of which equals "CLINICAL", so the
    // comparison that picks the gate would have picked the weaker one.
    const cls = parseApprovalClass(candidate.approvalClass);

    // EDITORIAL lessons are not decided on the tenant surface. learning.approve
    // is platformOnly, and authorize() denies platformOnly keys at step 1 for
    // every firm user — so requiring it here could only ever produce a 403 that
    // reads like a misconfiguration. Say what is actually true instead, and
    // point at the surface that can act.
    if (cls === "STYLE") {
      return ok(
        {
          error:
            "Adopting an editorial lesson is a standing change to how every future case is processed, and rests with the platform operator rather than with firm administration.",
          code: "STYLE_NOT_TENANT_DECIDABLE",
        },
        409,
      );
    }
    requireCanonicalPermission(ctx, requiredApprovalPermission(cls));

    const needed = requiredApprovalCredential(cls);
    if (needed) await enforceReviewCredential(ctx, needed, { action: "learning.reject_clinical" });

    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (!reason.trim()) return ok({ error: "A rejection must record a reason" }, 422);

    const updated = await rejectCandidate(
      candidate.id,
      { userId: ctx.user.id, firmId: ctx.firm.id },
      reason,
      (tx, c) =>
        audit(ctx, "learning.reject", {
          type: "learning_candidate",
          id: c.id,
          meta: { approvalClass: cls, mechanism: c.mechanism, failureCode: c.failureCode },
        }, tx as never),
    );
    return ok({ candidate: updated });
  } catch (err) {
    if (err instanceof CandidateStateError) return ok({ error: err.message, code: "CANDIDATE_STATE" }, 409);
    return handleError(err);
  }
}
