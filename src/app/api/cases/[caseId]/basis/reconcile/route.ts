import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { enforceReviewCredential, verifiedCredentialLabel } from "@/lib/authz/credentialGate";
import { basisDivergences } from "@/lib/engine/validation";
import { validateReconciliation } from "@/lib/engine/basisReconciliation";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile a recorded-basis divergence.
//
// The ONLY way to close a BASIS_STALE / BASIS_MISSING finding other than
// regenerating the plan. It is deliberately not a status change: it records a
// clinical judgment that the current record is the one this recommendation
// should rest on, attributed to a physician who holds a verified credential,
// with the hash pair they reconciled and their reason.
//
// Gated exactly like a physician review decision, because that is what it is —
// an opinion about whether a recommendation still stands on the record as it
// now reads. A planner who can edit the plan cannot make that call.
//
// Fail-closed downstream: the export gate re-derives and compares, and honours
// a reconciliation only for the exact divergence it was recorded against. When
// the record moves again, that is a new fact and a new divergence.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  futureCareItemId: z.string().min(1),
  reason: z.string().min(1),
});

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "physician.review", { caseId: params.caseId });
    await enforceReviewCredential(ctx, "PHYSICIAN", { action: "basis.reconcile", caseId: params.caseId });
    await requireCase(ctx, params.caseId);

    const input = schema.parse(await req.json());

    // Reconcile only a divergence that actually exists right now. Recording one
    // against a recommendation that already agrees with its basis would leave a
    // standing approval waiting to absorb a future divergence.
    const diverged = (await basisDivergences(params.caseId)).find((d) => d.futureCareItemId === input.futureCareItemId);
    if (!diverged) {
      return ok({ error: "This recommendation does not currently diverge from its recorded basis.", code: "NO_DIVERGENCE" }, 409);
    }

    const credentialLabel = (await verifiedCredentialLabel(ctx, "PHYSICIAN")) ?? "verified physician credential on file";
    const problem = validateReconciliation({
      caseId: params.caseId,
      firmId: ctx.firm.id,
      futureCareItemId: input.futureCareItemId,
      recordedHash: diverged.recordedHash,
      derivedHash: diverged.derivedHash,
      actorUserId: ctx.user.id,
      credentialLabel,
      reason: input.reason,
    });
    if (problem) return ok({ error: problem, code: "INCOMPLETE_RECONCILIATION" }, 422);

    // The reconciliation and its audit entry commit together: a reconciliation
    // with no trail is exactly the unattributable override this replaces.
    const created = await prisma.$transaction(async (tx) =>
      tx.basisReconciliation.create({
        data: {
          caseId: params.caseId,
          firmId: ctx.firm.id,
          futureCareItemId: input.futureCareItemId,
          recordedHash: diverged.recordedHash,
          derivedHash: diverged.derivedHash,
          reconciledById: ctx.user.id,
          credentialLabel,
          reason: input.reason.trim().slice(0, 2000),
        },
      }),
    );

    await audit(ctx, "basis.reconcile", {
      type: "futureCareItem",
      id: input.futureCareItemId,
      caseId: params.caseId,
      meta: {
        state: diverged.state,
        recordedHash: diverged.recordedHash,
        derivedHash: diverged.derivedHash,
        credential: credentialLabel,
      },
    });

    return ok({ reconciliation: created });
  } catch (err) {
    return handleError(err);
  }
}
