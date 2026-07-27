import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { AdminServiceError, bumpAuthzRevision } from "@/lib/authz/adminService";

// ─────────────────────────────────────────────────────────────────────────────
// Firm offices (docs/26 Phase 3): the OFFICE scope target for assignments.
// Archive-not-delete (assignments may reference an office forever). Every
// change bumps the authz revision — office structure shapes scoped access.
// ─────────────────────────────────────────────────────────────────────────────

const postSchema = z.object({ name: z.string().min(2).max(120) });

const patchSchema = z
  .object({
    officeId: z.string().min(1),
    name: z.string().min(2).max(120).optional(),
    archive: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.archive !== undefined, {
    message: "Provide name and/or archive.",
  });

export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const offices = await prisma.office.findMany({
      where: { firmId: ctx.firm.id },
      orderBy: { name: "asc" },
    });
    return ok({ offices });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = postSchema.parse(await req.json());
    const office = await prisma.office.create({
      data: { firmId: ctx.firm.id, name: input.name },
    });
    await bumpAuthzRevision(ctx.firm.id);
    await audit(ctx, "office.create", { type: "office", id: office.id, meta: { name: input.name } });
    return ok({ office }, 201);
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = patchSchema.parse(await req.json());

    const office = await prisma.office.findFirst({
      where: { id: input.officeId, firmId: ctx.firm.id },
    });
    if (!office) return ok({ error: "Office not found" }, 404);
    if (input.archive && office.archivedAt) return ok({ error: "Office is already archived", code: "ALREADY_ARCHIVED" }, 409);

    const updated = await prisma.office.update({
      where: { id: office.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.archive === true ? { archivedAt: new Date() } : {}),
        ...(input.archive === false ? { archivedAt: null } : {}),
      },
    });
    await bumpAuthzRevision(ctx.firm.id);
    await audit(ctx, input.archive ? "office.archive" : "office.update", {
      type: "office",
      id: office.id,
      meta: { name: updated.name, archived: Boolean(updated.archivedAt) },
    });
    return ok({ office: updated });
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}
