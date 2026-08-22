/**
 * Closing a basis divergence.
 *
 * BASIS_STALE and BASIS_MISSING are not opinions about the plan; they are the
 * statement that the document about to be exported and the record it claims to
 * rest on are different objects. The generic finding route let anyone holding
 * report.export or case.edit mark them RESOLVED_AS_IS or IGNORED, and the
 * export gate counts only OPEN blocking findings — so two clicks turned "this
 * report does not match its record" into a clean final export, with the
 * mismatch still there and now invisible.
 *
 * A divergence can close two ways and no others:
 *
 *   1. The plan is regenerated and the hashes agree. The finding disappears
 *      because the condition that produced it is gone.
 *   2. A credentialed physician reconciles it explicitly, recording which
 *      basis they reconciled to, who they are, the credential they hold, why,
 *      and when.
 *
 * Neither is a status override. Final export re-checks the record itself, so a
 * malformed or legacy disposition cannot buy a release either.
 */

/** The result-code prefixes validation writes for a basis divergence. */
export const BASIS_FINDING_PREFIXES = ["BASIS_STALE", "BASIS_MISSING"] as const;

/** Is this finding a statement that the plan and its record disagree? */
export function isBasisDivergenceFinding(result: string | null | undefined): boolean {
  const r = String(result ?? "");
  return BASIS_FINDING_PREFIXES.some((p) => r === p || r.startsWith(`${p}:`));
}

/** Dispositions the generic route offers. None of them may close a divergence. */
export type GenericDisposition = "resolve_as_is" | "ignore" | "accept_changes" | "reopen";

export interface DispositionVerdict {
  allowed: boolean;
  /** Why not, in the words the caller should show. Null when allowed. */
  reason: string | null;
}

/**
 * May this generic disposition be applied to this finding?
 *
 * `reopen` stays available: moving a finding BACK to OPEN is strictly
 * safe-direction and is how a mistakenly-dispositioned legacy row is repaired.
 * Everything else is refused for a basis divergence — including
 * accept_changes, which applies a deterministic correction that has nothing to
 * do with a hash mismatch and would merely re-run validation and leave the
 * divergence standing.
 */
export function dispositionAllowed(result: string | null | undefined, action: GenericDisposition): DispositionVerdict {
  if (!isBasisDivergenceFinding(result)) return { allowed: true, reason: null };
  if (action === "reopen") return { allowed: true, reason: null };
  return {
    allowed: false,
    reason:
      "A recorded-basis divergence cannot be resolved as-is or ignored: it states that this plan and the record it rests on are different objects, and dispositioning it would hide the mismatch rather than settle it. Regenerate the plan so the recorded and current bases agree, or have a credentialed physician reconcile the recommendation explicitly.",
  };
}

export interface ReconciliationInput {
  caseId: string;
  firmId: string;
  futureCareItemId: string;
  /** The hash the reviewer is reconciling TO — the basis currently recorded. */
  recordedHash: string | null;
  /** The hash the current record derives. */
  derivedHash: string;
  actorUserId: string;
  credentialLabel: string;
  reason: string;
}

/** A reconciliation must say what was reconciled and why, or it records nothing. */
export function validateReconciliation(input: ReconciliationInput): string | null {
  if (!input.reason.trim()) return "A reconciliation must record why the divergence is acceptable.";
  if (input.reason.trim().length < 12) return "Record a substantive reason: a reconciliation is a clinical judgment on the record.";
  if (!input.derivedHash) return "A reconciliation needs the current derived basis to reconcile against.";
  if (!input.credentialLabel) return "A reconciliation must be attributed to a verified credential.";
  return null;
}
