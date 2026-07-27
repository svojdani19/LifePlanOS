import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { getRoleTemplate } from "@/lib/authz/roles";
import {
  AdminServiceError,
  assignRole,
  expireSweep,
  revokeAssignment,
} from "@/lib/authz/adminService";

// ─────────────────────────────────────────────────────────────────────────────
// Role assignments (docs/26 Phase 3): multi-role, office/case-scoped,
// scheduled, temporary, revocable. GET runs the expiry sweep first so listed
// statuses are never stale. Revocation is soft — the row keeps who/when/why.
// ─────────────────────────────────────────────────────────────────────────────

const postSchema = z
  .object({
    userId: z.string().min(1),
    builtInRole: z.string().optional(),
    customRoleId: z.string().optional(),
    officeId: z.string().optional(),
    caseId: z.string().optional(),
    responsibility: z.string().max(120).optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveUntil: z.coerce.date().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => Boolean(v.builtInRole) !== Boolean(v.customRoleId), {
    message: "Provide exactly one of builtInRole or customRoleId.",
  });

export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    await expireSweep(ctx.firm.id);

    const assignments = await prisma.userRoleAssignment.findMany({
      where: { firmId: ctx.firm.id },
      orderBy: { createdAt: "desc" },
    });

    const userIds = [...new Set(assignments.flatMap((a) => [a.userId, a.assignedById]))];
    const roleIds = [...new Set(assignments.map((a) => a.customRoleId).filter((r): r is string => Boolean(r)))];
    const [users, customRoles] = await Promise.all([
      prisma.user.findMany({
        where: { firmId: ctx.firm.id, id: { in: userIds } },
        select: { id: true, name: true, email: true, role: true },
      }),
      roleIds.length > 0
        ? prisma.customRole.findMany({
            where: { firmId: ctx.firm.id, id: { in: roleIds } },
            select: { id: true, name: true, status: true },
          })
        : Promise.resolve([]),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const roleById = new Map(customRoles.map((r) => [r.id, r]));

    return ok({
      assignments: assignments.map((a) => ({
        ...a,
        user: userById.get(a.userId) ?? null,
        assignedBy: userById.get(a.assignedById) ?? null,
        roleLabel: a.builtInRole
          ? (getRoleTemplate(a.builtInRole)?.name ?? a.builtInRole)
          : (roleById.get(a.customRoleId ?? "")?.name ?? "Unknown role"),
        roleKind: a.builtInRole ? "built-in" : "custom",
      })),
    });
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = postSchema.parse(await req.json());

    const assignment = await assignRole({
      firmId: ctx.firm.id,
      actorId: ctx.user.id,
      userId: input.userId,
      ...(input.builtInRole !== undefined ? { builtInRole: input.builtInRole } : {}),
      ...(input.customRoleId !== undefined ? { customRoleId: input.customRoleId } : {}),
      ...(input.officeId !== undefined ? { officeId: input.officeId } : {}),
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      ...(input.responsibility !== undefined ? { responsibility: input.responsibility } : {}),
      ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
      ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    await audit(ctx, "role.assign", {
      type: "userRoleAssignment",
      id: assignment.id,
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      meta: {
        userId: input.userId,
        builtInRole: input.builtInRole ?? null,
        customRoleId: input.customRoleId ?? null,
        officeId: input.officeId ?? null,
        status: assignment.status,
        reason: input.reason ?? null,
      },
    });
    return ok({ assignment }, 201);
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return ok({ error: "Missing ?id=" }, 422);
    // Reason travels in an optional JSON body.
    let reason: string | undefined;
    try {
      const body = (await req.json()) as { reason?: unknown };
      if (typeof body?.reason === "string" && body.reason.length > 0) reason = body.reason.slice(0, 500);
    } catch {
      // no body — reason stays undefined
    }

    const revoked = await revokeAssignment({
      firmId: ctx.firm.id,
      actorId: ctx.user.id,
      assignmentId: id,
      ...(reason !== undefined ? { reason } : {}),
    });
    await audit(ctx, "role.revoke", {
      type: "userRoleAssignment",
      id,
      meta: { userId: revoked.userId, reason: reason ?? null },
    });
    return ok({ assignment: revoked });
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}
