import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "precedents.manage");
    const p = await prisma.precedentPlan.findFirst({ where: { id: params.id, firmId: ctx.firm.id } });
    if (!p) return ok({ error: "Not found" }, 404);
    await prisma.precedentPlan.delete({ where: { id: p.id } });
    await audit(ctx, "precedents.delete", { type: "precedentPlan", id: p.id });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
