// ─────────────────────────────────────────────────────────────────────────────
// What a record's one-line summary should SAY.
//
// A reviewer reading a chronology is reconstructing a course of care. The
// summary of each entry has to serve that: what kind of contact this was, what
// was found, and what was decided. Two failure modes make it useless instead,
// and both were visible in a real case file:
//
//   • BOILERPLATE LEADS. "Keep the injured part elevated" is printed on every
//     discharge sheet in the country. It is a real sentence in the record and
//     it is worthless for understanding what happened that day, so it must
//     never be the line a reviewer reads first.
//   • METADATA MASQUERADES AS CONTENT. "Encounter Date: Jul 18" is a field
//     label. Restating it tells the reader something they can already see in
//     the date column, and it displaces the fact that mattered.
//
// So the summary is COMPOSED, not picked: the entry's own kind decides which
// clauses it should carry — an encounter has an assessment, a finding and a
// plan; a study has an impression; a billing line has a charge; an operation
// has a procedure and its findings — and non-substantive text is barred from
// leading, whatever field it arrived in.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";

/**
 * Generic patient-education and discharge boilerplate. It is genuinely in the
 * record, so it is not discarded — it simply may never LEAD, because it says
 * nothing about this patient on this day.
 */
const BOILERPLATE_RE =
  /\b(?:keep (?:the )?(?:injured|affected) (?:part|area|limb)|elevat\w+ (?:the )?(?:injured|affected|extremity)|apply (?:ice|a cold pack)|ice (?:the area |it )?for \d+|call (?:your|the) (?:doctor|provider|physician|nurse|office) if|return (?:to (?:the )?(?:emergency(?: department| room)?|ed\b|hospital|clinic)|here)[^.]{0,40}\bif\b|seek (?:immediate )?medical attention if|take (?:your )?medication(?:s)? as (?:directed|prescribed)|drink plenty of fluids|get plenty of rest|as needed for (?:pain|discomfort)|follow (?:these|the) instructions|read (?:the|this) (?:information|medication guide)|warning signs|when to call|home care instructions|do not drive (?:while|if) (?:taking|you)|wash your hands|keep the (?:wound|incision) (?:clean and )?dry)\b/i;

/**
 * Field labels and record furniture restated as if they were findings. These
 * carry no fact at all: the date column already says the date, and the header
 * already says whose chart it is.
 */
const METADATA_RESTATEMENT_RE =
  /^\s*(?:encounter|service|visit|admission|discharge|collection|order|report|print(?:ed)?|signed|received|fax)?\s*date\s*(?:of\s*(?:service|birth))?\s*[:\-]|^\s*(?:patient|client)\s*(?:name|id)?\s*[:\-]|^\s*(?:dob|d\.o\.b\.|mrn|medical record (?:number|no)|account (?:number|no)|chart (?:number|no)|visit (?:number|no)|claim (?:number|no))\s*[:\-]|^\s*page\s+\d+\s*(?:of\s*\d+)?\s*$|^\s*(?:facility|location|provider|physician|clinician)\s*[:\-]\s*\S+\s*$/i;

/** Does this value say nothing a reviewer can use? */
export function isNonSubstantive(value: string): boolean {
  return METADATA_RESTATEMENT_RE.test(value);
}

/** True content, but never the headline. */
export function isBoilerplate(value: string): boolean {
  return BOILERPLATE_RE.test(value);
}

/**
 * The clauses a summary of THIS kind of record should carry, in the order a
 * reviewer reads them. Each entry is [field, prefix]; the prefix is empty when
 * the clause reads naturally on its own.
 */
const SHAPE: Partial<Record<AnalysisClass, [string, string][]>> = {
  CLINICAL_ENCOUNTER: [
    ["assessment", ""],
    ["objectiveFindings", "exam: "],
    ["procedure", "procedure: "],
    ["recommendations", "plan: "],
    ["treatment", "plan: "],
    ["disposition", "disposition: "],
  ],
  THERAPY_COURSE: [
    ["responseToTreatment", ""],
    ["objectiveFindings", "measures: "],
    ["treatment", "delivered: "],
    ["recommendations", "plan: "],
  ],
  OPERATIVE: [
    ["procedure", ""],
    ["postOperativeDiagnosis", "post-op dx: "],
    ["operativeFindings", "findings: "],
    ["complications", "complications: "],
    ["implants", "implants: "],
  ],
  ANESTHESIA: [
    ["anesthesiaType", ""],
    ["anesthesiaEvent", "intraoperative: "],
    ["complications", "complications: "],
  ],
  PATHOLOGY_DIAGNOSTIC: [
    ["pathologicDiagnosis", ""],
    ["specimen", "specimen: "],
    ["microscopicDescription", "microscopic: "],
  ],
  DIAGNOSTIC_STUDY: [
    ["impression", "impression: "],
    ["diagnosticStudies", "findings: "],
    ["comparison", "compared with: "],
  ],
  TESTIMONY: [
    ["admission", "admission: "],
    ["testimony", ""],
    ["workStatus", "work: "],
    ["functionalStatus", "function: "],
  ],
  EXPERT_OPINION: [
    ["causationOpinion", "causation opinion: "],
    ["opinion", "opinion: "],
    ["assessment", "stated diagnosis: "],
    ["recommendations", "future care opinion: "],
  ],
  INCIDENT: [
    ["mechanism", ""],
    ["sceneFindings", "scene: "],
    ["objectiveFindings", "on assessment: "],
    ["treatment", "treated: "],
  ],
  FINANCIAL: [
    ["charge", ""],
    ["serviceCode", "code: "],
    ["billedAmount", "amount: "],
    ["payer", "payer: "],
  ],
  EMPLOYMENT_ECONOMIC: [
    ["employmentStatus", ""],
    ["earnings", "earnings: "],
    ["employer", "employer: "],
  ],
  INSURANCE_ADMINISTRATIVE: [
    ["claimStatus", ""],
    ["authorization", "authorization: "],
    ["coverage", "coverage: "],
  ],
  LEGAL: [
    ["legalAssertion", ""],
    ["reliefSought", "relief sought: "],
    ["partyPosition", "position: "],
  ],
};

/**
 * Fields whose label states what KIND of statement the clause is, not merely
 * which column it came from. These keep their label even when they lead.
 */
const EVIDENTIAL_LABELS = new Set(["impression", "admission", "causationOpinion", "opinion"]);

/** How many clauses a summary may carry before it stops being a summary. */
const MAX_CLAUSES = 3;

export interface SummaryClaim {
  field: string;
  value: string;
}

/**
 * Compose the summary for one entry: an opening label naming what kind of
 * contact this was, then the clauses its kind calls for.
 *
 * Returns null when nothing substantive is available, so the caller can fall
 * back rather than print a label with no content behind it.
 */
export function composeSummary(klass: AnalysisClass | null | undefined, label: string, claims: SummaryClaim[], clip: (s: string, n: number) => string): string | null {
  const shape = SHAPE[(klass ?? "CLINICAL_ENCOUNTER") as AnalysisClass];
  if (!shape) return null;

  const usable = claims.filter((c) => c.value.trim().length > 2 && !isNonSubstantive(c.value));
  const clauses: string[] = [];
  const used = new Set<string>();

  for (const [field, prefix] of shape) {
    if (clauses.length >= MAX_CLAUSES) break;
    // Boilerplate is barred from the summary entirely: it is available in the
    // entry's claims, where a reviewer can see it in context.
    const hit = usable.find((c) => c.field === field && !used.has(c.value) && !isBoilerplate(c.value));
    if (!hit) continue;
    used.add(hit.value);
    const text = clip(hit.value.replace(/^[A-Z][a-z]+:\s*/, "").trim(), 110);
    // A headline clause usually needs no label — "Surgery — procedure: X"
    // says "procedure" twice. But some labels are not decoration: an
    // IMPRESSION is the radiologist's conclusion rather than a raw finding,
    // and an ADMISSION is testimony against the deponent's own interest.
    // Dropping those would erase what kind of statement the reader is looking
    // at, so they keep their label wherever they appear.
    const keepLabel = clauses.length > 0 || EVIDENTIAL_LABELS.has(field);
    clauses.push(keepLabel ? `${prefix}${text}` : text);
  }

  if (!clauses.length) return null;
  const body = clauses.join("; ");
  return `${label} — ${/[.!?…]$/.test(body) ? body : `${body}.`}`;
}
