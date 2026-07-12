import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit, TenantError } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  role: z.enum(["ADMIN", "PLANNER", "PHYSICIAN_REVIEWER", "ATTORNEY_REVIEWER", "PARALEGAL", "BILLING_USER"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  credentialSummary: z.string().max(600).nullable().optional(),
});

// Guards below re-scope by firmId so one firm can never mutate another's users.
export async function PATCH(req: Request, { params }: { params: { userId: string } }) {
  try {
    const ctx = await requireApiContext();
    const input = patchSchema.parse(await req.json());
    const onlyCredentialSummary = input.role === undefined && input.status === undefined;
    // Seat owners may set their own credential summary; role/status = team.manage.
    if (!(onlyCredentialSummary && params.userId === ctx.user.id)) requirePermission(ctx, "team.manage");
    const target = await prisma.user.findFirst({ where: { id: params.userId, firmId: ctx.firm.id } });
    if (!target) throw new TenantError("User not found", "FORBIDDEN", 404);
    if (target.id === ctx.user.id && input.status === "SUSPENDED") {
      throw new TenantError("You cannot suspend your own account.", "FORBIDDEN", 400);
    }
    const updated = await prisma.user.update({ where: { id: target.id }, data: input });
    await audit(ctx, "seat.update", { type: "user", id: target.id, meta: { keys: Object.keys(input) } });
    return ok({ user: { id: updated.id, role: updated.role, status: updated.status, credentialSummary: updated.credentialSummary } });
  } catch (err) {
    return handleError(err);
  }
}

// Revoke access (soft — retains the record for audit) rather than hard delete.
export async function DELETE(_req: Request, { params }: { params: { userId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const target = await prisma.user.findFirst({ where: { id: params.userId, firmId: ctx.firm.id } });
    if (!target) throw new TenantError("User not found", "FORBIDDEN", 404);
    if (target.id === ctx.user.id) throw new TenantError("You cannot revoke your own access.", "FORBIDDEN", 400);
    await prisma.user.update({ where: { id: target.id }, data: { status: "SUSPENDED" } });
    await prisma.session.deleteMany({ where: { userId: target.id } }); // kill active sessions
    await audit(ctx, "seat.revoke", { type: "user", id: target.id });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
