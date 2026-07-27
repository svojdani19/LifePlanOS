// ─────────────────────────────────────────────────────────────────────────────
// Authorization context loader — one batched read per request, attached to the
// tenant context by requireApiContext so the evaluator stays pure/synchronous
// at every requirePermission call site. Best-effort: a load failure degrades
// to legacy-only authorization (shadow silent), never to a broken request.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import type { AuthzContext, AuthzAssignment, AuthzGrant, AuthzCredential, CustomRolePermissionLike } from "./evaluate";

export async function loadAuthzContext(userId: string, firmId: string, legacyRole: string, firmFeatures: unknown): Promise<AuthzContext> {
  const [assignments, grants, credentials] = await Promise.all([
    prisma.userRoleAssignment.findMany({
      where: { userId, firmId, status: { in: ["ACTIVE", "SCHEDULED"] } },
    }),
    prisma.accessGrant.findMany({ where: { userId, firmId, status: "ACTIVE" } }),
    prisma.userCredential.findMany({ where: { userId, firmId }, select: { category: true, status: true, expiresAt: true } }),
  ]);
  // Custom-role permission rows for any custom-role assignments (one query).
  const customIds = assignments.map((a) => a.customRoleId).filter((x): x is string => !!x);
  const rolePerms = customIds.length
    ? await prisma.customRolePermission.findMany({ where: { customRoleId: { in: customIds } } })
    : [];
  const permsByRole = new Map<string, typeof rolePerms>();
  for (const p of rolePerms) {
    const arr = permsByRole.get(p.customRoleId) ?? [];
    arr.push(p);
    permsByRole.set(p.customRoleId, arr);
  }
  return {
    userFirmId: firmId,
    legacyRole,
    assignments: assignments.map(
      (a): AuthzAssignment => ({
        builtInRole: a.builtInRole ?? undefined,
        customRolePermissions: a.customRoleId
          ? (permsByRole.get(a.customRoleId) ?? []).map((p) => ({
              permissionKey: p.permissionKey,
              effect: p.effect as "ALLOW" | "DENY",
              scopeType: p.scopeType as CustomRolePermissionLike["scopeType"],
              scopeConfig: p.scopeConfig as CustomRolePermissionLike["scopeConfig"],
            }))
          : undefined,
        officeId: a.officeId ?? undefined,
        caseId: a.caseId ?? undefined,
        status: a.status,
        effectiveFrom: a.effectiveFrom,
        effectiveUntil: a.effectiveUntil ?? undefined,
      }),
    ),
    grants: grants.map(
      (g): AuthzGrant => ({
        scopeType: g.scopeType as AuthzGrant["scopeType"],
        scopeId: g.scopeId ?? undefined,
        permissions: Array.isArray(g.permissions) ? (g.permissions as string[]) : [],
        effectiveFrom: g.effectiveFrom,
        effectiveUntil: g.effectiveUntil,
        status: g.status,
      }),
    ),
    credentials: credentials.map(
      (c): AuthzCredential => ({ category: c.category ?? "OTHER", status: c.status, expiresAt: c.expiresAt ?? undefined }),
    ),
    firmFeatures,
    now: new Date(),
  };
}
