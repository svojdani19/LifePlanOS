import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { processDocumentExtraction } from "@/lib/documents/extractionRun";
import { ok, handleError } from "@/lib/api";

const schema = z.object({ documentId: z.string().optional() });

// (Re)run source-grounded extraction for one document or the whole case.
// Regeneration NEVER destroys human review: drafts are superseded, human work
// is preserved, and source changes mark reviewed content stale.
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "records.upload");
    await requireCase(ctx, params.caseId);
    const input = schema.parse(await req.json().catch(() => ({})));
    const docs = await prisma.document.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id, ...(input.documentId ? { id: input.documentId } : {}) },
      select: { id: true },
    });
    if (input.documentId && docs.length === 0) return ok({ error: "Document not found" }, 404);
    const results = [];
    for (const d of docs) {
      results.push(await processDocumentExtraction(d.id, { actorUserId: ctx.user.id }));
    }
    await audit(ctx, "records.extract", { type: "case", id: params.caseId, caseId: params.caseId, meta: { documents: docs.length } });
    return ok({ results });
  } catch (err) {
    return handleError(err);
  }
}
