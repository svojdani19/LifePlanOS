import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { getObject } from "@/lib/storage";
import { handleError } from "@/lib/api";

const CONTENT_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  memo: "text/plain",
  html: "text/html; charset=utf-8",
};

// Authenticated, audited download of a generated report. PHI files are never
// served statically — access is logged (export logging, Module 17).
export async function GET(_req: Request, { params }: { params: { caseId: string; exportId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "report.export");
    const c = await requireCase(ctx, params.caseId);
    const record = await prisma.reportExport.findFirst({ where: { id: params.exportId, caseId: params.caseId, firmId: ctx.firm.id } });
    if (!record || !record.storageKey) return new Response("Not found", { status: 404 });

    const buf = await getObject(record.storageKey);
    await audit(ctx, "export.download", { type: "reportExport", id: record.id, caseId: params.caseId });

    // The stored object's own extension wins (a MEMO-format testimony pack is a
    // .docx file); the format enum is the fallback for legacy rows.
    const storedExt = /\.([a-z0-9]+)$/i.exec(record.storageKey)?.[1]?.toLowerCase();
    const ext = storedExt ?? record.format.toLowerCase();
    const kind = record.reportType
      ? record.reportType.toLowerCase().replace(/_/g, "-")
      : record.format === "MEMO"
        ? "testimony-prep"
        : "life-care-plan";
    const filename = `${c.caseNumber}-${kind}-v${record.version}.${ext}`;
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    // PHI downloads: no MIME sniffing, no caching, no referrer leakage — and
    // HTML reports get a strict CSP so a served document can run nothing.
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    };
    if (contentType.startsWith("text/html")) {
      headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
    }
    return new Response(new Uint8Array(buf), { headers });
  } catch (err) {
    return handleError(err);
  }
}
