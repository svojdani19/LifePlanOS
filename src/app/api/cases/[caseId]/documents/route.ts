import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { processDocument } from "@/lib/engine/generate";
import { guessDocType } from "@/lib/documents/taxonomy";
import { putObject } from "@/lib/storage";
import { ok, handleError } from "@/lib/api";

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const documents = await prisma.document.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "desc" } });
    return ok({ documents });
  } catch (err) {
    return handleError(err);
  }
}

// Accepts multipart file uploads OR a JSON body { filenames: string[] } for
// quickly adding sample records in the demo. Each unspecified record is
// auto-labeled via the filename heuristic and (mock) OCR-processed on ingest.
// The client may also send a multipart `typeMap` (JSON { [filename]: TYPE }) to
// override the auto-detected label per file.
export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "records.upload");
    await requireCase(ctx, params.caseId);

    const contentType = req.headers.get("content-type") ?? "";
    const created: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      const typeMapRaw = form.get("typeMap");
      const typeMap: Record<string, string> = typeof typeMapRaw === "string" ? JSON.parse(typeMapRaw) : {};
      for (const file of files) {
        const buf = Buffer.from(await file.arrayBuffer());
        const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
        const key = await putObject(buf, ext);
        const resolvedType = (typeMap[file.name] || guessDocType(file.name)) as never;
        const doc = await prisma.document.create({
          data: { caseId: params.caseId, firmId: ctx.firm.id, filename: file.name, type: resolvedType, storageKey: key, uploadedById: ctx.user.id },
        });
        await processDocument(doc);
        await recordUsage(ctx, "RECORD_PAGE_OCR", { caseId: params.caseId, quantity: doc.pageCount || 1 });
        created.push(doc.id);
      }
    } else {
      const body = await req.json().catch(() => ({}));
      const filenames: string[] = Array.isArray(body.filenames) ? body.filenames : [];
      for (const filename of filenames) {
        const doc = await prisma.document.create({
          data: { caseId: params.caseId, firmId: ctx.firm.id, filename, type: guessDocType(filename) as never, uploadedById: ctx.user.id },
        });
        await processDocument(doc);
        created.push(doc.id);
      }
    }

    if (created.length) {
      await prisma.case.updateMany({ where: { id: params.caseId, status: "INTAKE" }, data: { status: "RECORDS" } });
    }
    await audit(ctx, "records.upload", { type: "case", id: params.caseId, caseId: params.caseId, meta: { count: created.length } });
    return ok({ created: created.length });
  } catch (err) {
    return handleError(err);
  }
}
