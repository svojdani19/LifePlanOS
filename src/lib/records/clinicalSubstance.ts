// ─────────────────────────────────────────────────────────────────────────────
// Does this record document care, or only the paperwork around it?
//
// The Records list showed these as clinical encounters, sitting between a
// laminectomy and a discharge summary with the same weight:
//
//   Undated — 47-year-old male patient record.
//   Undated — Aftercare visit documented with encounter for other specified aftercare.
//   Undated — Laboratory and imaging studies included...
//
// None of them says anything happened to the patient. The first is a
// demographic line off a chart header, the second says a visit occurred without
// saying anything about it, and the third names the categories of study ordered
// without a single result. A reviewer reading the list learns nothing from any
// of them, and their presence makes the list look padded — which is exactly how
// a defence expert reads it.
//
// A clinical entry earns its place with at least one fact a life-care planner
// could act on: a complaint, an examination finding, an assessment, a
// treatment, a procedure, a medication action, a result or impression, a
// functional limitation, a response to treatment, or a disposition.
//
// Nothing is deleted. A record that fails this stays in the document, reachable
// and classified for what it is, and the source page is still one click away.
// What it loses is the right to be listed as an encounter.
// ─────────────────────────────────────────────────────────────────────────────

/** Claim fields that can carry a fact worth planning around. */
const MEANINGFUL_FIELD = new Set([
  "subjective",
  "objectiveFindings",
  "assessment",
  "treatment",
  "procedure",
  "medications",
  "diagnosticStudies",
  "impression",
  "operativeFindings",
  "preOperativeDiagnosis",
  "postOperativeDiagnosis",
  "responseToTreatment",
  "functionalStatus",
  "restrictions",
  "disposition",
  "complications",
  "anesthesia",
  "pathologicDiagnosis",
  "mechanism",
  "imagingFindings",
]);

/**
 * A statement about who the patient is rather than what happened to them.
 *
 * "47-year-old male patient record" is the chart header, and it reached the
 * clinical list as an encounter in its own right.
 */
const DEMOGRAPHIC =
  /^\W*(?:the\s+)?(?:patient\s+(?:is|was)\s+)?(?:a\s+)?\d{1,3}[-\s]?(?:year|yr)[-\s]?old\b[^.]*\.?\s*$|^\W*patient\s+(?:is|was)\s+(?:male|female)\b[^.]*\.?\s*$|^\W*(?:sex|gender|age|dob|date\s+of\s+birth)\s*[:=]|^\W*\d{1,3}\s*(?:yo|y\/o)\b/i;

/** Chart plumbing: identifiers, headers, transmission furniture. */
const ADMINISTRATIVE_TEXT =
  /^\W*(?:(?:medical\s+)?record\s+(?:number|no|id)|mrn|account\s+(?:number|no)|patient\s+(?:id|identifier|information|record|name)|chart\s+(?:number|id)|visit\s+id|encounter\s+id|facility\s+(?:name|id)|fax(?:ed)?|transmitted|page\s+\d+|printed|date\s+printed|confidentiality|this\s+(?:document|transmission)|cover\s+(?:sheet|page))\b/i;

/**
 * A statement that a visit happened, saying nothing about it.
 *
 * "Aftercare visit documented with encounter for other specified aftercare" is
 * an ICD code read back as a sentence. It names the reason for the encounter
 * and stops.
 */
const GENERIC_VISIT =
  /^\W*(?:[a-z\s]{0,30}(?:visit|encounter|appointment|consultation|admission|record)\s+(?:documented|noted|occurred|completed|performed|recorded)\b|(?:office|clinic|follow[\s-]?up|aftercare|routine)\s+(?:visit|encounter)\b(?:[^.]*\bfor\b\s+(?:other|unspecified)\b)?)[^.]*\.?\s*$/i;

/**
 * Categories of study without a single result.
 *
 * "Laboratory and imaging studies included CBC, CMP and radiographs" lists what
 * was ordered. A planner needs what came back.
 */
const STUDY_CATEGORIES =
  /\b(?:laborator(?:y|ies)|imaging|diagnostic|radiolog(?:y|ic))\b[^.]{0,80}\b(?:stud(?:y|ies)|test(?:s|ing)?|work[\s-]?up|panel)\b/i;

/** Something a result actually says: a value, a finding, an impression. */
const CARRIES_A_RESULT =
  /\b(?:\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|mmol|mEq|mm|cm|%|mg\/dL|mmol\/L|units?|lbs?|kg|bpm|mmHg)|impression|findings?|showed?|demonstrat\w+|reveal\w+|consistent\s+with|no\s+(?:acute|evidence|fracture)|positive|negative|normal|abnormal|elevated|decreased|within\s+normal\s+limits|wnl)\b/i;

export type InsubstantialReason =
  | "DEMOGRAPHIC_ONLY"
  | "ADMINISTRATIVE_ONLY"
  | "GENERIC_VISIT_ONLY"
  | "STUDY_CATEGORIES_ONLY"
  | "NO_CLINICAL_FIELD"
  | "NO_CONTENT";

export type SubstanceVerdict =
  | { meaningful: true; facts: number }
  | { meaningful: false; reason: InsubstantialReason };

export interface SubstanceClaim {
  field: string;
  value: string;
}

/**
 * Whether a claim states something that happened to the patient.
 *
 * Exported because the entry writer needs the same judgement: a section built
 * only from vacuous claims should not be written as prose.
 */
export function claimIsSubstantive(claim: SubstanceClaim): boolean {
  const value = (claim.value ?? "").trim();
  if (value.length < 3) return false;
  if (!MEANINGFUL_FIELD.has(claim.field)) return false;
  if (DEMOGRAPHIC.test(value)) return false;
  if (ADMINISTRATIVE_TEXT.test(value)) return false;
  if (GENERIC_VISIT.test(value)) return false;
  // A study list earns its place only by carrying what the study found.
  if (STUDY_CATEGORIES.test(value) && !CARRIES_A_RESULT.test(value)) return false;
  return true;
}

/**
 * Whether these claims amount to a clinical encounter.
 *
 * The reason for a refusal is kept and shown, so a reviewer can tell a record
 * the program judged empty from one it never read.
 */
export function clinicalSubstanceOf(claims: readonly SubstanceClaim[]): SubstanceVerdict {
  if (!claims.length) return { meaningful: false, reason: "NO_CONTENT" };

  const facts = claims.filter(claimIsSubstantive).length;
  if (facts > 0) return { meaningful: true, facts };

  // Nothing substantive. Say which kind of nothing, in the order that reads
  // most usefully to someone deciding whether the source is worth opening.
  const inMeaningfulField = claims.filter((c) => MEANINGFUL_FIELD.has(c.field));
  if (!inMeaningfulField.length) return { meaningful: false, reason: "NO_CLINICAL_FIELD" };

  const values = inMeaningfulField.map((c) => (c.value ?? "").trim()).filter(Boolean);
  if (!values.length) return { meaningful: false, reason: "NO_CONTENT" };

  if (values.every((v) => DEMOGRAPHIC.test(v))) return { meaningful: false, reason: "DEMOGRAPHIC_ONLY" };
  if (values.every((v) => ADMINISTRATIVE_TEXT.test(v))) return { meaningful: false, reason: "ADMINISTRATIVE_ONLY" };
  if (values.every((v) => STUDY_CATEGORIES.test(v) && !CARRIES_A_RESULT.test(v))) {
    return { meaningful: false, reason: "STUDY_CATEGORIES_ONLY" };
  }
  if (values.every((v) => GENERIC_VISIT.test(v))) return { meaningful: false, reason: "GENERIC_VISIT_ONLY" };

  // A mixture of the above, none of it a fact.
  return { meaningful: false, reason: "GENERIC_VISIT_ONLY" };
}

/** What the Records list should say in place of prose it should not write. */
export const INSUFFICIENT_DETAIL = "Insufficient clinical detail extracted — review source.";

/** A reviewer-facing sentence for why a record is not listed as an encounter. */
export function explainInsubstantial(reason: InsubstantialReason): string {
  switch (reason) {
    case "DEMOGRAPHIC_ONLY":
      return "Demographic information only — no clinical event documented.";
    case "ADMINISTRATIVE_ONLY":
      return "Administrative or record-keeping content only.";
    case "GENERIC_VISIT_ONLY":
      return "States that a visit occurred without documenting its content.";
    case "STUDY_CATEGORIES_ONLY":
      return "Names studies ordered without reporting any result.";
    case "NO_CLINICAL_FIELD":
      return "No clinical assertion was extracted from this source.";
    case "NO_CONTENT":
      return "No content was extracted from this source.";
  }
}
