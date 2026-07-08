import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { getObject } from "@/lib/storage";
import { handleError } from "@/lib/api";

// Authenticated, audited view of a source record — the target of the "Source"
// link under each chronology event. Streams the stored file when present, and
// otherwise serves the extracted text (e.g. for demo records with no binary).
export async function GET(_req: Request, { params }: { params: { caseId: string; docId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const doc = await prisma.document.findFirst({ where: { id: params.docId, caseId: params.caseId, firmId: ctx.firm.id } });
    if (!doc) return new Response("Not found", { status: 404 });

    await audit(ctx, "records.view", { type: "document", id: doc.id, caseId: params.caseId });

    if (doc.storageKey) {
      const buf = await getObject(doc.storageKey).catch(() => null);
      if (buf) {
        const ext = doc.filename.split(".").pop()?.toLowerCase();
        const mime =
          ext === "pdf"
            ? "application/pdf"
            : ext === "docx"
              ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : "application/octet-stream";
        return new Response(new Uint8Array(buf), {
          headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="${doc.filename}"` },
        });
      }
    }

    // Fallback: render the extracted text of the record.
    const body = `${doc.filename}\n${"—".repeat(40)}\n\n${doc.extractedText ?? "[no extracted text available]"}`;
    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return handleError(err);
  }
}
