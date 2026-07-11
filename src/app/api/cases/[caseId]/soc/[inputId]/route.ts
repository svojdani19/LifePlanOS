import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { recomputeSocForCase } from "@/lib/engine/standardOfCare";

// Remove a user-added Standard-of-Care note/source and recompute the assessment.
export async function DELETE(_req: Request, { params }: { params: { caseId: string; inputId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    const deleted = await prisma.socUserInput.deleteMany({ where: { id: params.inputId, caseId: params.caseId } });
    if (deleted.count === 0) return ok({ error: "Input not found" }, 404);
    await recomputeSocForCase(params.caseId).catch(() => {});
    await audit(ctx, "soc.input.remove", { type: "socUserInput", id: params.inputId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
