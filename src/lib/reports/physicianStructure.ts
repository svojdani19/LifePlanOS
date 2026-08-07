// ─────────────────────────────────────────────────────────────────────────────
// Physician-structured record presentation.
//
// Modeled on how a physician life-care planner actually communicates a record
// review — four coordinated structures, derived here from data the pipeline
// already holds (validated encounters and their cited claims):
//
//   1. A COMPLETE VISIT LEDGER: every substantive visit, dated, attributed,
//      and page-cited, headed by totals. Its job is demonstrable completeness.
//   2. A DIAGNOSES-EVOLUTION TABLE: how the diagnostic picture changed across
//      providers over time, with citations.
//   3. PER-ENCOUNTER NARRATIVES with GRADED DEPTH: pivotal encounters in full
//      labeled S/E/A/P detail; interval visits compressed; hospitalization
//      days grouped into admission arcs; pre-injury care in its own band.
//   4. A DIAGNOSTIC STUDIES section: findings and impressions per study.
//
// Everything rendered is claim-backed and page-cited. There are deliberately
// NO item caps in this module: a physician's ledger does not stop at 40 rows,
// and neither does this one. What stays constrained is grounding — nothing
// appears here that does not trace to a validated claim.
// ─────────────────────────────────────────────────────────────────────────────

import type { StructuredRecord, StructuredEncounter, StructuredDocument } from "@/lib/records/structuredRecord";
import { pageRange } from "@/lib/documents/meta";
import { admissibleToMedicalTimeline, KIND_LABEL } from "@/lib/records/encounterSubstance";

const mdY = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

/** Encounters that belong in the substantive-record structures. */
function substantive(record: StructuredRecord): { enc: StructuredEncounter; doc: StructuredDocument }[] {
  const out: { enc: StructuredEncounter; doc: StructuredDocument }[] = [];
  for (const doc of record.documents) {
    for (const enc of doc.encounters) {
      if (enc.status === "STALE") continue;
      // Admission to the physician's ledger and narratives is decided by the
      // KIND of document the row came from. Testimony, billing, legal
      // assertions and unclassified material can no longer reach the treating
      // record through a field-name fallback.
      if (!admissibleToMedicalTimeline(enc)) continue;
      out.push({ enc, doc });
    }
  }
  return out.sort((a, b) => (a.enc.encounterDate ?? "9999").localeCompare(b.enc.encounterDate ?? "9999") || (a.enc.page ?? 0) - (b.enc.page ?? 0));
}

/** Rows from documents of the given kinds, in date order. */
function ofClasses(record: StructuredRecord, classes: string[]): { enc: StructuredEncounter; doc: StructuredDocument }[] {
  const out: { enc: StructuredEncounter; doc: StructuredDocument }[] = [];
  for (const doc of record.documents) {
    for (const enc of doc.encounters) {
      if (enc.status === "STALE") continue;
      if (!enc.analysisClass || !classes.includes(enc.analysisClass)) continue;
      out.push({ enc, doc });
    }
  }
  return out.sort((a, b) => (a.enc.encounterDate ?? "9999").localeCompare(b.enc.encounterDate ?? "9999") || (a.enc.page ?? 0) - (b.enc.page ?? 0));
}

function claimValues(enc: StructuredEncounter, field: string): string[] {
  return [...new Set(enc.claims.filter((c) => c.field === field).map((c) => c.value.replace(/\s+/g, " ").trim()))];
}

function pageCite(enc: StructuredEncounter, doc: StructuredDocument): string {
  const pages = enc.page != null ? (enc.pageEnd != null && enc.pageEnd !== enc.page ? `p. ${enc.page}–${enc.pageEnd}` : `p. ${enc.page}`) : "page unknown";
  return `(${doc.filename}: ${pages})`;
}

/** Pages of the claims that produced one field's text. */
function claimPages(enc: StructuredEncounter, ...fields: string[]): number[] {
  return enc.claims.filter((c) => fields.includes(c.field) && c.page != null).map((c) => c.page!);
}

/**
 * Cite the page the STATEMENT is on, not the span of the encounter that
 * contains it. On a 40-page operative admission, "(p. 4–43)" tells a reader
 * nothing they can check; "(p. 31)" sends them to the sentence. Falls back to
 * the encounter span only when the claims carry no page of their own.
 */
function claimCite(enc: StructuredEncounter, doc: StructuredDocument, pages: number[]): string {
  const compact = pageRange(pages);
  return compact ? `(${doc.filename}: p. ${compact})` : pageCite(enc, doc);
}

/** Inline data-quality caveat, physician-style. */
function qualityNote(enc: StructuredEncounter): string | null {
  if (enc.ocrConfidence != null && enc.ocrConfidence < 0.8) {
    return `The provided note was partially illegible (OCR confidence ${Math.round(enc.ocrConfidence * 100)}%).`;
  }
  if (enc.warnings.some((w) => /low-confidence OCR/i.test(w))) return "The provided note was partially illegible.";
  return null;
}

// ── 1. Visit ledger ──────────────────────────────────────────────────────────

export interface LedgerLine {
  date: string; // MM/DD/YYYY
  who: string; // provider, credentials / facility
  procedure: boolean;
  cite: string;
}

export interface VisitLedger {
  totalDocuments: number;
  totalPages: number;
  visitSpan: { from: string; to: string } | null;
  lines: LedgerLine[];
  undatedCount: number;
}

export function buildVisitLedger(record: StructuredRecord): VisitLedger {
  const rows = substantive(record);
  const dated = rows.filter((r) => r.enc.encounterDate);
  const lines: LedgerLine[] = dated.map(({ enc, doc }) => ({
    date: mdY(enc.encounterDate!),
    who: [
      [enc.provider, enc.providerCredentials && enc.provider && !enc.provider.includes(enc.providerCredentials) ? enc.providerCredentials : null]
        .filter(Boolean)
        .join(", ") || "Provider not identified",
      enc.facility,
    ]
      .filter(Boolean)
      .join(" / "),
    procedure: claimValues(enc, "procedure").length > 0,
    // A procedure line cites the procedure itself; an ordinary visit cites the
    // note.
    cite: claimValues(enc, "procedure").length ? claimCite(enc, doc, claimPages(enc, "procedure")) : pageCite(enc, doc),
  }));
  const isoDates = dated.map((r) => r.enc.encounterDate!).sort();
  return {
    totalDocuments: record.documents.length,
    totalPages: record.documents.reduce((s, d) => s + (d.pageCount ?? 0), 0),
    visitSpan: isoDates.length ? { from: mdY(isoDates[0]), to: mdY(isoDates[isoDates.length - 1]) } : null,
    lines,
    undatedCount: rows.length - dated.length,
  };
}

// ── 2. Diagnoses evolution ───────────────────────────────────────────────────

export interface DiagnosisRow {
  date: string;
  who: string;
  diagnoses: string;
  cite: string;
}

export function buildDiagnosesEvolution(record: StructuredRecord): DiagnosisRow[] {
  const out: DiagnosisRow[] = [];
  for (const { enc, doc } of substantive(record)) {
    if (!enc.encounterDate) continue;
    const dx = claimValues(enc, "assessment");
    if (!dx.length) continue;
    out.push({
      date: mdY(enc.encounterDate),
      who: [enc.provider ?? "Provider not identified", enc.facility].filter(Boolean).join(" / "),
      diagnoses: dx.join("; "),
      cite: claimCite(enc, doc, claimPages(enc, "assessment")),
    });
  }
  return out;
}

// ── 3. Graded encounter narratives ───────────────────────────────────────────

export type NarrativeDepth = "EXPANDED" | "COMPRESSED";

export interface EncounterNarrative {
  date: string | null; // MM/DD/YYYY or null for undated
  heading: string;
  depth: NarrativeDepth;
  /**
   * Labeled lines, exemplar order: Subjective, Exam, Studies, Assessment,
   * Treatment, Procedure, Plan/Disposition… Each carries the page of the
   * claims that produced IT, so a reader checking one statement is not sent to
   * a forty-page span.
   */
  lines: { label: string; text: string; cite: string | null }[];
  qualityNote: string | null;
  cite: string;
}

export interface AdmissionEpisode {
  kind: "EPISODE";
  facility: string;
  from: string;
  to: string;
  members: EncounterNarrative[];
}

export interface SingleNarrative {
  kind: "SINGLE";
  narrative: EncounterNarrative;
}

export type NarrativeBlock = AdmissionEpisode | SingleNarrative;

export interface NarrativeSections {
  /** Care predating the injury — presented as its own band, never mixed in. */
  priorHistory: NarrativeBlock[];
  /** The injury-related course. When no DOI is known, everything lands here. */
  course: NarrativeBlock[];
}

const NARRATIVE_FIELDS: [string, string][] = [
  ["subjective", "Subjective"],
  ["pastMedicalHistory", "History"],
  ["objectiveFindings", "Exam"],
  ["diagnosticStudies", "Diagnostic studies"],
  ["assessment", "Assessment"],
  ["procedure", "Procedure"],
  ["treatment", "Treatment"],
  ["medications", "Medications"],
  ["responseToTreatment", "Response"],
  ["functionalStatus", "Functional status"],
  ["workStatus", "Work status"],
  ["restrictions", "Restrictions"],
  ["recommendations", "Recommendations"],
  ["disposition", "Disposition"],
  ["contradictions", "Contradiction / adverse finding"],
];

/** Pivotal encounters earn full depth, exactly as the exemplar grades them. */
export function narrativeDepth(enc: StructuredEncounter, seenProviders: Set<string>, seenDx: Set<string>): NarrativeDepth {
  const type = (enc.encounterType ?? "").toLowerCase();
  if (/surg|operat|procedure|emergency|hospital|inpatient|admission|imaging|mri|ct\b|x-?ray/.test(type)) return "EXPANDED";
  if (claimValues(enc, "procedure").length) return "EXPANDED";
  const providerKey = (enc.provider ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (providerKey && !seenProviders.has(providerKey)) return "EXPANDED"; // first visit with this clinician
  const dx = claimValues(enc, "assessment").join(";").toLowerCase();
  if (dx && !seenDx.has(dx)) return "EXPANDED"; // new or changed assessment
  if (claimValues(enc, "contradictions").length) return "EXPANDED";
  return "COMPRESSED";
}

function toNarrative(enc: StructuredEncounter, doc: StructuredDocument, depth: NarrativeDepth): EncounterNarrative {
  const heading = [
    enc.encounterDate ? mdY(enc.encounterDate) : "Undated (date requires review)",
    "-",
    [enc.provider ?? "Provider not identified", enc.facility].filter(Boolean).join(" / "),
    enc.encounterType ? `- ${enc.encounterType}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const fields = depth === "EXPANDED" ? NARRATIVE_FIELDS : NARRATIVE_FIELDS.filter(([f]) => ["subjective", "assessment", "treatment", "responseToTreatment"].includes(f));
  const lines: { label: string; text: string; cite: string | null }[] = [];
  const encCite = pageCite(enc, doc);
  for (const [field, label] of fields) {
    const vals = claimValues(enc, field);
    if (!vals.length) continue;
    // COMPRESSED keeps the exemplar's interval style: one clause per field.
    const cite = claimCite(enc, doc, claimPages(enc, field));
    lines.push({
      label,
      text: depth === "EXPANDED" ? vals.join(". ") : vals[0],
      // Suppress a per-line cite that adds nothing beyond the encounter's own.
      cite: cite === encCite ? null : cite,
    });
  }
  if (!lines.length) lines.push({ label: "Record", text: enc.factualSummary, cite: null });
  return { date: enc.encounterDate ? mdY(enc.encounterDate) : null, heading, depth, lines, qualityNote: qualityNote(enc), cite: pageCite(enc, doc) };
}

const INPATIENT_RE = /hospital|inpatient|admission|med.?surg|icu|emergency department observation/i;

/** Consecutive same-facility inpatient days become one admission arc. */
function groupEpisodes(items: { enc: StructuredEncounter; doc: StructuredDocument; narrative: EncounterNarrative }[]): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = [];
  let episode: AdmissionEpisode | null = null;
  const facilityKey = (e: StructuredEncounter) => (e.facility ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const isInpatient = (e: StructuredEncounter) => INPATIENT_RE.test(`${e.encounterType ?? ""} ${e.facility ?? ""}`);
  const dayDiff = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

  for (const item of items) {
    const { enc, narrative } = item;
    const inpatient = isInpatient(enc) && enc.encounterDate;
    if (inpatient && episode && facilityKey(enc) === episode.facility.toLowerCase().replace(/[^a-z]+/g, " ").trim() && dayDiff(enc.encounterDate!, episode.members[episode.members.length - 1].date ? isoOf(episode.members[episode.members.length - 1].date!) : enc.encounterDate!) <= 2) {
      episode.members.push(narrative);
      episode.to = mdY(enc.encounterDate!);
      continue;
    }
    if (episode) blocks.push(episode), (episode = null);
    if (inpatient && enc.facility) {
      episode = { kind: "EPISODE", facility: enc.facility, from: mdY(enc.encounterDate!), to: mdY(enc.encounterDate!), members: [narrative] };
      continue;
    }
    blocks.push({ kind: "SINGLE", narrative });
  }
  if (episode) blocks.push(episode);
  // An "episode" of one day with one entry reads better as a single narrative.
  return blocks.map((b) => (b.kind === "EPISODE" && b.members.length === 1 ? ({ kind: "SINGLE", narrative: b.members[0] } as SingleNarrative) : b));
}

const isoOf = (mdy: string) => {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m}-${d}`;
};

export function buildNarratives(record: StructuredRecord, dateOfInjury: Date | null | undefined): NarrativeSections {
  const doiIso = dateOfInjury ? dateOfInjury.toISOString().slice(0, 10) : null;
  const seenProviders = new Set<string>();
  const seenDx = new Set<string>();
  const prior: { enc: StructuredEncounter; doc: StructuredDocument; narrative: EncounterNarrative }[] = [];
  const course: typeof prior = [];

  for (const { enc, doc } of substantive(record)) {
    const depth = narrativeDepth(enc, seenProviders, seenDx);
    const providerKey = (enc.provider ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
    if (providerKey) seenProviders.add(providerKey);
    const dx = claimValues(enc, "assessment").join(";").toLowerCase();
    if (dx) seenDx.add(dx);
    const narrative = toNarrative(enc, doc, depth);
    const isPrior = doiIso && enc.encounterDate && enc.encounterDate < doiIso;
    (isPrior ? prior : course).push({ enc, doc, narrative });
  }
  return { priorHistory: groupEpisodes(prior), course: groupEpisodes(course) };
}

// ── 4. Diagnostic studies ────────────────────────────────────────────────────

export interface StudyEntry {
  date: string | null;
  heading: string;
  findings: string[];
  /** Protocol or technique, when the report states one. */
  technique: string[];
  /** Prior study compared against. */
  comparison: string[];
  /** The interpreting physician's conclusion — the part the record relies on. */
  impression: string[];
  /** The interpreting radiologist/physician, not a treating provider. */
  interpretedBy: string | null;
  cite: string;
}

const STUDY_TYPE_RE = /imaging|mri|ct\b|x-?ray|radiograph|ultrasound|emg|ncs|myelogram|dexa|lab|pathology/i;

export function buildDiagnosticStudies(record: StructuredRecord): StudyEntry[] {
  const out: StudyEntry[] = [];
  for (const { enc, doc } of substantive(record)) {
    const findings = claimValues(enc, "diagnosticStudies");
    const impression = claimValues(enc, "impression");
    const technique = claimValues(enc, "studyTechnique");
    const comparison = claimValues(enc, "comparison");
    // An imaging report whose value is its IMPRESSION was previously dropped
    // entirely when it stated no separate "findings" line.
    if (!findings.length && !impression.length) continue;
    const isStudyEncounter = STUDY_TYPE_RE.test(enc.encounterType ?? "");
    out.push({
      date: enc.encounterDate ? mdY(enc.encounterDate) : null,
      heading: [
        enc.encounterDate ? mdY(enc.encounterDate) : "Undated",
        "-",
        isStudyEncounter ? enc.encounterType : `Studies documented at ${enc.encounterType ?? "encounter"}`,
        enc.provider ? `- ${enc.provider}` : null,
      ]
        .filter(Boolean)
        .join(" "),
      findings,
      technique,
      comparison,
      impression,
      // The interpreting physician, not a treating provider.
      interpretedBy: enc.attributionName ?? enc.provider ?? null,
      cite: claimCite(enc, doc, claimPages(enc, "diagnosticStudies", "impression", "studyTechnique", "comparison")),
    });
  }
  return out;
}

// ── 5. Operative reports ─────────────────────────────────────────────────────

export interface OperativeReport {
  date: string | null;
  heading: string;
  surgeon: string | null;
  /** Labeled operative fields, in the order a surgeon states them. */
  lines: { label: string; text: string; cite: string | null }[];
  cite: string;
}

const OPERATIVE_ORDER: [string, string][] = [
  ["preOperativeDiagnosis", "Pre-operative diagnosis"],
  ["postOperativeDiagnosis", "Post-operative diagnosis"],
  ["procedure", "Procedure performed"],
  ["operativeFindings", "Operative findings"],
  ["implants", "Implants / hardware"],
  ["anesthesia", "Anesthesia"],
  ["estimatedBloodLoss", "Estimated blood loss"],
  ["specimen", "Specimen"],
  ["complications", "Complications"],
  ["disposition", "Disposition"],
  ["recommendations", "Post-operative plan"],
];

/**
 * One entry per operation, with the fields an operative report actually has.
 * These were extracted but had nowhere to appear: the narrative renderer only
 * knew S/O/A/P, so an operation's findings, implants and complications were
 * captured and then dropped.
 */
export function buildOperativeReports(record: StructuredRecord): OperativeReport[] {
  const out: OperativeReport[] = [];
  for (const { enc, doc } of ofClasses(record, ["OPERATIVE"])) {
    const lines: { label: string; text: string; cite: string | null }[] = [];
    const encCite = pageCite(enc, doc);
    for (const [field, label] of OPERATIVE_ORDER) {
      const vals = claimValues(enc, field);
      if (!vals.length) continue;
      const cite = claimCite(enc, doc, claimPages(enc, field));
      lines.push({ label, text: vals.join(". "), cite: cite === encCite ? null : cite });
    }
    if (!lines.length) continue;
    out.push({
      date: enc.encounterDate ? mdY(enc.encounterDate) : null,
      heading: [enc.encounterDate ? mdY(enc.encounterDate) : "Undated", "-", enc.encounterType ?? "Operative report", enc.facility ? `- ${enc.facility}` : null]
        .filter(Boolean)
        .join(" "),
      surgeon: enc.attributionName ?? enc.provider ?? null,
      lines,
      cite: encCite,
    });
  }
  return out;
}

// ── 6. Expert opinions ───────────────────────────────────────────────────────

export interface ExpertOpinionSection {
  date: string | null;
  expert: string | null;
  role: string | null;
  lines: { label: string; text: string; cite: string | null }[];
  cite: string;
}

const EXPERT_ORDER: [string, string][] = [
  ["objectiveFindings", "Examination findings"],
  ["assessment", "Stated diagnoses"],
  ["causationOpinion", "Causation / apportionment opinion"],
  ["opinion", "Stated opinion"],
  ["workStatus", "Work-capacity opinion"],
  ["restrictions", "Restrictions"],
  ["functionalStatus", "Functional status"],
  ["recommendations", "Future-care opinion"],
  ["pastMedicalHistory", "History relied upon"],
];

/**
 * Expert evaluations, kept ATTRIBUTED. Every line here is what a named
 * examiner concluded, never a fact the record establishes — an IME's opinion
 * restated as a finding is the most consequential silent upgrade available in
 * a medicolegal file.
 */
export function buildExpertOpinions(record: StructuredRecord): ExpertOpinionSection[] {
  const out: ExpertOpinionSection[] = [];
  for (const { enc, doc } of ofClasses(record, ["EXPERT_OPINION"])) {
    const lines: { label: string; text: string; cite: string | null }[] = [];
    const encCite = pageCite(enc, doc);
    for (const [field, label] of EXPERT_ORDER) {
      const vals = claimValues(enc, field);
      if (!vals.length) continue;
      const cite = claimCite(enc, doc, claimPages(enc, field));
      lines.push({ label, text: vals.join(". "), cite: cite === encCite ? null : cite });
    }
    if (!lines.length) continue;
    out.push({
      date: enc.encounterDate ? mdY(enc.encounterDate) : null,
      expert: enc.attributionName ?? enc.provider ?? null,
      role: enc.attributionRole ?? "examining or opining expert",
      lines,
      cite: encCite,
    });
  }
  return out;
}

// ── 7. Attributed non-clinical evidence ──────────────────────────────────────

export interface EvidenceEntry {
  kind: string; // human label for the document kind
  date: string | null;
  attribution: string | null;
  attributionRole: string | null;
  lines: { label: string; text: string; cite: string | null }[];
  cite: string;
  requiresReview: boolean;
}

const EVIDENCE_LABEL: Record<string, string> = {
  testimony: "Testimony",
  admission: "Admission against interest",
  charge: "Charge",
  serviceCode: "Service code",
  billedAmount: "Amount",
  payer: "Payer",
  legalAssertion: "Assertion",
  reliefSought: "Relief sought",
  partyPosition: "Party position",
  employer: "Employer",
  employmentStatus: "Employment status",
  earnings: "Earnings / wage",
  coverage: "Coverage",
  claimStatus: "Claim status",
  authorization: "Authorization",
  mechanism: "Mechanism of injury",
  sceneFindings: "Scene findings",
  witnessStatement: "Reported statement",
  documentContent: "Document content",
  deviceIdentifier: "Device identifier",
  manufacturer: "Manufacturer",
  implants: "Device",
  functionalStatus: "Functional status",
  workStatus: "Work status",
  restrictions: "Restrictions",
  pastMedicalHistory: "History",
  contradictions: "Contradiction / adverse finding",
};

const EVIDENCE_CLASSES = [
  "TESTIMONY",
  "FINANCIAL",
  "EMPLOYMENT_ECONOMIC",
  "INSURANCE_ADMINISTRATIVE",
  "LEGAL",
  "DEVICE_OR_IMPLANT",
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
  "UNKNOWN",
  "INCIDENT",
];

/**
 * Everything that is evidence in the case but is NOT treating medical care:
 * testimony, billing, employment and economic records, insurance
 * administration, legal filings, device logs, correspondence, incident
 * narratives, and material whose kind could not be established.
 *
 * It stays fully visible and searchable, in its own vocabulary, attributed to
 * whoever authored it — and out of the treating chronology.
 */
export function buildAttributedEvidence(record: StructuredRecord): EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  for (const { enc, doc } of ofClasses(record, EVIDENCE_CLASSES)) {
    const encCite = pageCite(enc, doc);
    const byField = new Map<string, string[]>();
    for (const c of enc.claims) {
      const arr = byField.get(c.field) ?? [];
      arr.push(c.value.replace(/\s+/g, " ").trim());
      byField.set(c.field, arr);
    }
    const lines = [...byField.entries()].map(([field, vals]) => {
      const cite = claimCite(enc, doc, claimPages(enc, field));
      return { label: EVIDENCE_LABEL[field] ?? field, text: [...new Set(vals)].join(". "), cite: cite === encCite ? null : cite };
    });
    if (!lines.length) lines.push({ label: "Record", text: enc.factualSummary, cite: null });
    out.push({
      kind: KIND_LABEL[enc.analysisClass ?? ""] ?? "Evidence",
      date: enc.encounterDate ? mdY(enc.encounterDate) : null,
      attribution: enc.attributionName ?? null,
      attributionRole: enc.attributionRole ?? null,
      lines,
      cite: encCite,
      requiresReview: enc.analysisClass === "UNKNOWN",
    });
  }
  return out;
}
