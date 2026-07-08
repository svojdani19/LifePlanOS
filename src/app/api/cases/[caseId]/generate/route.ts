import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { generatePlan } from "@/lib/engine/generate";
import { ok, handleError } from "@/lib/api";

// Run the full AI pipeline: chronology → causation → future care → costs → reviews.
export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    await requireCase(ctx, params.caseId);

    const result = await generatePlan(params.caseId);

    await prisma.case.update({ where: { id: params.caseId }, data: { status: "FUTURE_CARE" } });
    await recordUsage(ctx, "AI_GENERATION", { caseId: params.caseId, meta: { module: "plan" } });
    await audit(ctx, "plan.generate", { type: "case", id: params.caseId, caseId: params.caseId, meta: result });

    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
