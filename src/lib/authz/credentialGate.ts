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
// Two enforcement strengths (deliberate, to preserve existing workflows
// conservatively — see docs/26):
//
//   1. ATTESTATION-class writes — signing an Attestation row, a ReportApproval
//      of kind ATTESTATION, or marking vocational conclusions VERIFIED — are
//      ALWAYS gated strictly via `assertVerifiedCredential`, regardless of any
//      feature flag. A signature without the underlying professional
//      credential is a defensibility defect, so there is no soft path.
//
//   2. Plain expert review/authorship decisions (approve / modify / reject on
//      future-care items, report-level APPROVAL signatures, economic
//      assumption entry) go through `enforceReviewCredential`: the gate
//      BLOCKS when the firm has opted into strict authorization
//      (features["authorization.enterprise"] === true) or is a demo firm
//      (Firm.isDemo — demo personas are seeded with verified credentials);
//      otherwise it LOGS a structured "credential.gap" warning (console +
//      audit trail) instead of blocking, so pilot firms whose experts occupy
//      PHYSICIAN_REVIEWER seats without verified credential rows keep working
//      while the gap stays visible.
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
 * SOFT gate for plain expert review/authorship decisions. Enforces (403) when
 * the firm has opted into enterprise authorization or is a demo firm;
 * otherwise records a structured "credential.gap" warning (console + audit)
 * and lets the legacy workflow proceed. See the file header for the rationale.
 */
export async function enforceReviewCredential(
  ctx: TenantContext,
  category: CredentialCategory,
  info: { action: string; caseId?: string },
): Promise<void> {
  if (await hasVerifiedCredential(ctx, category)) return;

  const features = (ctx.firm as { features?: unknown }).features as Record<string, unknown> | null | undefined;
  const strict = (features != null && features["authorization.enterprise"] === true) || ctx.firm.isDemo === true;
  if (strict) {
    throw new TenantError(
      `A verified ${category} credential is required for this action. Ask a firm administrator to verify your credential.`,
      "FORBIDDEN",
      403,
    );
  }

  // Legacy firms: never block, always leave a trace — console for operators,
  // audit for the firm's own trail.
  console.warn(
    JSON.stringify({
      event: "credential.gap",
      userId: ctx.user.id,
      firmId: ctx.firm.id,
      requiredCredential: category,
      action: info.action,
      ...(info.caseId ? { caseId: info.caseId } : {}),
    }),
  );
  await audit(ctx, "credential.gap", {
    type: "credential",
    caseId: info.caseId,
    meta: { requiredCredential: category, action: info.action },
  }).catch(() => {
    /* the warning path must never break the workflow it declined to block */
  });
}
