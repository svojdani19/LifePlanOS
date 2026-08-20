// ─────────────────────────────────────────────────────────────────────────────
// The boundary between a TEACHER and a WITNESS.
//
// A professionally finalized life care plan is the answer key. It says what an
// experienced planner concluded from a record set, and that makes it the most
// valuable document a case can carry — for LEARNING. It is not evidence about
// the patient, because it is not a record of care: it is somebody's opinion
// about care, written after the fact, citing the same records the generator is
// already reading.
//
// Mining it as though it were a record is the worst failure this system can
// make, and it is silent. Every recommendation would appear "record-supported",
// every objective finding would be "documented", and the plan the program
// produced would be a paraphrase of the plan it was shown — presented to a
// physician as independent work, and defended in a deposition as such.
//
// Two things were true at the head of this branch:
//
//   • `generate.ts` read EVERY document on the case with no type filter and
//     passed them all to `locateConditionEvidence`, so an attached expert
//     report or finalized plan became causation evidence;
//   • the chronology's exclusion list covered EXPERT_REPORT but not
//     LIFE_CARE_PLAN, so a finalized plan could be chronicled as treatment.
//
// This module is the single place that answers "may this document speak about
// the patient?", so the two lists cannot drift apart again.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Document types that are OPINION ABOUT a case rather than RECORD OF it.
 *
 * These may be stored, displayed, cited as what they are, and learned from
 * under the fact-free rules in `src/lib/learning`. They may never contribute a
 * diagnosis, an objective finding, a chronology event, a treating-provider
 * recommendation, or condition evidence.
 */
export const REFERENCE_DOC_TYPES: ReadonlySet<string> = new Set([
  /** A finalized life care plan — the answer key itself. */
  "LIFE_CARE_PLAN",
  /** A retained expert's report: opinion, and often a restatement of records. */
  "EXPERT_REPORT",
  /** A cost projection derived from a plan, not from care delivered. */
  "COST_PROJECTION",
  /** Another reviewer's opinion on care already given. */
  "PEER_REVIEW",
]);

/** May this document's text be mined for facts ABOUT THE PATIENT? */
export function isRecordEvidenceSource(doc: { type?: string | null }): boolean {
  return !REFERENCE_DOC_TYPES.has(String(doc.type ?? ""));
}

/** The reference documents in a set, for disclosure rather than for mining. */
export function referenceDocuments<T extends { type?: string | null }>(docs: readonly T[]): T[] {
  return docs.filter((d) => !isRecordEvidenceSource(d));
}

/**
 * Keep only the documents that may speak about the patient.
 *
 * Named for what it guarantees rather than what it filters, because every
 * caller is asserting the guarantee: whatever this returns is safe to treat as
 * a record of care.
 */
export function recordEvidenceSources<T extends { type?: string | null }>(docs: readonly T[]): T[] {
  return docs.filter(isRecordEvidenceSource);
}

/**
 * Item origins that are REFERENCE content — a published plan's own line items,
 * preserved for scoring and learning.
 *
 * `GOLD_IMPORT` was previously listed among the authored origins that survive a
 * regeneration, which is how a published plan's 37 items came to live inside a
 * case's active plan, inside its totals, and inside the gold harness's own
 * input — the answer key scoring itself.
 */
export const REFERENCE_ITEM_ORIGINS: ReadonlySet<string> = new Set(["GOLD_IMPORT"]);

export const isReferenceOrigin = (origin: string | null | undefined): boolean =>
  REFERENCE_ITEM_ORIGINS.has(String(origin ?? ""));
