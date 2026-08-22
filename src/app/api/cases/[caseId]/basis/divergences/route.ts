import { requireApiContext, requireCanonicalPermission, requireCase } from "@/lib/tenant";
import { hasVerifiedCredential } from "@/lib/authz/credentialGate";
import { basisDivergences } from "@/lib/engine/validation";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// The divergences on a case, with what a reviewer needs to judge one.
//
// The reconcile endpoint had no way to be reached: nothing listed the
// divergences, so nothing could offer the action. This is that list — each
// entry naming the item, both full hashes, whether it is reconcilable at all,
// and whether it already has been.
//
// Read-only, and gated at the same level as viewing the plan. Deciding is a
// separate act with a separate gate.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "futurecare.view", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);

    const divergences = await basisDivergences(params.caseId);
    // Whether THIS reader may decide. The reconcile route enforces it again;
    // this only decides whether offering the control makes sense.
    const mayReconcile =
      (await hasVerifiedCredential(ctx, "PHYSICIAN")) &&
      (() => {
        try {
          requireCanonicalPermission(ctx, "physician.review", { caseId: params.caseId });
          return true;
        } catch {
          return false;
        }
      })();

    return ok({ divergences, mayReconcile });
  } catch (err) {
    return handleError(err);
  }
}
