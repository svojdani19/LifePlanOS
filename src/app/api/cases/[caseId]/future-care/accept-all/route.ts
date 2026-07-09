import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { generateReviews } from "@/lib/engine/generate";
import { ok, handleError } from "@/lib/api";

// Bulk physician sign-off (Module 12): approve every still-pending future-care
// item in a single action. Explicit prior decisions (MODIFIED / REJECTED) are
// left untouched so a reviewer's rejections are not silently reversed.
export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "physician.review");
    await requireCase(ctx, params.caseId);

    const res = await prisma.futureCareItem.updateMany({
      where: { caseId: params.caseId, physicianStatus: "PENDING" },
      data: { physicianStatus: "APPROVED" },
    });

    // Reviews reference physician status, so refresh them once after the batch.
    await generateReviews(params.caseId);
    await audit(ctx, "physician.review", { type: "case", id: params.caseId, caseId: params.caseId, meta: { action: "accept-all", count: res.count } });
    return ok({ count: res.count });
  } catch (err) {
    return handleError(err);
  }
}
