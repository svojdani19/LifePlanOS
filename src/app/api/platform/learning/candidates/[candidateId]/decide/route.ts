import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, audit } from "@/lib/tenant";
import { requirePlatformAdminWrite } from "@/lib/authz/platform";
import { approveCandidate, rejectCandidate, CandidateStateError } from "@/lib/learning/candidateService";
import { parseApprovalClass } from "@/lib/learning/approvalClass";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Platform-operator decisions on EDITORIAL (STYLE) learned lessons.
//
// Why this route exists at all: learning.approve was moved onto the
// PLATFORM_SYSTEM_ADMINISTRATOR template and marked platformOnly, and
// authorize() denies every platformOnly key at step 1 — "no role, custom allow,
// or grant can rescue them". So routing STYLE approval through
// requireCanonicalPermission made it unreachable for everybody, including the
// operator it was moved to. The policy was right; the mechanism was the wrong
// one, because canonical permissions are the firm-user surface and this is not
// a firm-user act.
//
// Platform authority comes from the explicit DB grant instead, and the write
// variant refuses support mode so the read-only rule survives intact.
//
// The target firm is EXPLICIT. A platform operator legitimately acts across
// tenants, which is exactly why the candidate's own firmId is read first and
// carried into both the decision and the audit entry alongside the actor's —
// "who did it" and "whose data" are different questions here, and an audit row
// that answers only the first is not much of a record.
//
// CLINICAL lessons are refused here regardless of platform authority. No amount
// of operator privilege makes someone qualified to adopt a standing medical
// opinion; those go through the tenant route behind the physician credential.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
  note: z.string().optional(),
});

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ candidateId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requirePlatformAdminWrite(ctx);

    const input = schema.parse(await req.json());

    const candidate = await prisma.learningCandidate.findUnique({
      where: { id: params.candidateId },
      select: { id: true, firmId: true, approvalClass: true, mechanism: true, failureCode: true, status: true },
    });
    if (!candidate) return ok({ error: "Learning candidate not found" }, 404);

    const cls = parseApprovalClass(candidate.approvalClass);
    if (cls !== "STYLE") {
      return ok(
        {
          error:
            "This lesson changes what the program asserts about care. Platform authority does not extend to adopting a standing medical opinion — it needs a credentialed physician on the firm's own review surface.",
          code: "CLINICAL_NOT_PLATFORM_DECIDABLE",
        },
        409,
      );
    }

    // The candidate's OWN firm is the target. Passing the operator's context
    // firm would scope the decision to whichever tenant they happened to be
    // viewing.
    const actor = { userId: ctx.user.id, firmId: candidate.firmId, credentialLabel: null };
    const meta = {
      approvalClass: cls,
      mechanism: candidate.mechanism,
      failureCode: candidate.failureCode,
      platformOperator: true,
      actorFirmId: ctx.firm.id,
      targetFirmId: candidate.firmId,
    };

    const updated =
      input.action === "approve"
        ? await approveCandidate(candidate.id, actor, input.note, (tx) =>
            audit(ctx, "learning.approve", { type: "learning_candidate", id: candidate.id, meta }, tx as never),
          )
        : await rejectCandidate(candidate.id, actor, input.reason ?? "", (tx) =>
            audit(ctx, "learning.reject", { type: "learning_candidate", id: candidate.id, meta }, tx as never),
          );

    return ok({ candidate: updated });
  } catch (err) {
    if (err instanceof CandidateStateError) return ok({ error: err.message, code: "CANDIDATE_STATE" }, 409);
    return handleError(err);
  }
}
