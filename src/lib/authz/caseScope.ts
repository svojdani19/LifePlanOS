import { prisma } from "@/lib/db";
import type { Prisma, UserRole } from "@/generated/prisma";
import { BUILT_IN_ROLES, LEGACY_ROLE_MAP, getRoleTemplate } from "@/lib/authz/roles";

// ─────────────────────────────────────────────────────────────────────────────
// Case-scoped, assignment-based authorization for workspaces (docs/28).
//
// Every workspace page answers the same two questions before loading data:
//   1. May this user open the workspace at all?
//   2. Which cases may the workspace show — the whole firm, or an explicit
//      list derived from what was actually granted?
//
// Access sources, in order of authority:
//   • Firm-staff legacy roles whose job is firm-wide (per-surface list).
//   • ACTIVE, unexpired UserRoleAssignments carrying a relevant template —
//     org-scoped (caseId null) may grant firm-wide where the surface allows
//     it; caseId-scoped grants exactly that case.
//   • CaseEngagements naming the user in a relevant assigned* slot.
//   • A platform-admin assignment grants VIEW-ONLY access everywhere (the
//     Super Admin "view as" path) — callers must render no mutation surfaces.
//
// Guest rule: a user whose every assignment is a caseId-scoped external-class
// grant (observer / external expert / attorney client / insurance client) is a
// guest, not staff — the legacy seat role they happen to occupy never widens
// their access to firm-wide.
// ─────────────────────────────────────────────────────────────────────────────

export type EngagementSlot =
  | "assignedPlannerId"
  | "assignedPhysicianId"
  | "assignedVocationalExpertId"
  | "assignedEconomistId"
  | "assignedQaReviewerId";

export const ALL_ENGAGEMENT_SLOTS: readonly EngagementSlot[] = [
  "assignedPlannerId",
  "assignedPhysicianId",
  "assignedVocationalExpertId",
  "assignedEconomistId",
  "assignedQaReviewerId",
];

/** External-facing / observer-class templates: sharing is deliberate, per case. */
export const EXTERNAL_CLASS_TEMPLATES: readonly string[] = [
  "READ_ONLY_OBSERVER",
  "EXTERNAL_EXPERT",
  "ATTORNEY_CLIENT",
  "INSURANCE_CLIENT",
];

/** The minimal slice of TenantContext this module needs. */
export interface CaseScopeContext {
  user: { id: string; role: UserRole };
  firm: { id: string };
}

export interface CaseScopeOptions {
  /** Legacy roles whose holders see this surface firm-wide (firm staff). */
  firmWideRoles?: readonly UserRole[];
  /** Built-in templates whose ACTIVE assignments grant access here. */
  assignmentTemplates?: readonly string[];
  /**
   * Whether an org-scoped (caseId null) assignment with a relevant template
   * grants firm-wide access. True for internal specialist surfaces; false for
   * external-facing surfaces, where sharing must stay per-case.
   */
  orgWideAssignmentGrantsAll?: boolean;
  /**
   * Engagement slots that grant per-case access on this surface. Pass an
   * empty array to ignore engagements. Defaults to every assigned* slot.
   */
  engagementSlots?: readonly EngagementSlot[];
}

export interface CaseAccess {
  /** May the user open this workspace at all? */
  allowed: boolean;
  /** "all" = firm-wide; otherwise the explicit accessible case-id list. */
  cases: "all" | string[];
  /** Access exists solely via a platform-admin assignment — render read-only. */
  platformAdminReadOnly: boolean;
}

/** Legacy roles whose mapped built-in template carries the permission. */
export function rolesWithPermission(permission: string): UserRole[] {
  return (Object.keys(LEGACY_ROLE_MAP) as UserRole[]).filter(
    (role) => getRoleTemplate(LEGACY_ROLE_MAP[role])?.permissions.includes(permission) ?? false,
  );
}

/** Built-in (assignable) templates carrying the permission. */
export function templatesWithPermission(permission: string): string[] {
  return Object.values(BUILT_IN_ROLES)
    .filter((t) => t.permissions.includes(permission))
    .map((t) => t.key);
}

const unexpired = (now: Date) => [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }];

/**
 * Does the user hold an ACTIVE, unexpired PLATFORM_SYSTEM_ADMINISTRATOR
 * assignment? Deliberately duplicated here (tiny, stable query) so this module
 * stays self-contained; grants VIEW-ONLY workspace access, never mutations.
 */
export async function isPlatformAdminAssignment(userId: string): Promise<boolean> {
  const count = await prisma.userRoleAssignment.count({
    where: {
      userId,
      status: "ACTIVE",
      builtInRole: "PLATFORM_SYSTEM_ADMINISTRATOR",
      OR: unexpired(new Date()),
    },
  });
  return count > 0;
}

type AssignmentRow = { caseId: string | null; builtInRole: string | null };

function isExternalOnly(role: UserRole, assignments: AssignmentRow[]): boolean {
  return (
    role !== "ADMIN" &&
    assignments.length > 0 &&
    assignments.every((a) => a.caseId != null && EXTERNAL_CLASS_TEMPLATES.includes(a.builtInRole ?? ""))
  );
}

async function activeAssignments(userId: string, firmId: string, now: Date): Promise<AssignmentRow[]> {
  return prisma.userRoleAssignment.findMany({
    where: { userId, firmId, status: "ACTIVE", OR: unexpired(now) },
    select: { caseId: true, builtInRole: true },
  });
}

async function engagedCaseIds(
  userId: string,
  firmId: string,
  slots: readonly EngagementSlot[],
): Promise<string[]> {
  if (slots.length === 0) return [];
  const rows = await prisma.caseEngagement.findMany({
    where: {
      firmId,
      status: { notIn: ["CANCELLED"] },
      OR: slots.map((slot) => ({ [slot]: userId }) as Prisma.CaseEngagementWhereInput),
    },
    select: { caseId: true },
  });
  return rows.map((r) => r.caseId);
}

/**
 * Resolve which cases the user may see on a workspace surface.
 * Returns "all" only for genuine firm-wide footing; otherwise the explicit
 * union of caseId-scoped assignment grants and engagement-slot assignments.
 */
export async function accessibleCaseIds(
  ctx: CaseScopeContext,
  opts: CaseScopeOptions,
): Promise<CaseAccess> {
  const now = new Date();
  const assignments = await activeAssignments(ctx.user.id, ctx.firm.id, now);
  const externalOnly = isExternalOnly(ctx.user.role, assignments);

  const templates = opts.assignmentTemplates ?? [];
  const relevant = assignments.filter(
    (a) => a.builtInRole != null && templates.includes(a.builtInRole),
  );

  // Firm-wide footing — never for guests whose grants are all case-scoped.
  if (!externalOnly) {
    if (opts.firmWideRoles?.includes(ctx.user.role)) {
      return { allowed: true, cases: "all", platformAdminReadOnly: false };
    }
    if (opts.orgWideAssignmentGrantsAll && relevant.some((a) => a.caseId == null)) {
      return { allowed: true, cases: "all", platformAdminReadOnly: false };
    }
  }

  const engaged = await engagedCaseIds(
    ctx.user.id,
    ctx.firm.id,
    opts.engagementSlots ?? ALL_ENGAGEMENT_SLOTS,
  );

  const ids = [
    ...new Set([
      ...relevant.map((a) => a.caseId).filter((id): id is string => id != null),
      ...engaged,
    ]),
  ];
  if (ids.length > 0) return { allowed: true, cases: ids, platformAdminReadOnly: false };

  // Last resort: the platform operator may LOOK (read-only), never touch.
  if (await isPlatformAdminAssignment(ctx.user.id)) {
    return { allowed: true, cases: "all", platformAdminReadOnly: true };
  }
  return { allowed: false, cases: [], platformAdminReadOnly: false };
}

/**
 * When the user's access is solely case-scoped external-class assignments,
 * return the explicit case-id list they may see (assignment grants plus
 * engagement slots); otherwise null — the user has firm footing and generic
 * surfaces (dashboard, /cases) keep their existing behavior.
 */
export async function externalOnlyCaseIds(ctx: CaseScopeContext): Promise<string[] | null> {
  const now = new Date();
  const assignments = await activeAssignments(ctx.user.id, ctx.firm.id, now);
  if (!isExternalOnly(ctx.user.role, assignments)) return null;
  const engaged = await engagedCaseIds(ctx.user.id, ctx.firm.id, ALL_ENGAGEMENT_SLOTS);
  return [
    ...new Set([
      ...assignments.map((a) => a.caseId).filter((id): id is string => id != null),
      ...engaged,
    ]),
  ];
}
