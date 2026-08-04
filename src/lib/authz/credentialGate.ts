import { prisma } from "@/lib/db";
import { TenantError, audit, type TenantContext } from "@/lib/tenant";
import type { CredentialCategory } from "./registry";

// ─────────────────────────────────────────────────────────────────────────────
// Professional-credential gate — server-side enforcement, independent of UI.
//
// Role/permission checks (requirePermission) answer "may this seat act?";
// this module answers the orthogonal question "does this PERSON hold the
// verified professional credential the act requires?". A vocational expert,
// economist, QA reviewer, or admin occupying a PHYSICIAN_REVIEWER seat must
// never be able to sign a physician attestation — and vice versa.
//
// A credential qualifies only when ALL of:
//   • category matches the required CredentialCategory exactly, AND
//   • status is ORG_VERIFIED or EXTERNALLY_VERIFIED, AND
//   • expiresAt is null or in the future.
// Legacy rows (status SELF_REPORTED, category null) NEVER qualify, nor do
// PENDING / EXPIRED / SUSPENDED rows.
//
// Both attestation-class writes and professional review/authorship decisions
// fail closed. Tenant plan, demo state, rollout flags, and legacy enum roles can
// never substitute for the matching verified professional credential.
// ─────────────────────────────────────────────────────────────────────────────

const VERIFIED_STATUSES = new Set(["ORG_VERIFIED", "EXTERNALLY_VERIFIED"]);

type ActorRef = { userId: string; firmId: string };
type Actor = TenantContext | ActorRef;

function actorIds(actor: Actor): ActorRef {
  if ("user" in actor && "firm" in actor) return { userId: actor.user.id, firmId: actor.firm.id };
  return actor as ActorRef;
}

/** Report-definition expert role → the credential category that must sign it. */
export function credentialCategoryForExpert(expertRole: string): CredentialCategory | null {
  switch (expertRole) {
    case "physician":
      return "PHYSICIAN";
    case "vocational":
      return "VOCATIONAL";
    case "economist":
      return "ECONOMIST";
    default:
      return null;
  }
}

/** Does the actor hold a verified, unexpired credential of `category`?
 *  Loads fresh rows — never trusts a cached/staged context. */
export async function hasVerifiedCredential(actor: Actor, category: CredentialCategory): Promise<boolean> {
  const { userId, firmId } = actorIds(actor);
  const rows = await prisma.userCredential.findMany({
    where: { userId, firmId },
    select: { category: true, status: true, expiresAt: true },
  });
  const now = Date.now();
  return rows.some(
    (r) => r.category === category && VERIFIED_STATUSES.has(r.status) && (!r.expiresAt || r.expiresAt.getTime() > now),
  );
}

/**
 * The label of the actor's qualifying verified, unexpired credential of
 * `category`, for snapshotting onto the record of a professional act
 * (e.g. a vocational verification). Null when none qualifies — callers
 * gate first with assertVerifiedCredential; this is attribution, not authz.
 */
export async function verifiedCredentialLabel(actor: Actor, category: CredentialCategory): Promise<string | null> {
  const { userId, firmId } = actorIds(actor);
  const rows = await prisma.userCredential.findMany({
    where: { userId, firmId },
    select: { category: true, status: true, expiresAt: true, label: true },
  });
  const now = Date.now();
  const match = rows.find(
    (r) => r.category === category && VERIFIED_STATUSES.has(r.status) && (!r.expiresAt || r.expiresAt.getTime() > now),
  );
  return (match as { label?: string | null } | undefined)?.label ?? (match ? "verified credential on file" : null);
}

/**
 * STRICT gate for attestation-class writes. Throws the standard API authz
 * error (403 FORBIDDEN) unless the actor holds a matching verified,
 * unexpired credential. Always enforced — no feature flag can soften it.
 */
export async function assertVerifiedCredential(actor: Actor, category: CredentialCategory): Promise<void> {
  if (await hasVerifiedCredential(actor, category)) return;
  throw new TenantError(
    `A verified ${category} credential is required to sign or attest this item. Ask a firm administrator to verify your credential.`,
    "FORBIDDEN",
    403,
  );
}

/**
 * Fail-closed gate for expert review/authorship decisions. Professional
 * opinions cannot become less protected because a tenant has not enabled an
 * enterprise feature flag. A gap is audited and the action is always refused.
 */
export async function enforceReviewCredential(
  ctx: TenantContext,
  category: CredentialCategory,
  info: { action: string; caseId?: string },
): Promise<void> {
  if (await hasVerifiedCredential(ctx, category)) return;
  await audit(ctx, "credential.gap", {
    type: "credential",
    caseId: info.caseId,
    meta: { requiredCredential: category, action: info.action },
  }).catch(() => {
    /* authorization denial must not depend on audit availability */
  });
  throw new TenantError(
    `A verified ${category} credential is required for this action. Ask a firm administrator to verify your credential.`,
    "FORBIDDEN",
    403,
  );
}
