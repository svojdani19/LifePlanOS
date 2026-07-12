import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: { caseId: string; findingId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    await prisma.interviewFinding.deleteMany({ where: { id: params.findingId, caseId: params.caseId } });
    await audit(ctx, "interview.remove", { type: "interviewFinding", id: params.findingId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
