import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { BUILT_IN_ROLES } from "@/lib/authz/roles";
import {
  AdminServiceError,
  cloneRole,
  createCustomRole,
  legacyEffectiveKeys,
  roleMatrix,
} from "@/lib/authz/adminService";

// ─────────────────────────────────────────────────────────────────────────────
// Custom roles — list & create/clone (docs/26 Phase 2). Gated by the legacy
// `team.manage` permission for now (roles.* keys take over at enforcement
// adoption). The delegation ceiling uses the caller's legacy effective keys:
// an admin can only put into a role what their own role effectively holds.
// ─────────────────────────────────────────────────────────────────────────────

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

const postSchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    cloneFrom: z.string().optional(), // built-in template key | custom role id
    permissions: z.array(permissionSchema).optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => Boolean(v.cloneFrom) || (v.permissions?.length ?? 0) > 0, {
    message: "Provide permissions, or cloneFrom to start from an existing role.",
  });

export async function GET(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    // Additive: ?matrix=1 returns the role × permission matrix export instead
    // of the role lists (docs/26 P5 — Permission Matrix tab).
    if (new URL(req.url).searchParams.get("matrix")) {
      return ok({ matrix: await roleMatrix(ctx.firm.id) });
    }
    const customRoles = await prisma.customRole.findMany({
      where: { firmId: ctx.firm.id },
      include: { permissions: true },
      orderBy: { name: "asc" },
    });
    const builtIn = Object.values(BUILT_IN_ROLES).map((tpl) => ({
      key: tpl.key,
      name: tpl.name,
      description: tpl.description,
      defaultScope: tpl.defaultScope,
      externalFacing: tpl.externalFacing,
      assignable: tpl.key !== "PLATFORM_SYSTEM_ADMINISTRATOR",
      permissions: tpl.permissions,
    }));
    return ok({ builtIn, customRoles });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = postSchema.parse(await req.json());
    const grantorPermissionKeys = legacyEffectiveKeys(ctx.user.role);

    if (input.cloneFrom) {
      const result = await cloneRole({
        firmId: ctx.firm.id,
        actorId: ctx.user.id,
        grantorPermissionKeys,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        cloneFrom: input.cloneFrom,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      await audit(ctx, "role.clone", {
        type: "customRole",
        id: result.role.id,
        meta: { name: input.name, cloneFrom: input.cloneFrom, droppedKeys: result.droppedKeys },
      });
      return ok(result, 201);
    }

    const result = await createCustomRole({
      firmId: ctx.firm.id,
      actorId: ctx.user.id,
      grantorPermissionKeys,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      permissions: input.permissions ?? [],
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    await audit(ctx, "role.create", {
      type: "customRole",
      id: result.role.id,
      meta: { name: input.name, permissionCount: result.permissions.length },
    });
    return ok(result, 201);
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}
