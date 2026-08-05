import { requireApiContext, requirePermission, requireCase, canCanonicalPermission } from "@/lib/tenant";
import { getStructuredRecord, factualReviewState } from "@/lib/records/structuredRecord";
import { ok, handleError } from "@/lib/api";

// The Records page's structured view: per-document extraction status,
// validated cited encounters, the undated review group, processing
// limitations, and the caller's verification capability (server-computed).
export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const [record, review] = await Promise.all([
      getStructuredRecord(params.caseId, ctx.firm.id),
      factualReviewState(params.caseId, ctx.firm.id),
    ]);
    const canVerify = canCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    return ok({ ...record, review, canVerify });
  } catch (err) {
    return handleError(err);
  }
}
