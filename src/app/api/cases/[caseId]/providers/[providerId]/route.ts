import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  credentials: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  facility: z.string().nullable().optional(),
  contact: z.string().nullable().optional(),
  isTreating: z.boolean().optional(),
  status: z.enum(["SUGGESTED", "CONFIRMED", "DISMISSED"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: { caseId: string; providerId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    const input = patchSchema.parse(await req.json());
    const res = await prisma.treatingProvider.updateMany({ where: { id: params.providerId, caseId: params.caseId }, data: input });
    if (res.count === 0) return ok({ error: "Provider not found" }, 404);
    await audit(ctx, "provider.edit", { type: "treatingProvider", id: params.providerId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: { caseId: string; providerId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    await prisma.treatingProvider.deleteMany({ where: { id: params.providerId, caseId: params.caseId } });
    await audit(ctx, "provider.remove", { type: "treatingProvider", id: params.providerId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
