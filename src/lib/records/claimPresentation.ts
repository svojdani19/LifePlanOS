// ─────────────────────────────────────────────────────────────────────────────
// Presenting a record's supporting quotes to a person.
//
// A canonical note can carry a lot of them — 9,677 across one real case, median
// 11 per note but one note holding 1,043. The card showed the first four in
// arrival order and offered "Show all 318 claims", so a physician's first
// impression of a record was whatever the extractor happened to emit first:
//
//     documentContent: "Acct Num: FV1000316180" (p. 4)
//     documentContent: "MedRecNum:9J730042100" (p. 4)
//     documentContent: "Patient states hi S sugar has beenelevatedfor hours"
//
// None of that is a clinical fact. `documentContent` is the extractor's
// catch-all for page text it could not type — 1,579 of those 9,677 — and it
// sits alphabetically ahead of everything that matters.
//
// Every quote still has to be inspectable: a signature covers all of them, and
// hiding one would mean attesting to content the card never showed. So nothing
// is dropped. It is ORDERED — what the record clinically asserts first, page
// text last — and the two are counted separately so the card can say what it
// is actually offering to show.
// ─────────────────────────────────────────────────────────────────────────────

export interface PresentableClaim {
  field?: string | null;
  value?: string | null;
  excerpt?: string | null;
  page?: number | null;
  warning?: string | null;
}

/** Field keys are written for code; these are the words a clinician uses. */
export const CLAIM_FIELD_LABEL: Record<string, string> = {
  assessment: "Assessment",
  diagnosis: "Diagnosis",
  operativeFindings: "Operative findings",
  diagnosticStudies: "Diagnostic studies",
  objectiveFindings: "Examination",
  subjective: "History / symptoms",
  pastMedicalHistory: "Past medical history",
  treatment: "Treatment given",
  medications: "Medications",
  recommendations: "Recommendations",
  restrictions: "Restrictions",
  functionalStatus: "Functional status",
  responseToTreatment: "Response to treatment",
  disposition: "Disposition",
  billedAmount: "Billed amount",
  documentContent: "Page text",
};

/**
 * Clinical reading order — how a clinician reads a note, not alphabetical.
 * Anything unlisted sorts after these but before the raw buckets.
 */
const CLINICAL_ORDER = [
  "assessment",
  "diagnosis",
  "operativeFindings",
  "diagnosticStudies",
  "objectiveFindings",
  "subjective",
  "pastMedicalHistory",
  "treatment",
  "medications",
  "recommendations",
  "restrictions",
  "functionalStatus",
  "responseToTreatment",
  "disposition",
];

/**
 * Fields that are not a clinical assertion about the patient.
 *
 * `documentContent` is untyped page text — account numbers, headers, OCR
 * wreckage. Kept (a signature covers it) but never shown first.
 */
const RAW_FIELDS = new Set(["documentContent"]);

const rank = (c: PresentableClaim): number => {
  const field = c.field ?? "";
  if (RAW_FIELDS.has(field)) return 900;
  const at = CLINICAL_ORDER.indexOf(field);
  return at >= 0 ? at : 500;
};

export interface PresentedClaims {
  /** What the record clinically asserts, in reading order. */
  clinical: PresentableClaim[];
  /** Untyped page text and other non-assertions, kept and inspectable. */
  raw: PresentableClaim[];
  /** True when a quote carries an extractor warning worth surfacing. */
  flagged: PresentableClaim[];
}

/**
 * Split and order a note's quotes for display. Pure, total, and lossless:
 * `clinical.length + raw.length` always equals the input length.
 */
export function presentClaims(claims: readonly PresentableClaim[]): PresentedClaims {
  const clinical: PresentableClaim[] = [];
  const raw: PresentableClaim[] = [];
  for (const c of claims) (RAW_FIELDS.has(c.field ?? "") ? raw : clinical).push(c);
  // Stable within a field: the extractor's order inside one field is the
  // order the note reads in.
  clinical.sort((a, b) => rank(a) - rank(b));
  return { clinical, raw, flagged: claims.filter((c) => !!c.warning) };
}

/** "Assessment", "Page text" — never a bare camelCase key. */
export const labelForField = (field: string | null | undefined): string =>
  (field && CLAIM_FIELD_LABEL[field]) ||
  (field ? field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (m) => m.toUpperCase()) : "Quote");
