import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { getObject } from "@/lib/storage";
import { handleError } from "@/lib/api";

// Authenticated, audited view of a precedent LCP — streams the stored file when
// present, otherwise renders its extracted text.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    const p = await prisma.precedentPlan.findFirst({ where: { id: params.id, firmId: ctx.firm.id } });
    if (!p) return new Response("Not found", { status: 404 });
    await audit(ctx, "precedents.view", { type: "precedentPlan", id: p.id });

    if (p.storageKey) {
      const buf = await getObject(p.storageKey).catch(() => null);
      if (buf) {
        const ext = (p.filename || "").split(".").pop()?.toLowerCase();
        const mime = ext === "pdf" ? "application/pdf" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/octet-stream";
        return new Response(new Uint8Array(buf), { headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="${p.filename}"` } });
      }
    }
    const body = `${p.title}\n${"—".repeat(40)}\n\n${p.extractedText ?? "[no extracted text available]"}`;
    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return handleError(err);
  }
}
