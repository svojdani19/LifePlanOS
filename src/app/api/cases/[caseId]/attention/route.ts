import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { syncAttention } from "@/lib/engine/attention";
import { ok, handleError } from "@/lib/api";

// Case Review Assistant — re-projects the case's deterministic findings into
// lifecycle-tracked attention items and returns the active queue + readiness.
// GET and POST both sync (the projection is cheap and must reflect current data);
// POST additionally audits an explicit "assistant run".

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const result = await syncAttention(params.caseId, ctx.firm.id, ctx.user.id);
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const result = await syncAttention(params.caseId, ctx.firm.id, ctx.user.id);
    await audit(ctx, "assistant.run", { type: "case", id: params.caseId, caseId: params.caseId, meta: { active: result.active.length, blocking: result.blocking } });
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
