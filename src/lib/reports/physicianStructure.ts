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
      if (enc.substanceClass && enc.substanceClass !== "CLINICAL") continue;
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
    cite: pageCite(enc, doc),
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
      cite: pageCite(enc, doc),
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
  /** Labeled lines, exemplar order: Subjective, Exam, Studies, Assessment, Treatment, Procedure, Plan/Disposition… */
  lines: { label: string; text: string }[];
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
  const lines: { label: string; text: string }[] = [];
  for (const [field, label] of fields) {
    const vals = claimValues(enc, field);
    if (!vals.length) continue;
    // COMPRESSED keeps the exemplar's interval style: one clause per field.
    lines.push({ label, text: depth === "EXPANDED" ? vals.join(". ") : vals[0] });
  }
  if (!lines.length) lines.push({ label: "Record", text: enc.factualSummary });
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
  cite: string;
}

const STUDY_TYPE_RE = /imaging|mri|ct\b|x-?ray|radiograph|ultrasound|emg|ncs|myelogram|dexa|lab|pathology/i;

export function buildDiagnosticStudies(record: StructuredRecord): StudyEntry[] {
  const out: StudyEntry[] = [];
  for (const { enc, doc } of substantive(record)) {
    const findings = claimValues(enc, "diagnosticStudies");
    if (!findings.length) continue;
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
      cite: pageCite(enc, doc),
    });
  }
  return out;
}
