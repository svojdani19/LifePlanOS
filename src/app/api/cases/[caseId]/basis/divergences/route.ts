import { requireApiContext, requireCanonicalPermission, requireCase } from "@/lib/tenant";
import { hasVerifiedCredential } from "@/lib/authz/credentialGate";
import { basisDivergencesDetailed } from "@/lib/engine/validation";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// The divergences on a case, with what a reviewer needs to judge one.
//
// The reconcile endpoint had no way to be reached: nothing listed the
// divergences, so nothing could offer the action. This is that list — each
// entry naming the item, BOTH READINGS in clinical terms — what the recorded
// basis says and what the current record derives — the field-level differences
// between them, whether it is reconcilable at all, and whether it already has
// been. Hashes travel too, as audit metadata rather than as the thing a
// reviewer is asked to judge.
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

    // The DETAILED form: both readings in clinical terms, plus the field-level
    // differences. Returning hashes alone made the reconciliation control ask a
    // physician to sign off on two hex strings.
    const divergences = await basisDivergencesDetailed(params.caseId);
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
