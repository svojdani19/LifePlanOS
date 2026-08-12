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
 * Words that only describe who the patient is.
 *
 * The first attempt at this matched the SHAPE of the sentences in the bug
 * report — "47-year-old male patient record" — and missed "Male patient, age
 * 47", which is what the extractor actually produces and which begins with
 * neither a number nor "patient is". Matching shapes means writing a pattern
 * per phrasing and losing to the next one.
 *
 * So the test is coverage instead: strike out every word that carries only
 * demographic meaning, and see whether anything is left. A claim made entirely
 * of these words says nothing happened to the patient, however it is worded.
 */
const DEMOGRAPHIC_WORD =
  /\b(?:a|an|the|this|patient|pt|client|male|female|man|woman|gentleman|lady|yo|y\/o|year|years|yr|yrs|old|age|aged|sex|gender|dob|date|of|birth|record|records|contact|encounter|entry|note|is|was|be|being|with|and|for|presented|presents|identified|documented|noted|listed)\b/gi;

/** A statement about who the patient is rather than what happened to them. */
function isDemographic(value: string): boolean {
  const residue = value
    .replace(DEMOGRAPHIC_WORD, " ")
    .replace(/\d+/g, " ")
    .replace(/[^A-Za-z]+/g, " ")
    .trim();
  return residue.length < 3;
}

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

/**
 * A billing code read back as a clinical statement.
 *
 * "Urinalysis (82962)", "Diagnoses coded: M5450, M5126", "Encounter for
 * aftercare (Z4889) noted on claim" — these come off claim lines, and the words
 * in them are the code's official descriptor rather than anything a clinician
 * wrote about this patient. A ledger of them became an entry reading
 * "Laboratory and imaging studies including comprehensive metabolic panel",
 * which is the summary of a bill, not of care.
 *
 * The bill still matters and is still kept; it is simply not an encounter.
 */
const CODE_REFERENCE =
  /\b(?:cpt|hcpcs|icd(?:-?\s?10)?(?:-?cm)?)\b|\(\s*[A-TV-Z]?\d{4,5}(?:\.\d+)?\s*\)|\b[A-TV-Z]\d{2}\.?\d{0,4}\b/i;

const BILLING_CONTEXT = /\b(?:coded|codes?\s*:|on\s+claim|billed|charge[ds]?|units?|modifier|allowed\s+amount)\b/i;

function isCodeReference(value: string): boolean {
  if (!CODE_REFERENCE.test(value)) return false;
  // The descriptor a code ships with, and nothing else: strip the code, the
  // billing words and the punctuation, and see how much of a sentence is left.
  const residue = value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:cpt|hcpcs|icd(?:-?\s?10)?(?:-?cm)?)\b/gi, " ")
    .replace(/\b[A-TV-Z]\d{2}\.?\d{0,4}\b/g, " ")
    .replace(/\b\d{4,5}\b/g, " ")
    .replace(BILLING_CONTEXT, " ")
    .replace(/[^A-Za-z]+/g, " ")
    .trim();
  // A real note that happens to cite a code keeps its narrative; a claim line
  // has only the descriptor left.
  return residue.split(/\s+/).filter(Boolean).length <= 7;
}

/**
 * A patient-education handout.
 *
 * "Noncardiac chest pain - pain or discomfort in chest not caused by a heart
 * problem", "Medicines may be given to treat the cause" — a leaflet printed
 * into the chart. It is about the condition in general, not about this patient
 * on this day, and it describes what may happen rather than what did.
 */
const PATIENT_EDUCATION =
  /\b(?:educational?\s+material|patient\s+education|discharge\s+instructions?\s+leaflet|this\s+(?:handout|leaflet|information)|what\s+(?:is|are|causes)\b|possible\s+causes|may\s+be\s+(?:given|caused|due)|can\s+be\s+caused\s+by|talk\s+to\s+your\s+(?:doctor|provider)|call\s+your\s+(?:doctor|provider)\s+if|home\s+care\s+instructions|follow\s+these\s+(?:steps|instructions)|not\s+caused\s+by|refers?\s+to|is\s+a\s+condition|occurs?\s+when|means\s+that|also\s+called)\b/i;

export type InsubstantialReason =
  | "DEMOGRAPHIC_ONLY"
  | "ADMINISTRATIVE_ONLY"
  | "GENERIC_VISIT_ONLY"
  | "STUDY_CATEGORIES_ONLY"
  | "CODED_CLAIM_DATA"
  | "PATIENT_EDUCATION"
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
  if (isDemographic(value)) return false;
  if (ADMINISTRATIVE_TEXT.test(value)) return false;
  if (GENERIC_VISIT.test(value)) return false;
  // A study list earns its place only by carrying what the study found.
  if (STUDY_CATEGORIES.test(value) && !CARRIES_A_RESULT.test(value)) return false;
  if (isCodeReference(value)) return false;
  if (PATIENT_EDUCATION.test(value)) return false;
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

  if (values.every(isDemographic)) return { meaningful: false, reason: "DEMOGRAPHIC_ONLY" };
  if (values.every((v) => ADMINISTRATIVE_TEXT.test(v))) return { meaningful: false, reason: "ADMINISTRATIVE_ONLY" };
  if (values.every((v) => STUDY_CATEGORIES.test(v) && !CARRIES_A_RESULT.test(v))) {
    return { meaningful: false, reason: "STUDY_CATEGORIES_ONLY" };
  }
  if (values.every(isCodeReference)) return { meaningful: false, reason: "CODED_CLAIM_DATA" };
  if (values.every((v) => PATIENT_EDUCATION.test(v))) return { meaningful: false, reason: "PATIENT_EDUCATION" };
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
    case "CODED_CLAIM_DATA":
      return "Billing codes and their descriptors — no clinical narrative.";
    case "PATIENT_EDUCATION":
      return "Patient-education material about the condition, not a record of this visit.";
    case "NO_CLINICAL_FIELD":
      return "No clinical assertion was extracted from this source.";
    case "NO_CONTENT":
      return "No content was extracted from this source.";
  }
}
