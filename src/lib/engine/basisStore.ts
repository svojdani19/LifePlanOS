/**
 * Reading the recorded bases, and saying so when it fails.
 *
 * Four call sites loaded them as `findMany().catch(() => [])`. An empty array
 * then meant two unrelated things: this case has no recorded bases, or the read
 * did not work. Everything downstream took the first reading.
 *
 * Observed live, against a database whose schema had not caught up: every query
 * failed with P2022, every consumer saw zero bases, the panel rendered witness
 * assessments as though none had ever been recorded, and validation emitted
 * BASIS_MISSING for all thirty-four items — a statement about the record, made
 * by code that had not managed to read the record. The exported document would
 * have said "No recorded basis exists for this recommendation" about a
 * recommendation whose basis existed and was fine.
 *
 * This is the same defect the retrieval and guideline work removed elsewhere: a
 * failure wearing the clothes of an absence. It is worse here, because the
 * absence has a formal meaning that gates exports.
 */

export interface BasisStore {
  recommendationBasis?: { findMany(args: unknown): Promise<unknown[]> };
}

export type BasisLoad =
  | { readable: true; byItem: Map<string, unknown>; count: number }
  | { readable: false; reason: string };

/** Bounded, non-identifying description of a read failure. */
const describe = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "unknown error"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

/**
 * Load every recorded basis for a case.
 *
 * Returns `readable: false` when the store could not be read at all. Callers
 * must branch on it — an unreadable store is not an empty one, and the two
 * licence completely different statements.
 */
export async function loadRecordedBases(db: BasisStore, caseId: string): Promise<BasisLoad> {
  if (!db.recommendationBasis) {
    return { readable: false, reason: "The recommendation-basis store is not available in this client." };
  }
  try {
    const rows = (await db.recommendationBasis.findMany({ where: { caseId } })) as { futureCareItemId: string }[];
    return { readable: true, byItem: new Map(rows.map((b) => [b.futureCareItemId, b as unknown])), count: rows.length };
  } catch (err) {
    return { readable: false, reason: describe(err) };
  }
}

/** The case-wide finding an unreadable store produces. */
export const BASIS_UNREADABLE = "BASIS_UNREADABLE";

export function unreadableBasisFinding(reason: string): {
  service: string;
  result: string;
  issue: string;
  severity: string;
  suggestion: string;
  exportBlocking: boolean;
} {
  return {
    service: "Case-wide",
    result: BASIS_UNREADABLE,
    issue:
      `The recorded bases for this case could not be read, so nothing is known about whether the plan matches them. ` +
      `This is NOT a finding that the recommendations lack a recorded basis — that question was never reached. (${reason})`,
    severity: "Critical",
    // Blocking, and deliberately more blocking than a missing basis: with a
    // missing basis we at least know what we do not have. Here we do not even
    // know that.
    exportBlocking: true,
    suggestion:
      "Resolve the storage or schema fault and re-run the integrity check. Do not treat the recommendations as unrecorded on the strength of this finding.",
  };
}


/**
 * Raised when a caller cannot honestly continue without the recorded bases.
 *
 * Returning an empty result here would be the original defect: the caller would
 * carry on and write, display, or assert something about a record it never
 * read. Every caller that raises this is one whose output would otherwise claim
 * to be recorded.
 */
export class BasisUnreadableError extends Error {
  constructor(caseId: string, reason: string) {
    super(`Recorded bases for case ${caseId} could not be read, so no recorded assessment can be produced: ${reason}`);
    this.name = "BasisUnreadableError";
  }
}
