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

/**
 * The identity a basis finding carries, encoded in its result code.
 *
 * The first version wrote `BASIS_STALE:<last12>-><last12>` and recovered the
 * item by looking its SERVICE NAME up in a map. Two defects followed. A case
 * with two recommendations of the same service resolved both to whichever id
 * the map happened to keep, so a reconciliation of one silently covered the
 * other. And twelve trailing hex characters is not a hash: matching on it means
 * a reconciliation is accepted for any divergence whose derived hash merely
 * ends the same way, and the RECORDED side was not compared at all.
 *
 * The item's immutable id and both full hashes now travel in the code itself.
 * Nothing downstream has to infer identity, and `persistCaseValidation` still
 * carries dispositions across re-runs on (service, result) — with the whole
 * identity in `result`, a different divergence is necessarily a different
 * finding and reopens as OPEN.
 */
export interface BasisFindingIdentity {
  state: "STALE" | "MISSING";
  futureCareItemId: string;
  /** Null only for MISSING, where by definition nothing was recorded. */
  recordedHash: string | null;
  derivedHash: string;
}

const NONE = "none";

export function encodeBasisFinding(id: BasisFindingIdentity): string {
  return `BASIS_${id.state === "MISSING" ? "MISSING" : "STALE"}:${id.futureCareItemId}:${id.recordedHash ?? NONE}->${id.derivedHash}`;
}

/**
 * Recover the identity, or null when the code is not one of ours.
 *
 * Returns null for the legacy short-tail codes too. That is deliberate: a
 * legacy finding cannot be matched to a reconciliation with any confidence, and
 * treating it as unmatched keeps it blocking, which is the safe direction.
 */
export function decodeBasisFinding(result: string | null | undefined): BasisFindingIdentity | null {
  const r = String(result ?? "");
  const m = /^BASIS_(STALE|MISSING):([^:]+):(.+)->(.+)$/.exec(r);
  if (!m) return null;
  const [, state, futureCareItemId, recorded, derived] = m;
  if (!futureCareItemId || !derived) return null;
  return {
    state: state === "MISSING" ? "MISSING" : "STALE",
    futureCareItemId,
    recordedHash: recorded === NONE ? null : recorded,
    derivedHash: derived,
  };
}

/**
 * Does this reconciliation cover this exact divergence?
 *
 * Item identity AND both full hashes. A reconciliation is a judgment about one
 * specific pair of readings; if either side has moved since, the reviewer has
 * not seen what the document would now say.
 */
export function reconciliationCovers(
  reconciliation: { futureCareItemId: string; recordedHash: string | null; derivedHash: string },
  divergence: BasisFindingIdentity,
): boolean {
  return (
    reconciliation.futureCareItemId === divergence.futureCareItemId &&
    (reconciliation.recordedHash ?? null) === (divergence.recordedHash ?? null) &&
    reconciliation.derivedHash === divergence.derivedHash
  );
}

/**
 * May this divergence be closed by reconciliation at all?
 *
 * Only a STALE one. MISSING means no authoritative basis exists — there is
 * nothing for a physician to compare the current record against, and no opinion
 * they could form that would supply the missing record. Letting a
 * reconciliation close it would manufacture an authoritative basis out of a
 * signature, which is precisely the bypass this whole mechanism removes. A
 * missing basis is fixed by generating and approving one.
 */
export function reconcilable(state: "STALE" | "MISSING"): { ok: boolean; reason: string | null } {
  if (state === "STALE") return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      "This recommendation has no recorded basis at all, so there is nothing to reconcile against. A reconciliation is a judgment that the current record still supports what was recorded; where nothing was recorded, that judgment has no subject. Regenerate the plan so a basis is recorded, then have it approved.",
  };
}

/**
 * The status a reconciled divergence carries.
 *
 * Distinct from RESOLVED_AS_IS and IGNORED on purpose: those are the generic
 * dispositions this mechanism refuses, and a reader scanning statuses must be
 * able to tell "a physician reconciled this exact pair of readings" from "a
 * planner clicked ignore".
 */
export const RECONCILED_STATUS = "RESOLVED_RECONCILED";

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
  const r = String(result ?? "");
  // BASIS_UNREADABLE belongs here too. It is not a divergence — nothing was
  // compared — but it is the same kind of statement: that the plan's agreement
  // with its record is UNKNOWN. Dispositioning it would close the one signal
  // saying so, and it is not in the divergence prefix set, so it slipped
  // through the check below.
  const unknowable = r === "BASIS_UNREADABLE";
  if (!isBasisDivergenceFinding(result) && !unknowable) return { allowed: true, reason: null };
  if (action === "reopen") return { allowed: true, reason: null };
  if (unknowable) {
    return {
      allowed: false,
      reason:
        "The recorded bases for this case could not be read, so whether this plan matches them is unknown. That is a storage or schema fault, not a judgment a reviewer can make: dispositioning it would close the only signal saying nothing is known. Resolve the fault and re-run the integrity check.",
    };
  }
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


export interface ReconciliationRow {
  futureCareItemId: string;
  recordedHash: string | null;
  derivedHash: string;
  reconciledById: string;
  createdAt: Date;
}

export interface CarriedDisposition {
  status: string;
  resolvedById: string | null;
  resolvedAt: Date | null;
}

/**
 * The status a finding is republished with.
 *
 * A basis divergence derives its status from the reconciliation record on every
 * run, and never from a disposition carried on a string key. Carrying it meant
 * the export gate, the report's draft banner and the independent divergence
 * check could each be reading a different answer to the same question.
 *
 * Everything that is not a basis divergence keeps the disposition behaviour it
 * has always had.
 */
export function statusForFinding(
  result: string,
  reconciliations: readonly ReconciliationRow[],
  carried: CarriedDisposition | undefined,
): CarriedDisposition {
  // "The bases could not be read" cannot be closed by a disposition carried
  // from an older row either. There is no independent divergence check that
  // would catch it — nothing was compared — so a legacy RESOLVED_AS_IS on this
  // key would be the whole bypass, restored.
  if (result === "BASIS_UNREADABLE") return { status: "OPEN", resolvedById: null, resolvedAt: null };

  const identity = decodeBasisFinding(result);
  if (identity) {
    if (!reconcilable(identity.state).ok) return { status: "OPEN", resolvedById: null, resolvedAt: null };
    const match = reconciliations.find((r) => reconciliationCovers(r, identity));
    return match
      ? { status: RECONCILED_STATUS, resolvedById: match.reconciledById, resolvedAt: match.createdAt }
      : { status: "OPEN", resolvedById: null, resolvedAt: null };
  }
  return carried ?? { status: "OPEN", resolvedById: null, resolvedAt: null };
}
