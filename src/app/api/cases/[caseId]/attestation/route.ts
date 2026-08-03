import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { assertVerifiedCredential } from "@/lib/authz/credentialGate";
import { signAttestation, refreshCaseAttestations } from "@/lib/engine/attestationService";
import { verifyAttestation, type AttestationScopeEntry, type AttestableItem } from "@/lib/engine/attestation";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Electronic attestation (EPIC-005).
//   GET  — the case's attestations, each with a LIVE verification against the
//          current plan (an ACTIVE row that has drifted is invalidated on read).
//   POST — sign. physician.review only; the signer must confirm explicitly.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    requireCanonicalPermission(ctx, "attestation.view", { caseId: params.caseId });
    // Invalidate drifted signatures before reporting state, so the UI can
    // never show a stale "attested" badge.
    await refreshCaseAttestations(params.caseId);
    const [attestations, items] = await Promise.all([
      prisma.attestation.findMany({ where: { caseId: params.caseId }, orderBy: { signedAt: "desc" } }),
      prisma.futureCareItem.findMany({ where: { caseId: params.caseId, supersededAt: null } }),
    ]);
    return ok({
      attestations: attestations.map((a) => ({
        ...a,
        verification:
          a.status === "ACTIVE"
            ? verifyAttestation((a.scope as unknown as AttestationScopeEntry[]) ?? [], items as unknown as AttestableItem[])
            : null,
      })),
    });
  } catch (err) {
    return handleError(err);
  }
}

const postSchema = z.object({
  // The signing ceremony requires an explicit confirmation flag from the UI —
  // an attestation must never be a side effect.
  confirm: z.literal(true),
  note: z.string().max(1000).optional(),
});

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "physician.review", { caseId: params.caseId });
    // Attestation-class write: the signer must PERSONALLY hold a verified
    // physician credential — a seat/role alone never suffices (docs/26).
    await assertVerifiedCredential(ctx, "PHYSICIAN");
    await requireCase(ctx, params.caseId);
    const input = postSchema.parse(await req.json());

    const result = await signAttestation({
      caseId: params.caseId,
      firmId: ctx.firm.id,
      physician: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role },
      note: input.note ?? null,
    });
    await audit(ctx, "attestation.sign", {
      type: "attestation",
      id: result.attestation.id,
      caseId: params.caseId,
      meta: { itemCount: result.attestation.itemCount, totalPresentValue: result.attestation.totalPresentValue, contentHash: result.attestation.contentHash, superseded: result.superseded },
    });
    return ok({ attestation: result.attestation, superseded: result.superseded });
  } catch (err) {
    return handleError(err);
  }
}
