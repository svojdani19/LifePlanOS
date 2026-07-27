import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { getDefinition } from "@/lib/authz/registry";
import {
  authorize,
  explain,
  type AuthzAssignment,
  type AuthzGrant,
  type CustomRolePermissionLike,
} from "@/lib/authz/evaluate";
import type { PermissionScopeType } from "@/lib/authz/registry";

// ─────────────────────────────────────────────────────────────────────────────
// "Why can/can't this user do X?" — dry-run the enterprise evaluator against a
// target user's real legacy role, assignments, grants, and credentials
// (docs/26 Phase 5 impact tooling). Read-only; answers stay user-safe: the
// denialCode and explain() bullets, never internal state. Previews touching a
// privileged key are themselves audited.
// ─────────────────────────────────────────────────────────────────────────────

const postSchema = z.object({
  userId: z.string().min(1),
  permission: z.string().min(1),
  caseId: z.string().optional(),
  officeId: z.string().optional(),
  reportType: z.string().optional(),
  reportStatus: z.string().optional(),
  workflowStage: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = postSchema.parse(await req.json());

    const target = await prisma.user.findFirst({
      where: { id: input.userId, firmId: ctx.firm.id },
    });
    if (!target) return ok({ error: "User not found" }, 404);

    const [assignmentRows, grantRows, credentialRows] = await Promise.all([
      prisma.userRoleAssignment.findMany({
        where: { userId: target.id, firmId: ctx.firm.id, status: { in: ["ACTIVE", "SCHEDULED"] } },
      }),
      prisma.accessGrant.findMany({
        where: { userId: target.id, firmId: ctx.firm.id, status: "ACTIVE" },
      }),
      prisma.userCredential.findMany({
        where: { userId: target.id, firmId: ctx.firm.id },
      }),
    ]);

    const customRoleIds = [
      ...new Set(assignmentRows.map((a) => a.customRoleId).filter((r): r is string => Boolean(r))),
    ];
    const customRoles =
      customRoleIds.length > 0
        ? await prisma.customRole.findMany({
            where: { id: { in: customRoleIds }, firmId: ctx.firm.id },
            include: { permissions: true },
          })
        : [];
    const roleById = new Map(customRoles.map((r) => [r.id, r]));

    const assignments: AuthzAssignment[] = assignmentRows.map((a) => {
      const role = a.customRoleId ? roleById.get(a.customRoleId) : undefined;
      const customRolePermissions: CustomRolePermissionLike[] | null = role
        ? role.permissions.map((p) => ({
            permissionKey: p.permissionKey,
            effect: p.effect as "ALLOW" | "DENY",
            scopeType: p.scopeType as PermissionScopeType,
            scopeConfig: (p.scopeConfig as CustomRolePermissionLike["scopeConfig"]) ?? null,
          }))
        : null;
      return {
        builtInRole: a.builtInRole,
        customRolePermissions,
        officeId: a.officeId,
        caseId: a.caseId,
        status: a.status,
        effectiveFrom: a.effectiveFrom,
        effectiveUntil: a.effectiveUntil,
      };
    });

    const grants: AuthzGrant[] = grantRows.map((g) => ({
      scopeType: g.scopeType as PermissionScopeType,
      scopeId: g.scopeId,
      permissions: Array.isArray(g.permissions) ? (g.permissions as string[]) : [],
      status: g.status,
      effectiveFrom: g.effectiveFrom,
      effectiveUntil: g.effectiveUntil,
    }));

    const result = authorize(
      {
        userId: target.id,
        firmId: ctx.firm.id,
        permission: input.permission,
        ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
        ...(input.officeId !== undefined ? { officeId: input.officeId } : {}),
        ...(input.reportType !== undefined ? { reportType: input.reportType } : {}),
        ...(input.reportStatus !== undefined ? { reportStatus: input.reportStatus } : {}),
        ...(input.workflowStage !== undefined ? { workflowStage: input.workflowStage } : {}),
      },
      {
        userFirmId: target.firmId,
        legacyRole: target.role,
        assignments,
        grants,
        credentials: credentialRows.map((c) => ({
          category: c.category,
          status: c.status,
          expiresAt: c.expiresAt,
        })),
        firmFeatures: ctx.firm.features,
        now: new Date(),
      },
    );

    // Previews of privileged keys are themselves auditable events.
    const def = getDefinition(input.permission);
    if (def?.privileged) {
      await audit(ctx, "authz.preview", {
        type: "user",
        id: target.id,
        ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
        meta: { permission: input.permission, allowed: result.allowed, denialCode: result.denialCode ?? null },
      });
    }

    return ok({
      allowed: result.allowed,
      denialCode: result.denialCode ?? null,
      userSafeReason: result.userSafeReason,
      explanation: explain(result),
    });
  } catch (err) {
    return handleError(err);
  }
}
