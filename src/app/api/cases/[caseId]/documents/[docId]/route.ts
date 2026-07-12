import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { TYPE_LABEL } from "@/lib/documents/taxonomy";
import { ok, handleError } from "@/lib/api";
import { deleteObject } from "@/lib/storage";

// Reassign a document's auto-detected label. `type` is validated against the
// known taxonomy so the enum can never receive an out-of-range value.
const patchSchema = z.object({ type: z.string().refine((t) => t in TYPE_LABEL, "Unknown document type") });

export async function PATCH(req: Request, { params }: { params: { caseId: string; docId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "records.upload");
    await requireCase(ctx, params.caseId);
    const { type } = patchSchema.parse(await req.json());
    const updated = await prisma.document.updateMany({
      where: { id: params.docId, caseId: params.caseId, firmId: ctx.firm.id },
      data: { type: type as never, classifiedBy: "manual" },
    });
    if (updated.count === 0) return ok({ error: "Document not found" }, 404);
    await audit(ctx, "records.reclassify", { type: "document", id: params.docId, caseId: params.caseId, meta: { type } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: { caseId: string; docId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "records.upload");
    await requireCase(ctx, params.caseId);
    const doc = await prisma.document.findFirst({ where: { id: params.docId, caseId: params.caseId, firmId: ctx.firm.id }, select: { storageKey: true } });
    await prisma.document.deleteMany({ where: { id: params.docId, caseId: params.caseId, firmId: ctx.firm.id } });
    // PHI hygiene (ATD-3): remove the stored file with its row.
    if (doc?.storageKey) await deleteObject(doc.storageKey);
    await audit(ctx, "records.delete", { type: "document", id: params.docId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
