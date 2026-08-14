// ─────────────────────────────────────────────────────────────────────────────
// Which extracted rows still describe the case.
//
// Three consumers each answered this differently, and one of them was the
// canonical records builder:
//
//   structuredRecord.ts   status IN (AI_DRAFT, AI_AUDIT_PASSED, HUMAN_EDITED,
//                                    REVIEWED, VERIFIED, STALE)
//   extractionRun.ts      status NOT IN (SUPERSEDED)   — lets a FAILED row through
//   buildRecords.ts       no filter at all             — lets SUPERSEDED through
//
// So a row replaced by re-extraction, or rejected by a reviewer, still reached
// the Records list and the chronology, while the structured record used for
// reasoning and reporting excluded it. The same case described two ways
// depending on which module was asked, and a rejection did not stick.
//
// This is the one definition. Rows are never deleted — lineage is the audit
// trail — so "active" is a question about status and succession, not existence.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every lifecycle state an extracted encounter may hold.
 *
 * Listed exhaustively rather than as a string so that adding a state forces a
 * decision here about whether it is active, which is how the divergence above
 * arose: two of the three filters were written as deny-lists and silently
 * admitted every state invented afterwards.
 */
export const ENCOUNTER_STATES = [
  "AI_DRAFT",
  "AI_AUDIT_PASSED",
  "HUMAN_EDITED",
  "REVIEWED",
  "VERIFIED",
  "STALE",
  "REJECTED",
  "SUPERSEDED",
  "EXTRACTION_FAILED",
  "GENERATION_LOSS",
] as const;

export type EncounterState = (typeof ENCOUNTER_STATES)[number];

/**
 * States whose rows still describe the case.
 *
 * STALE is active on purpose: a reviewed row whose source changed still holds
 * human work and must stay visible, flagged, until someone re-reviews it.
 * Dropping it would quietly discard the review.
 */
export const ACTIVE_ENCOUNTER_STATES: readonly EncounterState[] = [
  "AI_DRAFT",
  "AI_AUDIT_PASSED",
  "HUMAN_EDITED",
  "REVIEWED",
  "VERIFIED",
  "STALE",
];

/**
 * States whose rows are history.
 *
 * REJECTED is a reviewer saying this is not a record of this patient's care.
 * SUPERSEDED is a row replaced by a later extraction of the same source.
 * EXTRACTION_FAILED never produced trustworthy content in the first place.
 */
/**
 * GENERATION_LOSS is a prior machine result the current extraction did not
 * reproduce. It is NOT active: a fact the current extraction cannot reproduce
 * must not remain part of the current chronology merely because an earlier
 * model generated it. It is also not SUPERSEDED — nothing replaced it — and
 * not STALE, which marks HUMAN work whose source changed and stays visible
 * precisely because a person put their name to it. The row is kept, with its
 * lineage and a reason, for a reviewer to confirm or restore through the
 * existing review action; until a human does, it contributes nothing
 * downstream.
 */
export const INACTIVE_ENCOUNTER_STATES: readonly EncounterState[] = [
  "REJECTED",
  "SUPERSEDED",
  "EXTRACTION_FAILED",
  "GENERATION_LOSS",
];

export interface LifecycleRow {
  status?: string | null;
  /** Set when a later row replaced this one. */
  supersededById?: string | null;
}

/**
 * Does this row still describe the case?
 *
 * A row carrying a successor is history whatever its status says: the two
 * fields can disagree when a supersede is recorded before the status write
 * lands, and the successor's existence is the stronger evidence.
 */
export function isActiveEncounter(row: LifecycleRow): boolean {
  if (row.supersededById) return false;
  const status = (row.status ?? "AI_DRAFT") as EncounterState;
  // An unrecognised state is treated as INACTIVE. A state nobody has classified
  // is not one to feed into a medico-legal document on the assumption it is
  // fine; the deny-list habit is what produced the divergence this replaces.
  return (ACTIVE_ENCOUNTER_STATES as readonly string[]).includes(status);
}

/**
 * The Prisma `where` fragment for active rows.
 *
 * Every query that loads encounters for downstream records must spread this, so
 * the definition cannot drift between modules again.
 */
export const ACTIVE_ENCOUNTER_WHERE = {
  status: { in: ACTIVE_ENCOUNTER_STATES as unknown as string[] },
  supersededById: null,
} as const;

/** Rows that still describe the case, from a set that may include history. */
export function activeEncounters<T extends LifecycleRow>(rows: readonly T[]): T[] {
  return rows.filter(isActiveEncounter);
}

// ── Two different questions the one "active" list was answering ──────────────
//
// "May this row contribute to what the case SAYS?" and "must a reviewer still
// SEE this row?" are different questions with different answers for STALE: a
// reviewed row whose source changed must stay visible — a person put their
// name to it — and must NOT feed newly generated output, because its claims
// describe a version of the source that no longer exists. Treating the two
// questions as one let stale wording flow into fresh summaries.

/**
 * Rows that may contribute to current output: Records summaries, the
 * chronology, clinical reasoning, care recommendations, reports and exports.
 *
 * STALE is deliberately absent. Its human work is protected by VISIBILITY and
 * by the review workflow, not by continuing to publish claims about a source
 * that changed underneath them.
 */
export const CURRENT_OUTPUT_STATES: readonly EncounterState[] = [
  "AI_DRAFT",
  "AI_AUDIT_PASSED",
  "HUMAN_EDITED",
  "REVIEWED",
  "VERIFIED",
];

/**
 * Rows the review experience must show: everything current, plus the two
 * states waiting on a human — STALE human work needing re-review, and
 * GENERATION_LOSS machine candidates needing confirmation. History (rejected,
 * superseded, failed) stays history.
 */
export const REVIEW_VISIBLE_STATES: readonly EncounterState[] = [
  ...CURRENT_OUTPUT_STATES,
  "STALE",
  "GENERATION_LOSS",
];

/** The states a reviewer must resolve before factual review can complete. */
export const REVIEW_BLOCKING_STATES: readonly EncounterState[] = ["STALE", "GENERATION_LOSS"];

export function isCurrentOutput(row: LifecycleRow): boolean {
  if (row.supersededById) return false;
  return (CURRENT_OUTPUT_STATES as readonly string[]).includes((row.status ?? "AI_DRAFT") as string);
}

export const CURRENT_OUTPUT_WHERE = {
  status: { in: CURRENT_OUTPUT_STATES as unknown as string[] },
  supersededById: null,
} as const;

export const REVIEW_VISIBLE_WHERE = {
  status: { in: REVIEW_VISIBLE_STATES as unknown as string[] },
  supersededById: null,
} as const;
