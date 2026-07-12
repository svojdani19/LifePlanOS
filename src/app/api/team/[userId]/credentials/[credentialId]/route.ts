import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { deleteObject } from "@/lib/storage";
import { ok, handleError } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: { userId: string; credentialId: string } }) {
  try {
    const ctx = await requireApiContext();
    // Owner or team.manage; always firm-scoped.
    if (params.userId !== ctx.user.id) requirePermission(ctx, "team.manage");
    const cred = await prisma.userCredential.findFirst({ where: { id: params.credentialId, userId: params.userId, firmId: ctx.firm.id }, select: { storageKey: true } });
    await prisma.userCredential.deleteMany({ where: { id: params.credentialId, userId: params.userId, firmId: ctx.firm.id } });
    if (cred?.storageKey) await deleteObject(cred.storageKey); // PHI/document hygiene
    await audit(ctx, "credential.remove", { type: "userCredential", id: params.credentialId, meta: { userId: params.userId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
