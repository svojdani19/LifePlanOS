import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, audit } from "@/lib/tenant";
import { enforceReviewCredential, verifiedCredentialLabel } from "@/lib/authz/credentialGate";
import { approveCandidate, CandidateStateError } from "@/lib/learning/candidateService";
import { parseApprovalClass, requiredApprovalCredential, requiredApprovalPermission } from "@/lib/learning/approvalClass";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Adopt a learned lesson.
//
// The authorization is chosen by the candidate's OWN recorded class, read from
// the row before anything else happens. Two consequences worth stating:
//
//   • The caller cannot select their own gate. There is no class in the request
//     body; passing one would let an administrator declare a clinical lesson
//     editorial and approve it themselves.
//   • The class was frozen at promotion, so a later mechanism edit cannot move
//     a pending approval into the weaker gate.
//
// A CLINICAL lesson additionally requires a verified PHYSICIAN credential —
// the same fail-closed gate that guards attestation, not a parallel one. A
// physician seat without a verified credential is refused and the gap audited.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ candidateId: string }> };

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();

    const candidate = await prisma.learningCandidate.findFirst({
      where: { id: params.candidateId, firmId: ctx.firm.id },
      select: { id: true, approvalClass: true, mechanism: true, failureCode: true, status: true },
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
    requireCanonicalPermission(ctx, requiredApprovalPermission(cls));

    const needed = requiredApprovalCredential(cls);
    let credentialLabel: string | null = null;
    if (needed) {
      await enforceReviewCredential(ctx, needed, { action: "learning.approve_clinical" });
      credentialLabel = await verifiedCredentialLabel(ctx, needed);
    }

    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const note = typeof body.note === "string" ? body.note.slice(0, 1000) : undefined;

    // The adoption, the finding state and the audit entry commit together.
    // An adoption with no audit entry is unattributable, and an audit entry
    // with no adoption describes something that never happened.
    const updated = await approveCandidate(
      candidate.id,
      { userId: ctx.user.id, firmId: ctx.firm.id, credentialLabel },
      note,
      (tx, c) =>
        audit(ctx, "learning.approve", {
          type: "learning_candidate",
          id: c.id,
          meta: { approvalClass: cls, mechanism: c.mechanism, failureCode: c.failureCode, credential: credentialLabel },
        }, tx as never),
    );
    return ok({ candidate: updated });
  } catch (err) {
    if (err instanceof CandidateStateError) return ok({ error: err.message, code: "CANDIDATE_STATE" }, 409);
    return handleError(err);
  }
}
