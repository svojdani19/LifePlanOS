// ─────────────────────────────────────────────────────────────────────────────
// May this record be attested as it stands — and whose answer is current?
//
// Two questions were being conflated, and the conflation made a corrected
// record permanently unexportable.
//
//   • WHAT THE MACHINE GRADED. `auditResult` records how the extraction's own
//     adversarial audit judged the DRAFT it produced. It is history and stays
//     stored: a case file may never lose the fact that the first reading of
//     this page failed.
//
//   • WHAT IS TRUE NOW. Once a person has edited, reviewed or verified the
//     row, they are the authority on it. The grade still describes the draft
//     they replaced; it does not describe their work.
//
// The final-export gate asked only the first question, of every current row.
// So an entry that failed extraction, was corrected by a physician and signed,
// went on blocking the export for ever — with a message telling the reviewer
// the extraction had failed, which they already knew and had already fixed.
// The only escape was to reject the record, i.e. to delete corrected work.
//
// The correction is NOT "trust the human about everything". A live
// disagreement is not answered by anyone's status:
//
//   • a row the factual audit never graded at all still blocks. "No audit" is
//     not "a clean audit", and a batch that treated it as one would delete the
//     required-audit safeguard: mark the row REVIEWED and the human-authority
//     rule above then hides the fact that nobody, machine or person, ever
//     checked it against its source;
//   • an unresolved extraction dispute still blocks;
//   • a field the source contradicts still blocks — until a human corrects
//     THAT FIELD, which is exactly what the card's own instructions tell them
//     to do, and which was previously a dead end because nothing read the
//     correction back;
//   • content drift, open blocking findings, and document/page/case blockers
//     are all judged elsewhere and are untouched by anything here.
//
// Nothing in this module is stored or mutated. It reads persisted history and
// says what it means now, so the history survives and the answer is current.
// Pure and synchronous, and shared by the individual review endpoint, the
// batch confirmation and the final gate — three places that must not hold
// three opinions about whether a record is sound.
// ─────────────────────────────────────────────────────────────────────────────

/** States in which a PERSON's own work governs the row, not the machine's grade. */
export const HUMAN_AUTHORITATIVE_STATES: readonly string[] = ["HUMAN_EDITED", "REVIEWED", "VERIFIED"];

/** A row, as the integrity rules need it. Narrow on purpose. */
export interface IntegrityRow {
  id: string;
  status: string;
  auditResult?: string | null;
  /**
   * The audit version that graded this row. Null means the run predated
   * dispute columns and recorded no reason for its grade — a caution to check,
   * not a defect to correct.
   */
  auditVersion?: string | null;
  unresolvedDisputes?: number | null;
  /** Fields adjudication confirmed the source contradicts. History. */
  contradictedFields?: unknown;
  /** Fields a human has since corrected. History, and the answer to the above. */
  editedFields?: unknown;
}

/** A reason a record may not be attested, with a stable code for counting. */
export interface IntegrityProblem {
  code: string;
  reason: string;
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Which contradiction each corrected field answers.
 *
 * Deliberately narrow. Adjudication names the fields it contradicts in its own
 * vocabulary ("date", "provider"), and the correction endpoints name them in
 * the column's ("encounterDate"). Only an exact correspondence counts: editing
 * the free-text summary is not an answer to a contradicted date, and treating
 * it as one would clear a real conflict nobody looked at.
 */
const CORRECTION_ANSWERS: Record<string, readonly string[]> = {
  encounterDate: ["date", "encounterdate"],
  provider: ["provider"],
  providerCredentials: [],
  facility: ["facility"],
  encounterType: ["encountertype"],
  analysisClass: ["analysisclass"],
  substanceClass: ["substanceclass"],
};

/** Does a person's own work govern this row now? */
export function humanAuthoritative(row: Pick<IntegrityRow, "status">): boolean {
  return HUMAN_AUTHORITATIVE_STATES.includes(row.status);
}

/**
 * Does the machine's audit grade still describe this row?
 *
 * False once a human has edited, reviewed or verified it. The grade is kept —
 * it is what the extraction found — but it stops being the current verdict on
 * content a person has since taken responsibility for.
 */
export function machineGradeGoverns(row: Pick<IntegrityRow, "status">): boolean {
  return !humanAuthoritative(row);
}

/**
 * The contradictions that are still open.
 *
 * A field a human has corrected is a contradiction a human has answered: the
 * card told them to "open the cited page and set the date from what the record
 * actually says", and they did. Nothing read that back, so the row stayed
 * conflicted for ever and the instruction was a dead end.
 *
 * The stored list is never rewritten. This is a reading of it.
 */
export function liveContradictedFields(row: Pick<IntegrityRow, "contradictedFields" | "editedFields">): string[] {
  const contradicted = asStrings(row.contradictedFields);
  if (!contradicted.length) return [];
  const answered = new Set(
    asStrings(row.editedFields).flatMap((field) => CORRECTION_ANSWERS[field] ?? []),
  );
  return contradicted.filter((field) => !answered.has(field.toLowerCase().replace(/[^a-z]/g, "")));
}

/**
 * Why this row may not receive a clean attestation, as it stands now.
 *
 * The exact checks the individual group-review endpoint has always enforced,
 * lifted out so the batch confirmation and the final gate ask the SAME
 * question rather than three similar ones. A REJECT is still permitted over
 * any of these — disposing of an entry is how an unsupportable one is
 * resolved — so callers apply this only to review, verify and confirm.
 */
export function attestationBlockers(row: IntegrityRow): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];

  // The machine's grade, applied only while the machine's draft is what the
  // row still holds.
  if (machineGradeGoverns(row)) {
    // NO grade at all. Distinguished from every graded outcome, including the
    // ones a reviewer is deliberately allowed to attest over: a document that
    // is incomplete around a sound entry, an old conflict whose reason was
    // never recorded, a low-confidence page, a review flag — those were all
    // checked and reported. This row was not checked.
    if (!row.auditResult) {
      problems.push({
        code: "UNAUDITED",
        reason: "the factual audit never graded this entry; correct it from its cited page, reject it, or re-extract the document",
      });
    }
    if (row.auditResult === "FAILED") {
      problems.push({ code: "AUDIT_FAILED", reason: "the audit ended as a failure; correct or reject this entry first" });
    }
    // A source conflict is refused when the run that graded it RECORDED what
    // the conflict was — there is a specific thing to correct. A conflict from
    // a run predating dispute columns records nothing to correct, only
    // something to check, and checking an entry against its cited page is
    // exactly what attestation is.
    if (row.auditResult === "SOURCE_CONFLICT" && row.auditVersion != null) {
      problems.push({ code: "SOURCE_CONFLICT", reason: "the audit recorded a source conflict for this entry; correct or reject it first" });
    }
  }

  // Live disagreements. Not answered by anybody's status: a dispute nobody
  // settled is still unsettled however the row is labelled.
  if ((row.unresolvedDisputes ?? 0) > 0) {
    problems.push({ code: "UNRESOLVED_DISPUTE", reason: "an extraction disagreement about this entry is unresolved" });
  }
  const contradicted = liveContradictedFields(row);
  if (contradicted.length) {
    problems.push({
      code: "CONTRADICTED_FIELD",
      reason: `the source contradicts ${contradicted.join(", ")}; correct it before attesting`,
    });
  }

  return problems;
}
