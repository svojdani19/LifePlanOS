// ─────────────────────────────────────────────────────────────────────────────
// Document ANALYSIS CLASS: what kind of thing a document is, and therefore
// what it can be asked for.
//
// A case file is not a pile of clinic notes. It holds depositions, operative
// notes, imaging reports, billing ledgers, police reports, IME opinions — and
// each documents a fundamentally different kind of fact. Asking all of them for
// "the encounter's provider, date, assessment and treatment" produces exactly
// the failure this layer exists to end: measured on a real case file, four
// depositions were shredded into thirteen "clinical encounters", 77% of them
// undated and 85% with no provider, because a deposition has no treating
// provider and no encounter date — it has a deponent, one date, and testimony.
// Sixteen operative notes became 138 "encounters" when each is ONE procedure.
// A hundred percent of chiropractic notes reported no provider.
//
// So each class declares:
//   • what ONE extracted row represents, in the document's own vocabulary
//   • which claim fields it can express — a deposition cannot have an
//     "assessment"; a billing ledger cannot have "objective findings"
//   • who authors it, if anyone (a billing ledger has no clinician)
//   • whether a per-row date is even meaningful
//   • what the reader of THAT kind of document actually needs
//
// The classes are deliberately coarse. Sixty document types do not need sixty
// extraction schemas; they need the handful of genuinely different questions a
// reviewer asks. The dividing principle is a genuinely different review
// question, not a different specialty letterhead.
//
// Anything unrecognized resolves to UNKNOWN — never to a clinical encounter.
// "Clinical by default" is precisely how an unlabelled fax or a cover letter
// acquires a provider, a diagnosis and a slot on the medical timeline it never
// earned. UNKNOWN keeps the material visible and routes it to a human.
// ─────────────────────────────────────────────────────────────────────────────

import type { ClaimField } from "@/lib/llm/recordExtraction";

export type AnalysisClass =
  | "CLINICAL_ENCOUNTER"
  | "THERAPY_COURSE"
  | "OPERATIVE"
  | "ANESTHESIA"
  | "PATHOLOGY_DIAGNOSTIC"
  | "DEVICE_OR_IMPLANT"
  | "DIAGNOSTIC_STUDY"
  | "TESTIMONY"
  | "EXPERT_OPINION"
  | "INCIDENT"
  | "FINANCIAL"
  | "EMPLOYMENT_ECONOMIC"
  | "INSURANCE_ADMINISTRATIVE"
  | "LEGAL"
  | "CORRESPONDENCE_OR_GENERIC_EVIDENCE"
  | "SUPPORTING_FILE"
  | "UNKNOWN";

export interface ClassProfile {
  klass: AnalysisClass;
  /** What ONE extracted row represents, in this document's own vocabulary. */
  unit: string;
  unitPlural: string;
  /** The claim fields this kind of document can express. */
  fields: readonly ClaimField[];
  /**
   * Who authors the record, if the class has such a role at all. Null means
   * the document has no author to attribute — and the pipeline must stop
   * reporting that as a missing provider.
   */
  attribution: string | null;
  /** Whether a per-row date is a meaningful thing to ask for. */
  expectsDate: boolean;
  /** Whether the whole document is normally ONE unit (a deposition, an IME). */
  singleUnit: boolean;
  /** What matters in this kind of document, in the model's instructions. */
  guidance: string;
  /** Field order for the one-line summary — what a reviewer would name first. */
  leadFields: readonly ClaimField[];
  /**
   * Must a reviewer supply a date when the document does not state one?
   *
   * Only material that belongs on the medical timeline does. Asking a
   * physician to date a fee schedule or a records-request letter is asking
   * them to invent a fact, and it buries the entries that genuinely need
   * dating among dozens that never will.
   */
  requiresDate: boolean;
}

// ── Field vocabularies ──────────────────────────────────────────────────────

const CLINICAL_FIELDS = [
  "subjective", "pastMedicalHistory", "objectiveFindings", "diagnosticStudies", "assessment",
  "treatment", "procedure", "medications", "functionalStatus", "workStatus", "restrictions",
  "disposition", "responseToTreatment", "recommendations", "contradictions",
] as const satisfies readonly ClaimField[];

const THERAPY_FIELDS = [
  "subjective", "objectiveFindings", "treatment", "responseToTreatment", "functionalStatus",
  "restrictions", "workStatus", "recommendations", "disposition", "assessment", "contradictions",
] as const satisfies readonly ClaimField[];

const OPERATIVE_FIELDS = [
  "preOperativeDiagnosis", "postOperativeDiagnosis", "procedure", "operativeFindings", "implants",
  "complications", "anesthesia", "specimen", "estimatedBloodLoss", "disposition", "recommendations",
  "medications", "contradictions",
] as const satisfies readonly ClaimField[];

const DIAGNOSTIC_FIELDS = [
  "studyTechnique", "comparison", "diagnosticStudies", "impression", "recommendations", "contradictions",
] as const satisfies readonly ClaimField[];

const TESTIMONY_FIELDS = [
  "testimony", "admission", "functionalStatus", "workStatus", "restrictions", "pastMedicalHistory", "contradictions",
] as const satisfies readonly ClaimField[];

const EXPERT_FIELDS = [
  "opinion", "causationOpinion", "objectiveFindings", "assessment", "diagnosticStudies", "functionalStatus",
  "workStatus", "restrictions", "recommendations", "pastMedicalHistory", "contradictions",
] as const satisfies readonly ClaimField[];

const INCIDENT_FIELDS = [
  "mechanism", "sceneFindings", "witnessStatement", "objectiveFindings", "treatment", "disposition", "contradictions",
] as const satisfies readonly ClaimField[];

const FINANCIAL_FIELDS = [
  "charge", "serviceCode", "billedAmount", "payer", "treatment", "procedure", "medications", "contradictions",
] as const satisfies readonly ClaimField[];

const LEGAL_FIELDS = [
  "legalAssertion", "reliefSought", "partyPosition", "contradictions",
] as const satisfies readonly ClaimField[];

const ANESTHESIA_FIELDS = [
  "anesthesiaType", "anesthesiaEvent", "medications", "complications", "estimatedBloodLoss", "disposition", "contradictions",
] as const satisfies readonly ClaimField[];

const PATHOLOGY_FIELDS = [
  "specimen", "grossDescription", "microscopicDescription", "pathologicDiagnosis", "comparison", "contradictions",
] as const satisfies readonly ClaimField[];

const DEVICE_FIELDS = [
  "implants", "deviceIdentifier", "manufacturer", "procedure", "contradictions",
] as const satisfies readonly ClaimField[];

const EMPLOYMENT_FIELDS = [
  "employer", "employmentStatus", "earnings", "workStatus", "restrictions", "documentContent", "contradictions",
] as const satisfies readonly ClaimField[];

const INSURANCE_FIELDS = [
  "coverage", "claimStatus", "authorization", "payer", "billedAmount", "documentContent", "contradictions",
] as const satisfies readonly ClaimField[];

const GENERIC_FIELDS = [
  "documentContent", "contradictions",
] as const satisfies readonly ClaimField[];

// ── Profiles ────────────────────────────────────────────────────────────────

const NEVER_INVENT_CLINICAL =
  "This document is not a clinical note. Do not manufacture an assessment, a treating provider, or a visit date from it.";

export const PROFILES: Record<AnalysisClass, ClassProfile> = {
  CLINICAL_ENCOUNTER: {
    klass: "CLINICAL_ENCOUNTER",
    unit: "encounter",
    unitPlural: "encounters",
    fields: CLINICAL_FIELDS,
    attribution: "treating provider",
    expectsDate: true,
    singleUnit: false,
    leadFields: ["assessment", "procedure", "treatment", "objectiveFindings", "subjective", "disposition"],
    guidance:
      "This is a clinical encounter record. Extract one entry per DATED VISIT. What matters: why the patient presented, what was found on examination, what was assessed, what was done or prescribed, and what was planned. Attribute each visit to the clinician who saw the patient and the date of service printed on the note.",
    requiresDate: true,
  },

  THERAPY_COURSE: {
    klass: "THERAPY_COURSE",
    unit: "therapy visit",
    unitPlural: "therapy visits",
    fields: THERAPY_FIELDS,
    attribution: "treating therapist",
    expectsDate: true,
    singleUnit: false,
    leadFields: ["responseToTreatment", "objectiveFindings", "treatment", "functionalStatus", "subjective"],
    guidance:
      "This is a therapy record (physical, occupational, chiropractic, or similar). Extract one entry per DATED TREATMENT VISIT. What matters is the INTERVAL CHANGE: measured progress toward goals, objective measures (range of motion, strength, gait), the modalities actually delivered that day, and the patient's documented response. Therapy notes repeat their diagnosis and their standing plan on every visit — that recurring boilerplate is not the visit's content and must not become its summary. If a visit documents no change and no distinguishing content, say so plainly rather than restating the diagnosis. The signing therapist is often initials or absent; do not invent a provider name.",
    requiresDate: true,
  },

  OPERATIVE: {
    klass: "OPERATIVE",
    unit: "procedure",
    unitPlural: "procedures",
    fields: OPERATIVE_FIELDS,
    attribution: "surgeon",
    expectsDate: true,
    singleUnit: false,
    leadFields: ["procedure", "postOperativeDiagnosis", "operativeFindings", "complications", "implants"],
    guidance:
      "This is an operative or procedural report. ONE OPERATION IS ONE ENTRY — do not split a single operative report into multiple entries for its separate sections (indications, technique, findings, closure all belong to the same procedure). What matters: the pre- and post-operative diagnoses, the procedure(s) actually performed and at which levels or sites, the operative findings, any implants or hardware with their identifiers, estimated blood loss, specimens sent, complications (state explicitly when the report says none), the anesthesia used, and the surgeon of record. The surgeon is the attributed author, not a 'treating provider' seen at a visit.",
    requiresDate: true,
  },

  DIAGNOSTIC_STUDY: {
    klass: "DIAGNOSTIC_STUDY",
    unit: "study",
    unitPlural: "studies",
    fields: DIAGNOSTIC_FIELDS,
    attribution: "interpreting radiologist or technologist",
    expectsDate: true,
    singleUnit: false,
    leadFields: ["impression", "diagnosticStudies", "comparison", "studyTechnique"],
    guidance:
      "This is a diagnostic study report (imaging, laboratory, or electrodiagnostic). ONE STUDY IS ONE ENTRY. What matters: which study was performed and of what body part, the technique or protocol, what prior study it was compared against, the reported FINDINGS, and — most important — the radiologist's or interpreting physician's IMPRESSION, which is the conclusion the rest of the record will rely on. Keep findings and impression distinct; do not merge them. The author is the interpreting physician, not a treating provider. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: true,
  },

  TESTIMONY: {
    klass: "TESTIMONY",
    unit: "testimony passage",
    unitPlural: "testimony passages",
    fields: TESTIMONY_FIELDS,
    attribution: "deponent",
    expectsDate: false,
    singleUnit: true,
    leadFields: ["admission", "testimony", "functionalStatus", "workStatus", "restrictions"],
    guidance:
      "This is sworn testimony (a deposition or similar transcript). It is ONE proceeding on ONE date with ONE deponent — it is NOT a series of clinical encounters, and it has no treating provider and no encounter date. Extract substantive PASSAGES OF TESTIMONY, not visits. What matters: who is testifying and in what capacity; what they state about the incident, their symptoms, their functional limitations, their work capacity, and their prior condition; and above all any ADMISSION — testimony against the deponent's own interest, an inconsistency with the medical record, or an acknowledgement of a pre-existing problem. Attribute testimony to the deponent and cite the transcript page. Never convert testimony into a clinical finding: a plaintiff saying their back hurts is testimony, not an examination finding. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  EXPERT_OPINION: {
    klass: "EXPERT_OPINION",
    unit: "opinion section",
    unitPlural: "opinion sections",
    fields: EXPERT_FIELDS,
    attribution: "examining or opining expert",
    expectsDate: false,
    singleUnit: true,
    leadFields: ["opinion", "causationOpinion", "assessment", "objectiveFindings", "recommendations"],
    guidance:
      "This is an expert or evaluative report (independent medical examination, peer review, neuropsychological evaluation, functional capacity evaluation, life care plan, or vocational assessment). It is ONE evaluation by ONE examiner, not a series of visits. What matters: who examined or opined and on whose behalf; the findings of their own examination or testing; and their STATED OPINIONS — on diagnosis, on causation and apportionment, on maximum medical improvement, on impairment rating, on work capacity, and on future care. Record an opinion AS an opinion attributed to that examiner; never restate it as an established fact about the patient.",
    requiresDate: false,
  },

  INCIDENT: {
    klass: "INCIDENT",
    unit: "incident record",
    unitPlural: "incident records",
    fields: INCIDENT_FIELDS,
    attribution: "reporting officer or responder",
    expectsDate: true,
    singleUnit: true,
    leadFields: ["mechanism", "sceneFindings", "objectiveFindings", "treatment", "witnessStatement"],
    guidance:
      "This is an incident or prehospital record (police report, EMS run sheet, incident report, or reconstruction). What matters: the MECHANISM of injury as documented — speed, direction, restraint use, point of impact, fall height, surface; the scene findings and conditions; the patient's presentation and complaints at the scene; any treatment given en route; the receiving facility; and witness or party statements, attributed to who made them. Statements by a party are reported statements, never established facts.",
    requiresDate: true,
  },

  FINANCIAL: {
    klass: "FINANCIAL",
    unit: "billing record",
    unitPlural: "billing records",
    fields: FINANCIAL_FIELDS,
    attribution: null, // a ledger has no clinician to attribute
    expectsDate: true,
    singleUnit: false,
    leadFields: ["charge", "serviceCode", "billedAmount", "payer"],
    guidance:
      "This is a billing, pharmacy, or insurance record. It documents what was CHARGED, not what was clinically found. Extract the charge lines: date of service, the service or drug billed, its CPT/HCPCS/NDC code, the amount billed or paid, and the payer. A diagnosis code appearing on a claim line is a BILLING code justifying the charge — it is not a clinical assessment of the patient and must never be recorded as one. This document has no examining clinician; do not attribute one. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  ANESTHESIA: {
    klass: "ANESTHESIA",
    unit: "anesthetic record",
    unitPlural: "anesthetic records",
    fields: ANESTHESIA_FIELDS,
    // The anesthesiologist or CRNA authors this record — NOT the surgeon, who
    // authors the operative note beside it in the same packet.
    attribution: "anesthesia provider",
    expectsDate: true,
    singleUnit: false,
    leadFields: ["anesthesiaType", "anesthesiaEvent", "complications", "medications"],
    guidance:
      "This is an anesthesia record. What matters: the anesthetic technique used, airway management, agents and doses administered, intraoperative events and hemodynamic instability, estimated blood loss, complications (state explicitly when the record says none), and recovery disposition. The author is the anesthesia provider. Do NOT attribute this record to the surgeon and do not restate the operation itself — the operative note documents that.",
    requiresDate: true,
  },

  PATHOLOGY_DIAGNOSTIC: {
    klass: "PATHOLOGY_DIAGNOSTIC",
    unit: "pathology report",
    unitPlural: "pathology reports",
    fields: PATHOLOGY_FIELDS,
    attribution: "pathologist",
    expectsDate: true,
    singleUnit: false,
    leadFields: ["pathologicDiagnosis", "microscopicDescription", "grossDescription", "specimen"],
    guidance:
      "This is a pathology report — a DIAGNOSTIC interpretation of a specimen, not an operative note. ONE ACCESSION IS ONE ENTRY. What matters: the specimen(s) received and their source, the gross description, the microscopic description, and above all the FINAL PATHOLOGIC DIAGNOSIS, which is the conclusion the rest of the record relies on. The author is the interpreting pathologist, never the operating surgeon. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: true,
  },

  DEVICE_OR_IMPLANT: {
    klass: "DEVICE_OR_IMPLANT",
    unit: "device record",
    unitPlural: "device records",
    fields: DEVICE_FIELDS,
    attribution: null, // an implant log is inventory documentation, not a clinician's note
    expectsDate: true,
    singleUnit: false,
    leadFields: ["implants", "deviceIdentifier", "manufacturer"],
    guidance:
      "This is a device or implant record — a log of hardware, not an operation. What matters: the device implanted, its manufacturer, model, lot or serial number, and the site. It documents WHAT WAS USED; it is not itself evidence of an operation's findings or outcome, and it has no clinician to attribute. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  EMPLOYMENT_ECONOMIC: {
    klass: "EMPLOYMENT_ECONOMIC",
    unit: "employment or earnings record",
    unitPlural: "employment and earnings records",
    fields: EMPLOYMENT_FIELDS,
    attribution: null,
    expectsDate: true,
    singleUnit: false,
    leadFields: ["employmentStatus", "earnings", "employer", "workStatus"],
    guidance:
      "This is an employment, wage, or tax record. It is ECONOMIC evidence, not medical billing: it has no CPT codes, no charges for care, and no clinical content. What matters: the employer, dates and status of employment, hours, wage or earnings figures, and any documented time lost from work. Never express this as a medical charge or a clinical fact. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  INSURANCE_ADMINISTRATIVE: {
    klass: "INSURANCE_ADMINISTRATIVE",
    unit: "insurance record",
    unitPlural: "insurance records",
    fields: INSURANCE_FIELDS,
    attribution: null,
    expectsDate: true,
    singleUnit: false,
    leadFields: ["claimStatus", "coverage", "authorization", "payer"],
    guidance:
      "This is an insurance or claims-administration record. What matters: the coverage in force, the policy or claim identifiers, the status of a claim, authorizations granted or denied and for what, and amounts allowed or paid. An authorization or denial is an administrative decision — it is not a clinical judgment about the patient, and a denial is not evidence that care was unnecessary. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  CORRESPONDENCE_OR_GENERIC_EVIDENCE: {
    klass: "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
    unit: "document",
    unitPlural: "documents",
    fields: GENERIC_FIELDS,
    attribution: "author",
    expectsDate: true,
    singleUnit: true,
    leadFields: ["documentContent"],
    guidance:
      "This is correspondence or general case-file material whose kind is not otherwise established — a letter, a memo, a cover page, a transmittal. Record plainly WHAT THE DOCUMENT SAYS and who wrote it, in the document's own terms. Do not classify its content as clinical, legal, or financial fact; a letter that mentions a diagnosis is a letter, not a medical record. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  UNKNOWN: {
    klass: "UNKNOWN",
    unit: "unclassified record",
    unitPlural: "unclassified records",
    fields: GENERIC_FIELDS,
    attribution: null,
    expectsDate: false,
    singleUnit: true,
    leadFields: ["documentContent"],
    guidance:
      "The kind of this document could NOT be established. Record only what the text plainly says, with its citation, and nothing more. Do not infer that it is a clinical note, and do not supply a provider, a diagnosis, an assessment, or a treatment. This material is routed to human review precisely because the system does not know what it is. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },

  SUPPORTING_FILE: {
    klass: "SUPPORTING_FILE",
    unit: "supporting file",
    unitPlural: "supporting files",
    fields: GENERIC_FIELDS,
    attribution: null,
    expectsDate: false,
    singleUnit: true,
    requiresDate: false,
    leadFields: ["documentContent"],
    guidance:
      "This is filed case material that is NOT clinical care, NOT billing bearing on the course of care, and NOT needed to understand the medical course — a fee schedule, a records-request letter, a cover sheet, a duplicate index, a privacy notice. Record plainly what it is, in one line, with its citation. Do not extract clinical facts from it and do not supply a date: it has no place on any timeline, and inventing one would put it there. It stays fully accessible for review, and a reviewer who decides it matters can reclassify it. " +
      NEVER_INVENT_CLINICAL,
  },

  LEGAL: {
    klass: "LEGAL",
    unit: "legal document",
    unitPlural: "legal documents",
    fields: LEGAL_FIELDS,
    attribution: "filing party",
    expectsDate: true,
    singleUnit: true,
    leadFields: ["legalAssertion", "reliefSought", "partyPosition"],
    guidance:
      "This is a legal filing or correspondence (pleading, demand letter, settlement agreement, court order, or letter). What matters: the parties, what is ASSERTED and by whom, the relief or remedy sought, deadlines and operative dates, and the procedural posture. Everything here is a party's position or a court's order — never a medical fact about the patient. " +
      NEVER_INVENT_CLINICAL,
    requiresDate: false,
  },
};

// ── Document type → class ───────────────────────────────────────────────────

const BY_TYPE: Record<string, AnalysisClass> = {
  // Clinical encounters
  ER_RECORD: "CLINICAL_ENCOUNTER",
  HOSPITAL_RECORD: "CLINICAL_ENCOUNTER",
  NURSING_NOTE: "CLINICAL_ENCOUNTER",
  DISCHARGE_SUMMARY: "CLINICAL_ENCOUNTER",
  MEDICAL_RECORD: "CLINICAL_ENCOUNTER",
  ORTHOPEDIC_CLINIC: "CLINICAL_ENCOUNTER",
  PRIMARY_CARE: "CLINICAL_ENCOUNTER",
  NEUROLOGY_RECORD: "CLINICAL_ENCOUNTER",
  NEUROSURGERY_RECORD: "CLINICAL_ENCOUNTER",
  PAIN_MANAGEMENT: "CLINICAL_ENCOUNTER",
  PHYSICAL_MEDICINE: "CLINICAL_ENCOUNTER",
  PSYCHIATRY_RECORD: "CLINICAL_ENCOUNTER",
  PSYCHOLOGY_RECORD: "CLINICAL_ENCOUNTER",
  CARDIOLOGY_RECORD: "CLINICAL_ENCOUNTER",
  PULMONOLOGY_RECORD: "CLINICAL_ENCOUNTER",
  INFECTIOUS_DISEASE: "CLINICAL_ENCOUNTER",
  INTERNAL_MEDICINE: "CLINICAL_ENCOUNTER",
  ONCOLOGY_RECORD: "CLINICAL_ENCOUNTER",
  WOUND_CARE: "CLINICAL_ENCOUNTER",
  PRIOR_RECORDS: "CLINICAL_ENCOUNTER",

  // Therapy
  PT_OT_RECORD: "THERAPY_COURSE",
  SPEECH_THERAPY: "THERAPY_COURSE",
  CHIROPRACTIC_RECORD: "THERAPY_COURSE",
  ACUPUNCTURE_RECORD: "THERAPY_COURSE",

  // Operative
  OPERATIVE_NOTE: "OPERATIVE",
  ANESTHESIA_RECORD: "ANESTHESIA",
  PATHOLOGY_REPORT: "PATHOLOGY_DIAGNOSTIC",
  IMPLANT_RECORDS: "DEVICE_OR_IMPLANT",

  // Diagnostics
  IMAGING_REPORT: "DIAGNOSTIC_STUDY",
  LAB_REPORT: "DIAGNOSTIC_STUDY",
  EMG_NCS_REPORT: "DIAGNOSTIC_STUDY",

  // Testimony
  DEPOSITION: "TESTIMONY",

  // Expert / evaluative
  IME_REPORT: "EXPERT_OPINION",
  EXPERT_REPORT: "EXPERT_OPINION",
  PEER_REVIEW: "EXPERT_OPINION",
  NEUROPSYCHOLOGICAL_EVALUATION: "EXPERT_OPINION",
  FUNCTIONAL_CAPACITY_EVALUATION: "EXPERT_OPINION",
  LIFE_CARE_PLAN: "EXPERT_OPINION",
  VOCATIONAL_ASSESSMENT: "EXPERT_OPINION",
  REHABILITATION_PLAN: "EXPERT_OPINION",
  COST_PROJECTION: "EXPERT_OPINION",

  // Incident / scene
  POLICE_REPORT: "INCIDENT",
  EMS_REPORT: "INCIDENT",
  INCIDENT_REPORT: "INCIDENT",
  ACCIDENT_RECONSTRUCTION: "INCIDENT",

  // Financial
  BILLING_RECORD: "FINANCIAL",
  PHARMACY_RECORD: "FINANCIAL",
  INSURANCE_RECORDS: "INSURANCE_ADMINISTRATIVE",
  WAGE_LOSS_DOCUMENTATION: "EMPLOYMENT_ECONOMIC",
  TAX_RECORDS: "EMPLOYMENT_ECONOMIC",
  EMPLOYMENT_RECORDS: "EMPLOYMENT_ECONOMIC",

  // Legal
  LEGAL_PLEADING: "LEGAL",
  DEMAND_LETTER: "LEGAL",
  SETTLEMENT_AGREEMENT: "LEGAL",
  COURT_ORDER: "LEGAL",
  CORRESPONDENCE: "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
  PHOTOGRAPHS: "SUPPORTING_FILE",
  SURVEILLANCE_VIDEO: "SUPPORTING_FILE",
};

/**
 * The analysis profile for a document type.
 *
 * An unrecognized type — including the literal OTHER — resolves to UNKNOWN,
 * NOT to a clinical encounter. Defaulting the unknown to "clinical" is what
 * lets a scanned letter or an unlabelled fax acquire a provider, a diagnosis
 * and a place on the medical timeline it never earned. UNKNOWN keeps the
 * material visible and sends it to a human instead.
 */
export function profileFor(documentType: string | null | undefined): ClassProfile {
  return PROFILES[analysisClassFor(documentType)];
}

export function analysisClassFor(documentType: string | null | undefined): AnalysisClass {
  return BY_TYPE[documentType ?? ""] ?? "UNKNOWN";
}

/** Is this field expressible by this class? */
export function fieldAllowed(profile: ClassProfile, field: string): boolean {
  return (profile.fields as readonly string[]).includes(field);
}

/**
 * Classes whose material is NOT treating medical care, and therefore never
 * enters the medical chronology on its own. They stay fully visible on the
 * Records page in their own attributed sections.
 */
export const NON_CLINICAL_CLASSES = new Set<AnalysisClass>([
  "SUPPORTING_FILE",
  "TESTIMONY",
  "FINANCIAL",
  "EMPLOYMENT_ECONOMIC",
  "INSURANCE_ADMINISTRATIVE",
  "LEGAL",
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
  "UNKNOWN",
  "DEVICE_OR_IMPLANT",
]);

/** Classes that document treating medical care and belong on the timeline. */
export const MEDICAL_TIMELINE_CLASSES = new Set<AnalysisClass>([
  "CLINICAL_ENCOUNTER",
  "THERAPY_COURSE",
  "OPERATIVE",
  "ANESTHESIA",
  "PATHOLOGY_DIAGNOSTIC",
  "DIAGNOSTIC_STUDY",
  "INCIDENT", // prehospital care is care; the scene narrative is labelled as such
]);

/**
 * An expert evaluation may appear as a dated event, but only ever labelled as
 * an expert opinion attributed to its author — never restated as treating fact.
 */
export const ATTRIBUTED_OPINION_CLASSES = new Set<AnalysisClass>(["EXPERT_OPINION"]);

/**
 * Does a row of this kind need a date before the record is complete?
 * Everything else is legitimately dateless and must not be counted as a gap.
 */
export function requiresDate(klass: AnalysisClass | null | undefined): boolean {
  // An unrecorded kind is treated as needing a date: the conservative reading
  // keeps a real gap visible rather than excusing it.
  if (!klass) return true;
  return PROFILES[klass]?.requiresDate ?? true;
}

/**
 * Kinds a reviewer may assign by hand. Everything the pipeline can infer is
 * offered, so a misfiled document can be moved to where it belongs.
 */
export const REVIEWER_ASSIGNABLE_CLASSES: AnalysisClass[] = [
  "CLINICAL_ENCOUNTER", "THERAPY_COURSE", "OPERATIVE", "ANESTHESIA", "PATHOLOGY_DIAGNOSTIC",
  "DIAGNOSTIC_STUDY", "DEVICE_OR_IMPLANT", "INCIDENT", "TESTIMONY", "EXPERT_OPINION",
  "FINANCIAL", "EMPLOYMENT_ECONOMIC", "INSURANCE_ADMINISTRATIVE", "LEGAL",
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE", "SUPPORTING_FILE", "UNKNOWN",
];

/** Material that has not been identified and must reach a human. */
export function requiresHumanClassification(klass: AnalysisClass): boolean {
  return klass === "UNKNOWN";
}

/**
 * How a chunk's class was decided, kept with the row so a reviewer can tell a
 * deliberate assignment from an inference.
 */
export type ClassificationMethod = "DOCUMENT_TYPE" | "SEGMENT_CONTENT" | "FALLBACK_UNKNOWN";

/**
 * Content-derived class for one segment of a consolidated packet. Content
 * classification is only trusted above a score floor; below it the segment is
 * UNKNOWN rather than a guess, because a wrong confident class is worse than
 * an admitted unknown.
 */
export function classFromContent(contentType: string | null, score: number, minScore = 3): { klass: AnalysisClass; method: ClassificationMethod; confidence: number } {
  if (!contentType || score < minScore) return { klass: "UNKNOWN", method: "FALLBACK_UNKNOWN", confidence: score };
  const klass = BY_TYPE[contentType];
  if (!klass) return { klass: "UNKNOWN", method: "FALLBACK_UNKNOWN", confidence: score };
  return { klass, method: "SEGMENT_CONTENT", confidence: score };
}
