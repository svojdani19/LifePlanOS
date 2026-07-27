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
    const kind = record.format === "MEMO" ? "testimony-prep" : "life-care-plan";
    const filename = `${c.caseNumber}-${kind}-v${record.version}.${ext}`;
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
