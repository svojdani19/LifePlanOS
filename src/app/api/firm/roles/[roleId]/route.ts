import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import {
  AdminServiceError,
  archiveRole,
  impactAnalysis,
  legacyEffectiveKeys,
  updateRolePermissions,
  type PermissionInput,
} from "@/lib/authz/adminService";

// ─────────────────────────────────────────────────────────────────────────────
// One custom role: inspect (with version history + impact), update under
// optimistic concurrency, archive. DELETE never hard-deletes: with assignments
// it's refused (405 — archive instead); without, it archives anyway, because
// role history must survive for audit.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: { roleId: string } };

const permissionSchema = z.object({
  key: z.string().min(1),
  effect: z.enum(["ALLOW", "DENY"]).default("ALLOW"),
  scopeType: z.enum(["ORGANIZATION", "OFFICE", "CASE", "REPORT"]).default("ORGANIZATION"),
  scopeConfig: z
    .object({
      caseId: z.string().optional(),
      officeId: z.string().optional(),
      reportType: z.string().optional(),
    })
    .optional(),
});

const patchSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    permissions: z.array(permissionSchema).optional(),
    name: z.string().min(2).max(80).optional(),
    description: z.string().max(500).optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    changeReason: z.string().max(500).optional(),
  })
  .refine((v) => !v.permissions || Boolean(v.changeReason), {
    message: "changeReason is required when changing permissions.",
    path: ["changeReason"],
  });

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const role = await prisma.customRole.findFirst({
      where: { id: params.roleId, firmId: ctx.firm.id },
      include: { permissions: true },
    });
    if (!role) return ok({ error: "Role not found" }, 404);
    const versions = await prisma.roleVersion.findMany({
      where: { customRoleId: role.id, firmId: ctx.firm.id },
      orderBy: { version: "desc" },
    });
    // Impact of the role AS CONFIGURED: no permission deltas, but who holds it.
    const impact = await impactAnalysis(
      ctx.firm.id,
      role.id,
      role.permissions.map((p) => ({ key: p.permissionKey, effect: p.effect as "ALLOW" | "DENY" })),
    );
    return ok({ role, versions, impact });
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = patchSchema.parse(await req.json());

    if (input.status === "ARCHIVED") {
      const result = await archiveRole({
        firmId: ctx.firm.id,
        roleId: params.roleId,
        actorId: ctx.user.id,
        ...(input.changeReason !== undefined ? { reason: input.changeReason } : {}),
      });
      await audit(ctx, "role.archive", {
        type: "customRole",
        id: params.roleId,
        meta: { activeAssignments: result.activeAssignments, reason: input.changeReason ?? null },
      });
      return ok(result);
    }

    // Preview the impact of a permission change before applying it, so the
    // audit row records what moved.
    const proposed: PermissionInput[] | undefined = input.permissions;
    const impact = proposed
      ? await impactAnalysis(ctx.firm.id, params.roleId, proposed.map((p) => ({ key: p.key, effect: p.effect })))
      : null;

    const result = await updateRolePermissions({
      firmId: ctx.firm.id,
      roleId: params.roleId,
      actorId: ctx.user.id,
      grantorPermissionKeys: legacyEffectiveKeys(ctx.user.role),
      expectedVersion: input.expectedVersion,
      ...(proposed ? { permissions: proposed } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.changeReason !== undefined ? { changeReason: input.changeReason } : {}),
    });
    await audit(ctx, "role.update", {
      type: "customRole",
      id: params.roleId,
      meta: {
        version: result.version,
        changeReason: input.changeReason ?? null,
        ...(impact
          ? {
              added: impact.added,
              removed: impact.removed,
              newlyDenied: impact.newlyDenied,
              criticalChanged: impact.criticalChanged,
            }
          : {}),
      },
    });
    return ok({ ...result, impact });
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const role = await prisma.customRole.findFirst({
      where: { id: params.roleId, firmId: ctx.firm.id },
    });
    if (!role) return ok({ error: "Role not found" }, 404);
    const assignments = await prisma.userRoleAssignment.count({
      where: { firmId: ctx.firm.id, customRoleId: role.id, status: { in: ["ACTIVE", "SCHEDULED"] } },
    });
    if (assignments > 0) {
      return ok(
        { error: `This role has ${assignments} active assignment(s) — archive it instead.`, code: "ARCHIVE_INSTEAD" },
        405,
      );
    }
    // Roles are never hard-deleted: history must survive for audit.
    const result = await archiveRole({
      firmId: ctx.firm.id,
      roleId: role.id,
      actorId: ctx.user.id,
      reason: "archived via delete request",
    });
    await audit(ctx, "role.archive", {
      type: "customRole",
      id: role.id,
      meta: { via: "DELETE", activeAssignments: 0 },
    });
    return ok(result);
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}
