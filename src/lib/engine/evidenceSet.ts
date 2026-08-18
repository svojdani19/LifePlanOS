// ─────────────────────────────────────────────────────────────────────────────
// The evidence set: what was RECORDED, and whether it still matches the record.
//
// The ledger was being written and never read. Four places built their own copy
// of a recommendation's evidence — the panel at render time, the report at
// export time, the reasoning narrative, and the generator — and only the
// generator's copy was persisted. Every consumer therefore re-derived evidence
// from whatever the case looked like at that moment, so a plan approved on
// Monday could be printed on Friday over a different set of findings with
// nothing anywhere saying so.
//
// Two things fix that, and they are separate:
//
//   READ MODEL. The persisted rows are what consumers display. Not a cache of
//   the derivation — the derivation's OUTPUT, recorded once, cited once.
//
//   STALENESS. A read model that can silently fall behind is worse than none,
//   so every consumer that shows persisted rows also derives the current set
//   and compares. Equal → CURRENT. Different → STALE, with the counts. Nothing
//   persisted at all → MISSING. The comparison is shown, never resolved
//   silently: which set is right is a question about the case, and answering it
//   is a person's job.
//
// The fingerprint is FNV-1a rather than a crypto digest, deliberately: this is
// a change detector that has to run identically in the browser (the panel) and
// on the server (the report), and nothing here is a security boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { EVIDENCE_LEDGER_VERSION } from "@/lib/engine/evidenceLedger";

/** The identity-bearing fields of one ledger row. Ids and timestamps are not
 *  part of it: re-persisting the same evidence must not read as a change. */
export interface EvidenceRowIdentity {
  claim: string;
  stance: string;
  strength: string;
  sourceKind: string;
  quote: string;
}

export const evidenceRowKey = (r: EvidenceRowIdentity): string =>
  [r.claim, r.stance, r.strength, r.sourceKind, r.quote.replace(/\s+/g, " ").trim()].join("|");

/** FNV-1a, 32-bit, hex. Deterministic across runtimes; not a digest. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A stable fingerprint of an evidence set.
 *
 * Order-independent (sorted) so a change in how candidates happen to be
 * enumerated is not reported as a change in the evidence, and version-prefixed
 * so a change to the BUILDER stales every set it produced — which is correct:
 * the same records read by different rules are a different evidence set.
 */
export function evidenceSetFingerprint(rows: readonly EvidenceRowIdentity[]): string {
  const keys = rows.map(evidenceRowKey).sort();
  return `${EVIDENCE_LEDGER_VERSION}:${keys.length}:${fnv1a(keys.join("\n"))}`;
}

export type EvidenceSetState =
  /** The persisted set is exactly what the current record produces. */
  | "CURRENT"
  /** Persisted, but the record has moved since. Both counts are reported. */
  | "STALE"
  /** Nothing was ever persisted for this recommendation. */
  | "MISSING";

export interface EvidenceSetStatus {
  state: EvidenceSetState;
  persistedCount: number;
  derivedCount: number;
  /** Rows the current record produces that the persisted set does not hold. */
  added: number;
  /** Rows the persisted set holds that the current record no longer produces. */
  removed: number;
  fingerprint: string;
  persistedFingerprint: string | null;
}

/**
 * Compare what was recorded against what the case produces now.
 *
 * PHYSICIAN rows are excluded by the caller, not here: a hand-entered citation
 * is not derived from anything, so its presence or absence says nothing about
 * whether the derivation is current.
 */
export function compareEvidenceSets(
  persisted: readonly EvidenceRowIdentity[],
  derived: readonly EvidenceRowIdentity[],
): EvidenceSetStatus {
  const derivedFp = evidenceSetFingerprint(derived);
  if (!persisted.length) {
    return {
      state: "MISSING",
      persistedCount: 0,
      derivedCount: derived.length,
      added: derived.length,
      removed: 0,
      fingerprint: derivedFp,
      persistedFingerprint: null,
    };
  }
  const persistedFp = evidenceSetFingerprint(persisted);
  const pKeys = new Set(persisted.map(evidenceRowKey));
  const dKeys = new Set(derived.map(evidenceRowKey));
  let added = 0;
  let removed = 0;
  for (const k of dKeys) if (!pKeys.has(k)) added++;
  for (const k of pKeys) if (!dKeys.has(k)) removed++;
  return {
    state: persistedFp === derivedFp ? "CURRENT" : "STALE",
    persistedCount: persisted.length,
    derivedCount: derived.length,
    added,
    removed,
    fingerprint: derivedFp,
    persistedFingerprint: persistedFp,
  };
}

/** What a reader is told, in words rather than a state name. */
export function describeEvidenceSet(status: EvidenceSetStatus): string | null {
  if (status.state === "CURRENT") return null;
  if (status.state === "MISSING")
    return "No evidence ledger has been recorded for this recommendation. What is shown below is derived from the record as it stands now and has not been filed against this plan — regenerate the plan to record it.";
  const parts: string[] = [];
  if (status.added) parts.push(`${status.added} finding${status.added === 1 ? "" : "s"} the record now supplies`);
  if (status.removed) parts.push(`${status.removed} the record no longer supplies`);
  return `The recorded evidence for this recommendation no longer matches the record: ${parts.join(", ")}. The recorded set is shown; regenerate the plan to bring it current.`;
}
