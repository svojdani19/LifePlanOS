import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { ingestDocument } from "@/lib/documents/ingest";
import { SAMPLE_DOCS } from "@/lib/documents/samples";
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

// Ingest records. Three shapes:
//   • multipart/form-data with `files` (+ optional `typeMap`) — real uploads;
//     each file's TEXT is extracted and the type is read from its content.
//   • JSON { sample: true } — ingests the built-in demo set (generic filenames,
//     real body text) so the auto-classifier can be seen working on content.
//   • JSON { documents: [{ filename, text }] } — pre-extracted text.
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
        const buffer = Buffer.from(await file.arrayBuffer());
        const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
        const storageKey = await putObject(buffer, ext);
        const { document, pages } = await ingestDocument({
          caseId: params.caseId,
          firmId: ctx.firm.id,
          uploadedById: ctx.user.id,
          filename: file.name,
          mimeType: file.type,
          buffer,
          storageKey,
          forcedType: typeMap[file.name],
        });
        await recordUsage(ctx, "RECORD_PAGE_OCR", { caseId: params.caseId, quantity: pages });
        created.push(document.id);
      }
    } else {
      const body = await req.json().catch(() => ({}));
      const docs: { filename: string; text?: string }[] = body.sample
        ? SAMPLE_DOCS
        : Array.isArray(body.documents)
          ? body.documents
          : Array.isArray(body.filenames)
            ? body.filenames.map((filename: string) => ({ filename }))
            : [];
      for (const d of docs) {
        const { document } = await ingestDocument({
          caseId: params.caseId,
          firmId: ctx.firm.id,
          uploadedById: ctx.user.id,
          filename: d.filename,
          text: d.text,
        });
        created.push(document.id);
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
