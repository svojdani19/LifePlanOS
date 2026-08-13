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
export const INACTIVE_ENCOUNTER_STATES: readonly EncounterState[] = ["REJECTED", "SUPERSEDED", "EXTRACTION_FAILED"];

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
