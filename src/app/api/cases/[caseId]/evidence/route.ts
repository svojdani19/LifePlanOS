import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { rebuildEvidenceGraph } from "@/lib/engine/evidenceGraph";
import { ok, handleError } from "@/lib/api";

// Evidence graph for the case (P2): the materialized links the Evidence
// Explorer renders. GET returns the stored graph; POST rebuilds it from the
// current structured data (no inference — see engine/evidenceGraph.ts).

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const links = await prisma.evidenceLink.findMany({ where: { caseId: params.caseId, firmId: ctx.firm.id }, orderBy: { createdAt: "asc" } });
    return ok({ links });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const count = await rebuildEvidenceGraph(params.caseId, ctx.firm.id);
    await audit(ctx, "evidence.rebuild", { type: "case", id: params.caseId, caseId: params.caseId, meta: { links: count } });
    const links = await prisma.evidenceLink.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "asc" } });
    return ok({ links });
  } catch (err) {
    return handleError(err);
  }
}
