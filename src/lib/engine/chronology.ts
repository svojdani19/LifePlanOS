import { prisma } from "@/lib/db";
import { typeLabel } from "@/lib/documents/taxonomy";
import type { Case } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Medical chronology (Module 4). This does NOT put every uploaded document on
// the timeline. It sorts through all records, keeps only those RELEVANT TO THE
// COMPLAINT (clinical events that bear on the injury), and for each one emits a
// single-sentence summary of the relevant finding plus a link back to the
// source document.
// ─────────────────────────────────────────────────────────────────────────────

// Purely administrative / financial / legal records — never clinical findings.
const EXCLUDED_TYPES = new Set([
  "BILLING_RECORD",
  "INSURANCE_RECORDS",
  "TAX_RECORDS",
  "EMPLOYMENT_RECORDS",
  "WAGE_LOSS_DOCUMENTATION",
  "CORRESPONDENCE",
  "COST_PROJECTION",
  "DEPOSITION",
  "LEGAL_PLEADING",
  "DEMAND_LETTER",
  "SETTLEMENT_AGREEMENT",
  "COURT_ORDER",
  "PHOTOGRAPHS",
  "SURVEILLANCE_VIDEO",
  "EXPERT_REPORT",
  "PEER_REVIEW",
]);

// Core clinical treatment/diagnostic records — kept whenever a finding exists.
const CORE_CLINICAL = new Set([
  "OPERATIVE_NOTE",
  "ANESTHESIA_RECORD",
  "PATHOLOGY_REPORT",
  "ER_RECORD",
  "EMS_REPORT",
  "HOSPITAL_RECORD",
  "DISCHARGE_SUMMARY",
  "NURSING_NOTE",
  "IMAGING_REPORT",
  "EMG_NCS_REPORT",
  "PT_OT_RECORD",
  "SPEECH_THERAPY",
  "CHIROPRACTIC_RECORD",
  "PAIN_MANAGEMENT",
  "ORTHOPEDIC_CLINIC",
  "NEUROLOGY_RECORD",
  "NEUROSURGERY_RECORD",
  "PRIMARY_CARE",
  "IME_REPORT",
  "WOUND_CARE",
]);
// Everything else (labs, pharmacy, neuropsych, generic records, …) is CONDITIONAL:
// included only when its content overlaps the complaint.

const SPECIALTY_KW: Record<string, string[]> = {
  ORTHOPEDIC_TRAUMA: ["fracture", "orthopedic", "hardware", "reduction", "fixation"],
  HIP_ARTHROPLASTY: ["hip", "acetabular", "arthroplasty", "prosthesis"],
  KNEE_ARTHROPLASTY: ["knee", "tibial", "arthroplasty", "meniscus", "patella"],
  SPINE: ["spine", "spinal", "lumbar", "cervical", "thoracic", "vertebra", "burst", "fusion", "canal", "disc", "cord"],
  AMPUTATION: ["amputation", "stump", "prosthesis", "limb"],
  TBI: ["brain", "cognitive", "concussion", "cranial", "anoxic"],
  SPINAL_CORD_INJURY: ["cord", "paraplegia", "quadriplegia", "tetraplegia", "spinal", "neurogenic"],
  CHRONIC_PAIN: ["pain", "chronic", "opioid"],
  CRPS: ["crps", "regional", "dystrophy"],
  BURNS: ["burn", "graft", "scar"],
  BIRTH_INJURY: ["birth", "perinatal", "palsy"],
  NEUROLOGIC: ["neurologic", "nerve", "seizure"],
  PSYCHIATRIC: ["depression", "ptsd", "anxiety"],
  POLYTRAUMA: ["trauma", "fracture", "injury"],
};

const STOP = new Set(["the", "and", "with", "for", "was", "were", "has", "had", "not", "this", "that", "from", "per", "left", "right", "same"]);

function terms(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function complaintTerms(c: Case): Set<string> {
  const set = new Set<string>([...terms(c.diagnosis), ...terms(c.mechanism), ...(SPECIALTY_KW[c.injurySpecialty] ?? [])]);
  return set;
}

// Whole-word match (with optional plural) so short terms like "cord" don't
// falsely match inside "record", or "disc" inside "discharge".
function hasTerm(lower: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`, "i").test(lower);
}

function overlapCount(text: string, complaint: Set<string>): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const t of complaint) if (hasTerm(lower, t)) n++;
  return n;
}

// Labels that introduce the salient clinical finding, in priority order.
const FINDING_LABELS: RegExp[] = [
  /impression:?\s*(.+)/i,
  /procedure performed:?\s*(.+)/i,
  /preoperative diagnosis:?\s*(.+)/i,
  /discharge diagnosis:?\s*(.+)/i,
  /chief complaint:?\s*(.+)/i,
  /findings:?\s*(.+)/i,
  /assessment:?\s*(.+)/i,
  /diagnosis:?\s*(.+)/i,
];

const CLINICAL_KW = ["fracture", "injury", "pain", "surger", "surgical", "procedure", "diagnos", "imaging", "therap", "exercise", "gait", "examination", "deficit", "spine", "spinal", "cord", "trauma", "collision", "symptom", "treatment", "finding", "impression", "reduction", "fixation", "rehab", "cognitive", "neuro", "fusion", "burst", "improvement", "impairment"];

function firstSentence(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  const stop = clean.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? clean.slice(0, stop + 1) : clean;
  return sentence.length > 160 ? sentence.slice(0, 157).trim() + "…" : sentence.trim();
}

/** Pull a single-sentence relevant finding from a record, or null if none. */
export function extractFinding(text: string, complaint: Set<string>): string | null {
  if (!text || text.trim().length < 15) return null;

  for (const re of FINDING_LABELS) {
    const m = text.match(re);
    if (m && m[1]) {
      const s = firstSentence(m[1]);
      if (s.replace(/[^a-z]/gi, "").length > 4) return s;
    }
  }

  // Fallback: split on sentence boundaries AND line breaks (so header lines
  // like "PHYSICAL THERAPY PROGRESS NOTE" don't get merged into the finding),
  // then score each candidate by clinical + complaint keyword hits.
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 12 && !/^[A-Z0-9 :/,\-]+$/.test(s)); // drop ALL-CAPS/label-only header lines
  let best: { s: string; score: number } | null = null;
  for (const s of sentences) {
    const lower = s.toLowerCase();
    let score = 0;
    for (const k of CLINICAL_KW) if (lower.includes(k)) score++;
    for (const t of complaint) if (hasTerm(lower, t)) score += 2;
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best ? firstSentence(best.s) : null;
}

type EventType = "SURGERY" | "IMAGING" | "LAB" | "CLINIC_VISIT" | "ER_VISIT" | "HOSPITALIZATION" | "THERAPY" | "COMPLICATION" | "LEGAL_EVENT" | "BILLING" | "OTHER";

const TYPE_MAP: Partial<Record<string, { eventType: EventType; specialty: string }>> = {
  OPERATIVE_NOTE: { eventType: "SURGERY", specialty: "Surgery" },
  NEUROSURGERY_RECORD: { eventType: "SURGERY", specialty: "Neurosurgery" },
  ANESTHESIA_RECORD: { eventType: "SURGERY", specialty: "Anesthesiology" },
  PATHOLOGY_REPORT: { eventType: "LAB", specialty: "Pathology" },
  ER_RECORD: { eventType: "ER_VISIT", specialty: "Emergency" },
  EMS_REPORT: { eventType: "ER_VISIT", specialty: "EMS" },
  HOSPITAL_RECORD: { eventType: "HOSPITALIZATION", specialty: "Inpatient" },
  DISCHARGE_SUMMARY: { eventType: "HOSPITALIZATION", specialty: "Inpatient" },
  NURSING_NOTE: { eventType: "HOSPITALIZATION", specialty: "Nursing" },
  IMAGING_REPORT: { eventType: "IMAGING", specialty: "Radiology" },
  EMG_NCS_REPORT: { eventType: "IMAGING", specialty: "Neurology" },
  LAB_REPORT: { eventType: "LAB", specialty: "Laboratory" },
  PT_OT_RECORD: { eventType: "THERAPY", specialty: "Rehabilitation" },
  SPEECH_THERAPY: { eventType: "THERAPY", specialty: "Speech Therapy" },
  CHIROPRACTIC_RECORD: { eventType: "THERAPY", specialty: "Chiropractic" },
  PAIN_MANAGEMENT: { eventType: "CLINIC_VISIT", specialty: "Pain Management" },
  ORTHOPEDIC_CLINIC: { eventType: "CLINIC_VISIT", specialty: "Orthopedics" },
  NEUROLOGY_RECORD: { eventType: "CLINIC_VISIT", specialty: "Neurology" },
  PRIMARY_CARE: { eventType: "CLINIC_VISIT", specialty: "Primary Care" },
  IME_REPORT: { eventType: "LEGAL_EVENT", specialty: "Medicolegal" },
};

const CONTENT_COMPLICATION = ["infection", "purulent", "dehiscence", "readmitted", "complication", "hardware failure", "nonunion", "reoperation"];

function classifyEvent(type: string, text: string): { eventType: EventType; specialty: string } {
  const lower = text.toLowerCase();
  if (CONTENT_COMPLICATION.some((k) => lower.includes(k))) return { eventType: "COMPLICATION", specialty: TYPE_MAP[type]?.specialty ?? "Provider" };
  return TYPE_MAP[type] ?? { eventType: "CLINIC_VISIT", specialty: "Provider" };
}

// Date extraction — 2024-06-12 | 06/12/2024 | June 12, 2024.
const ISO_RE = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
const SLASH_RE = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WORD_RE = new RegExp(`\\b(${MONTHS.join("|")})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "gi");
const pad = (n: string | number) => String(n).padStart(2, "0");

export function extractDates(text: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const iso = new RegExp(ISO_RE);
  while ((m = iso.exec(text))) found.add(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  const slash = new RegExp(SLASH_RE);
  while ((m = slash.exec(text))) found.add(`${m[3]}-${pad(m[1])}-${pad(m[2])}`);
  const word = new RegExp(WORD_RE);
  while ((m = word.exec(text))) {
    const mm = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (mm > 0) found.add(`${m[3]}-${pad(mm)}-${pad(m[2])}`);
  }
  return [...found].filter((d) => {
    const [y, mo, da] = d.split("-").map(Number);
    return mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && y >= 2000 && y <= 2100;
  });
}

export interface RelevanceResult {
  kept: number;
  screened: number; // total records reviewed
  excluded: number;
}

/**
 * Rebuild a case's chronology from the records that are relevant to the
 * complaint. Returns how many were kept vs. screened out.
 */
export async function buildChronologyFromRecords(caseId: string): Promise<RelevanceResult> {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const docs = await prisma.document.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  const complaint = complaintTerms(c);
  const anchor = c.dateOfInjury ?? c.createdAt;

  await prisma.chronologyEvent.deleteMany({ where: { caseId } });
  if (docs.length === 0) return { kept: 0, screened: 0, excluded: 0 };

  type Draft = {
    eventDate: Date;
    eventType: EventType;
    specialty: string;
    recordType: string;
    summary: string;
    relevanceScore: number;
    sourceDocumentId: string;
    dateInferred: boolean;
  };
  const drafts: Draft[] = [];

  for (const doc of docs) {
    if (EXCLUDED_TYPES.has(doc.type)) continue; // administrative / legal — not a clinical finding

    const text = doc.extractedText ?? "";
    const finding = extractFinding(text, complaint);
    if (!finding) continue; // no relevant finding could be pulled → not on the timeline

    const isCore = CORE_CLINICAL.has(doc.type);
    const overlap = overlapCount(text, complaint);
    if (!isCore && overlap === 0) continue; // conditional record with no bearing on the complaint

    const { eventType, specialty } = classifyEvent(doc.type, text);
    const dates = extractDates(text);
    const iso = dates[0];
    drafts.push({
      eventDate: iso ? new Date(`${iso}T00:00:00Z`) : (doc.serviceDate ?? anchor),
      eventType,
      specialty,
      recordType: typeLabel(doc.type),
      summary: finding,
      relevanceScore: Math.min(100, 40 + overlap * 12 + (isCore ? 20 : 0)),
      sourceDocumentId: doc.id,
      dateInferred: !iso,
    });
  }

  drafts.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());

  if (drafts.length > 0) {
    await prisma.chronologyEvent.createMany({
      data: drafts.map((d) => ({
        caseId,
        eventDate: d.eventDate,
        eventType: d.eventType,
        specialty: d.specialty,
        recordType: d.recordType,
        summary: d.summary,
        relevanceScore: d.relevanceScore,
        sourceDocumentId: d.sourceDocumentId,
        sourcePage: 1,
        dateInferred: d.dateInferred,
        relatedness: "RELATED",
      })),
    });
  }

  return { kept: drafts.length, screened: docs.length, excluded: docs.length - drafts.length };
}
