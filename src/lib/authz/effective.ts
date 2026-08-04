// ─────────────────────────────────────────────────────────────────────────────
// Effective legacy permissions — the ONE server-derived compatibility layer
// between the canonical authorization system (role-template assignments with
// organization/case scope and effective windows) and the legacy Permission
// strings the existing interface and routes still consume.
//
// A user's effective permission set is the union of:
//   • their legacy seat role's ROLE_PERMISSIONS, and
//   • the legacy-named permissions of every role template they hold through a
//     currently effective assignment that provably applies to the resource:
//     ACTIVE status, effectiveFrom <= now, effectiveUntil null/future,
//     office-unscoped (an office-scoped assignment cannot be proven to cover a
//     case — fail closed), and org-wide or scoped to exactly the target case.
//
// Only permission names that already exist in the legacy vocabulary translate —
// canonical-only keys (e.g. reasoning.recompute) stay in the canonical system
// and its evaluator. Professional gates are unaffected: physician.review only
// flows from templates that legitimately carry it, and credential/attestation
// gates remain enforced downstream regardless of any permission here.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/rbac";
import type { UserRole } from "@/generated/prisma";
import { ALL_ROLE_TEMPLATES } from "@/lib/authz/roles";

/** Every legacy permission string the interface/routes understand. */
const LEGACY_PERMISSION_SET: ReadonlySet<string> = new Set(
  Object.values(ROLE_PERMISSIONS).flat(),
);

const TEMPLATE_BY_KEY = new Map(Object.values(ALL_ROLE_TEMPLATES).map((t) => [t.key, t]));

/** Pure translation: template keys → the legacy permissions those templates carry. */
export function legacyPermissionsForTemplates(templateKeys: string[]): Permission[] {
  const out = new Set<Permission>();
  for (const key of templateKeys) {
    const template = TEMPLATE_BY_KEY.get(key);
    if (!template) continue;
    for (const perm of template.permissions) {
      if (LEGACY_PERMISSION_SET.has(perm)) out.add(perm as Permission);
    }
  }
  return [...out];
}

export interface EffectivePermissionInput {
  userId: string;
  firmId: string;
  role: UserRole;
  /** When present, case-scoped assignments for exactly this case also apply. */
  caseId?: string;
}

/**
 * The role-template keys of the user's currently effective assignments that
 * provably apply to the resource — the same scope rules the permission union
 * uses (ACTIVE, in-window, office-unscoped, org-wide or exactly this case).
 */
export async function effectiveAssignmentTemplates(input: EffectivePermissionInput): Promise<string[]> {
  const now = new Date();
  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId: input.userId,
      firmId: input.firmId,
      status: "ACTIVE",
      builtInRole: { not: null },
      officeId: null,
      OR: [{ caseId: null }, ...(input.caseId ? [{ caseId: input.caseId }] : [])],
      effectiveFrom: { lte: now },
      AND: [{ OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }],
    },
    select: { builtInRole: true },
  });
  return [...new Set(assignments.map((a) => a.builtInRole!).filter(Boolean))];
}

/**
 * The user's effective legacy permissions for a resource. Server-derived only —
 * never trusts client-provided roles or permissions.
 */
export async function effectiveLegacyPermissions(input: EffectivePermissionInput): Promise<Permission[]> {
  const base = new Set<Permission>(ROLE_PERMISSIONS[input.role] ?? []);
  for (const perm of legacyPermissionsForTemplates(await effectiveAssignmentTemplates(input))) {
    base.add(perm);
  }
  return [...base].sort();
}

/** Templates whose professional work requires the unredacted clinical case
 *  view: the vocational expert must trace restrictions and functional findings
 *  to their clinical sources, and the forensic economist must see the actual
 *  cost projections and vocational inputs behind the loss analysis — attorney
 *  redactions (range-only pricing, no costs tab) would defeat those roles. */
const CLINICAL_VIEW_TEMPLATES: ReadonlySet<string> = new Set(["VOCATIONAL_EXPERT", "FORENSIC_ECONOMIST"]);

/**
 * Presentation classification for the case detail view. The attorney
 * presentation (range-only pricing, redacted clinical detail) applies to firm
 * administrators and to attorney seats WITHOUT clinical authority — a user
 * holding an effective clinical grant (a Life Care Planner assignment, a
 * Physician Reviewer assignment, or a specialist template in
 * CLINICAL_VIEW_TEMPLATES whose independent review REQUIRES the unredacted
 * evidence and reasoning) always receives the normal clinical view, regardless
 * of the legacy seat their account happens to occupy.
 */
export function isAttorneyPresentation(
  role: UserRole,
  effective: Permission[],
  templateKeys: readonly string[] = [],
): boolean {
  if (role === "ADMIN") return true;
  if (role !== "ATTORNEY_REVIEWER") return false;
  if (templateKeys.some((t) => CLINICAL_VIEW_TEMPLATES.has(t))) return false;
  return (
    !effective.includes("futurecare.edit") &&
    !effective.includes("chronology.edit") &&
    !effective.includes("physician.review")
  );
}

/**
 * Server-side gate for the attorney-only contribution paths (intake facts,
 * record/deposition upload, provider deposition notes): is this user's
 * presentation for the case GENUINELY the retaining-attorney surface? A
 * specialist riding an attorney seat (planner, physician, or vocational
 * assignment) is not an attorney and never inherits attorney allowances.
 */
export async function isAttorneyPresentationForCase(input: EffectivePermissionInput): Promise<boolean> {
  if (input.role !== "ATTORNEY_REVIEWER") return false;
  const [perms, templates] = await Promise.all([
    effectiveLegacyPermissions(input),
    effectiveAssignmentTemplates(input),
  ]);
  return isAttorneyPresentation(input.role, perms, templates);
}
