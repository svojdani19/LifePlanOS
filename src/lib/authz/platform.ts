import { prisma } from "@/lib/db";
import { TenantError, type TenantContext } from "@/lib/tenant";

// ─────────────────────────────────────────────────────────────────────────────
// Platform authorization (MDIP hardening). Platform-operator authority comes
// EXCLUSIVELY from an explicit, auditable DB grant: an ACTIVE, unexpired
// UserRoleAssignment with the built-in PLATFORM_SYSTEM_ADMINISTRATOR template.
// No email lists, no env allowlists, no hardcoded identities — revoking the
// assignment revokes the authority immediately.
// ─────────────────────────────────────────────────────────────────────────────

export const PLATFORM_ADMIN_TEMPLATE = "PLATFORM_SYSTEM_ADMINISTRATOR";

/**
 * Cookie carrying the Super Admin "View as" workspace key. Presentation only:
 * it never alters permissions, credentials, or audit actor identity — target
 * pages' own guards still decide access.
 */
export const VIEW_AS_COOKIE = "viewAsWorkspace";

/**
 * True iff the user holds an ACTIVE, unexpired PLATFORM_SYSTEM_ADMINISTRATOR
 * assignment (any firm; effectiveUntil null or in the future). This is the
 * ONLY source of platform-administrator authority.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const count = await prisma.userRoleAssignment.count({
    where: {
      userId,
      builtInRole: PLATFORM_ADMIN_TEMPLATE,
      status: "ACTIVE",
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: new Date() } }],
    },
  });
  return count > 0;
}

/**
 * Guard variant for API routes and server actions: throws a 403 TenantError
 * (handled uniformly by handleError) when the caller is not a platform admin.
 * Pages that prefer a redirect should call isPlatformAdmin directly.
 */
export async function requirePlatformAdmin(ctx: TenantContext): Promise<void> {
  if (!(await isPlatformAdmin(ctx.user.id))) {
    throw new TenantError("Platform administrator authorization required.", "FORBIDDEN", 403);
  }
}
