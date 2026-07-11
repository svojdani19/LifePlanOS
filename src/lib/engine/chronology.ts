import { prisma } from "@/lib/db";
import { typeLabel } from "@/lib/documents/taxonomy";
import type { Case } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Medical chronology (Module 4). This does NOT put every uploaded document on
// the timeline. It sorts through all records and keeps only the clinically
// PIVOTAL events and those that bear on a DIAGNOSIS or an anticipated FUTURE-CARE
// item. For each kept event it extracts specific detail (objective findings,
// assessment/diagnosis, treatment, imaging, functional impact, work status) and
// states the event's clinical significance — which diagnosis it documents and
// which future care it grounds — with a link back to the source record.
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

// Pull the remainder of the line after a labeled section header, trimmed. Used
// to lift the specific clinical detail out of a record (findings, assessment,
// procedure, plan …) rather than restating the whole note.
// Non-informative section values (e.g. a post-op diagnosis of "Same") — skip so
// the extractor falls through to a meaningful label.
const UNINFORMATIVE = /^(same(\s+as\s+above)?|as\s+above|see\s+above|unchanged|none|n\/?a|not\s+applicable|deferred|noted?)\b/i;
function pickSection(text: string, labels: RegExp[], max = 200): string | null {
  for (const re of labels) {
    const m = text.match(re);
    if (m && m[1]) {
      const v = m[1].replace(/\s+/g, " ").trim().replace(/[;,]\s*$/, "");
      if (v.replace(/[^a-z]/gi, "").length > 3 && !UNINFORMATIVE.test(v)) return v.length > max ? v.slice(0, max - 1).trim() + "…" : v;
    }
  }
  return null;
}

const SECTIONS = {
  objectiveFindings: [/\bfindings:?\s*([^\n]+)/i, /\bimpression:?\s*([^\n]+)/i, /physical exam(?:ination)?:?\s*([^\n]+)/i, /objective:?\s*([^\n]+)/i],
  diagnosis: [/post-?operative diagnosis:?\s*([^\n]+)/i, /pre-?operative diagnosis:?\s*([^\n]+)/i, /discharge diagnosis:?\s*([^\n]+)/i, /assessment(?:\s*&?\s*(?:and\s*)?plan)?:?\s*([^\n]+)/i, /diagnos[ie]s:?\s*([^\n]+)/i, /\bimpression:?\s*([^\n]+)/i],
  treatment: [/procedure performed:?\s*([^\n]+)/i, /\boperation:?\s*([^\n]+)/i, /plan of care:?\s*([^\n]+)/i, /\btreatment:?\s*([^\n]+)/i, /\bplan:?\s*([^\n]+)/i, /intervention:?\s*([^\n]+)/i],
  imaging: [/\bimpression:?\s*([^\n]+)/i, /\bfindings:?\s*([^\n]+)/i],
  functional: [/(?:functional status|ambulation|gait|range of motion|\badls?\b|transfers?)[^:\n]{0,26}:?\s*([^\n]+)/i, /(gait training[^\n]+)/i, /(range of motion[^\n]+)/i],
  work: [/(?:work status|return to work|disability status)[^:\n]{0,20}:?\s*([^\n]+)/i, /(maximum medical improvement[^\n]*)/i],
  restrictions: [/(?:restrictions?|limitations?|precautions?|weight[- ]bearing)[^:\n]{0,20}:?\s*([^\n]+)/i],
  provider: [/(?:surgeon|dictated by|therapist|examiner|attending|physician|provider|author|reported by):?\s*([A-Z][^\n]+)/i],
};

// Significant, non-generic terms — for matching an event to a diagnosis or a
// future-care service. Anatomy/procedure words are kept; filler is dropped.
const SIG_STOP = new Set([...STOP, "patient", "status", "note", "record", "records", "visit", "visits", "history", "clinical", "management", "care", "chronic", "severe", "acute", "initial", "residual", "incomplete", "follow", "followup", "ongoing", "maintenance", "general", "exam", "examination", "reached", "provided", "report", "review", "medical", "additional"]);
// Words too generic to link an event to a specific future-care service — care
// linkage must be driven by anatomy/pathology (knee, lumbar, arthroplasty…), not
// by who wrote the note or a bare action word.
const CARE_GENERIC = new Set([
  "therapy", "therapies", "visit", "visits", "follow", "followup", "management", "care", "medication", "medications",
  "supplies", "surveillance", "evaluation", "injection", "injections", "brace", "unit", "equipment", "ongoing",
  "maintenance", "general", "coordination", "office", "surgery", "surgical", "surgeon", "procedure", "operative",
  "preoperative", "postoperative", "clinic", "provider", "physician", "specialist", "consultation", "orthopedic",
  "orthopaedic", "neurology", "neurologic", "physiatry", "nursing", "assistive", "devices", "device", "serial",
  "injury", "injuries", "condition", "episodes", "anticipated", "rehabilitation", "rehab",
]);
// Pathology words too common to establish a SPECIFIC diagnosis match on their own
// ("fracture" appears in many diagnoses); a real match needs a distinctive term.
const DX_GENERIC = new Set(["fracture", "fractures", "injury", "injuries", "pain", "disorder", "syndrome", "disease", "deficit", "dysfunction", "residual"]);

function sigTerms(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !SIG_STOP.has(w)))];
}

// Does the event text speak to this diagnosis? Requires a DISTINCTIVE shared term
// (anatomy/pathology beyond the generic ones) so "fracture" alone can't make a
// lumbar MRI "document" a tibial-plateau fracture.
function documentsDiagnosis(hay: string, name: string): boolean {
  const shared = sigTerms(name).filter((t) => hasTerm(hay, t));
  const distinctive = shared.filter((t) => !DX_GENERIC.has(t));
  return distinctive.length > 0 && (distinctive.some((t) => t.length >= 5) || shared.length >= 2);
}

// Which anticipated future-care services this event grounds — a shared
// distinctive anatomy/procedure term (not a generic care/role word).
function groundsCare(hay: string, service: string): boolean {
  return sigTerms(service).some((t) => t.length >= 4 && !CARE_GENERIC.has(t) && hasTerm(hay, t));
}

function humanList(items: string[]): string {
  const u = [...new Set(items)];
  if (u.length <= 1) return u[0] ?? "";
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  return `${u.slice(0, -1).join(", ")}, and ${u[u.length - 1]}`;
}

// One sentence tying the event to the causation map and the care plan.
function significance(hay: string, condNames: string[], careServices: string[]): string | null {
  const dx = condNames.filter((n) => documentsDiagnosis(hay, n));
  const care = careServices.filter((s) => groundsCare(hay, s)).slice(0, 3);
  const parts: string[] = [];
  if (dx.length) parts.push(`Documents ${humanList(dx.slice(0, 2))}`);
  if (care.length) parts.push(`${dx.length ? "supports the anticipated" : "Supports the anticipated"} ${humanList(care)}`);
  if (!parts.length) return null;
  return parts.join("; ") + ".";
}

// Compose a specific event summary from the extracted detail.
function composeSummary(fields: { treatment?: string | null; diagnosis?: string | null; objectiveFindings?: string | null; imaging?: string | null }, fallback: string): string {
  const { treatment, diagnosis, objectiveFindings, imaging } = fields;
  if (treatment && diagnosis) return firstSentence(`${treatment} for ${diagnosis.replace(/\.$/, "")}`.replace(/\s+/g, " "));
  if (treatment) return firstSentence(treatment);
  if (imaging) return firstSentence(imaging);
  if (objectiveFindings) return firstSentence(objectiveFindings);
  if (diagnosis) return firstSentence(diagnosis);
  return fallback;
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

// Pivotal event types that belong on any medical chronology even absent an
// explicit diagnosis/care keyword overlap (they establish the injury course).
const PIVOTAL: Set<EventType> = new Set(["SURGERY", "ER_VISIT", "HOSPITALIZATION", "IMAGING", "COMPLICATION"]);

export interface ChronologyContext {
  /** diagnosis / condition names for this case (for event significance) */
  conditions?: string[];
  /** anticipated future-care service names (for event significance) */
  careServices?: string[];
}

/**
 * Rebuild a case's chronology from the records. Keeps the clinically pivotal
 * events and those bearing on a diagnosis or an anticipated future-care item —
 * not every document — and describes each specifically, stating which diagnosis
 * it documents and which future care it grounds. Returns kept vs. screened.
 */
export async function buildChronologyFromRecords(caseId: string, ctx: ChronologyContext = {}): Promise<RelevanceResult> {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const docs = await prisma.document.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  const complaint = complaintTerms(c);
  const anchor = c.dateOfInjury ?? c.createdAt;

  // Diagnosis & future-care targets — fall back to the DB when the caller (e.g.
  // a standalone refresh) doesn't pass them, so significance still populates.
  const condNames =
    ctx.conditions ??
    (await prisma.condition.findMany({ where: { caseId }, select: { name: true } })).map((x) => x.name);
  if (c.diagnosis && !condNames.some((n) => n.toLowerCase() === c.diagnosis!.toLowerCase())) condNames.unshift(c.diagnosis);
  const careServices =
    ctx.careServices ??
    (await prisma.futureCareItem.findMany({ where: { caseId }, select: { service: true } })).map((x) => x.service);
  // Distinctive terms that make a record "on-point" for this case: diagnoses +
  // future care, excluding generic pathology/care words so a bare "injury" or
  // "rehabilitation" mention can't keep an otherwise-irrelevant note.
  const targets = new Set<string>(complaint);
  for (const n of condNames) for (const t of sigTerms(n)) if (!DX_GENERIC.has(t)) targets.add(t);
  for (const s of careServices) for (const t of sigTerms(s)) if (!CARE_GENERIC.has(t) && !DX_GENERIC.has(t)) targets.add(t);

  await prisma.chronologyEvent.deleteMany({ where: { caseId } });
  if (docs.length === 0) return { kept: 0, screened: 0, excluded: 0 };

  type Draft = {
    eventDate: Date;
    eventType: EventType;
    specialty: string;
    provider: string | null;
    recordType: string;
    summary: string;
    objectiveFindings: string | null;
    diagnosis: string | null;
    treatment: string | null;
    imagingFindings: string | null;
    functionalStatus: string | null;
    workStatus: string | null;
    restrictions: string | null;
    clinicalSignificance: string | null;
    sourceQuote: string | null;
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

    const { eventType, specialty } = classifyEvent(doc.type, text);
    const hay = `${finding}\n${text}`.toLowerCase();
    const targetOverlap = overlapCount(text, targets);
    const sig = significance(hay, condNames, careServices);
    const isPivotal = PIVOTAL.has(eventType);
    // Keep only events that establish the injury course (pivotal) OR concretely
    // bear on a diagnosis / anticipated future-care item (have a significance). A
    // note tied to neither is screened out — the chronology is not a document
    // index. (targetOverlap still feeds the relevance score.)
    if (!isPivotal && !sig) continue;

    const objectiveFindings = pickSection(text, SECTIONS.objectiveFindings);
    const diagnosis = pickSection(text, SECTIONS.diagnosis);
    const treatment = pickSection(text, SECTIONS.treatment);
    const imaging = eventType === "IMAGING" ? pickSection(text, SECTIONS.imaging) : null;
    const functionalStatus = pickSection(text, SECTIONS.functional);
    const workStatus = pickSection(text, SECTIONS.work);
    const restrictions = pickSection(text, SECTIONS.restrictions);
    const provider = pickSection(text, SECTIONS.provider, 80);
    const summary = composeSummary({ treatment, diagnosis, objectiveFindings, imaging }, finding);

    const dates = extractDates(text);
    const iso = dates[0];
    drafts.push({
      eventDate: iso ? new Date(`${iso}T00:00:00Z`) : (doc.serviceDate ?? anchor),
      eventType,
      specialty,
      provider,
      recordType: typeLabel(doc.type),
      summary,
      objectiveFindings,
      diagnosis,
      treatment,
      imagingFindings: imaging,
      functionalStatus,
      workStatus,
      restrictions,
      clinicalSignificance: sig,
      sourceQuote: finding !== summary ? finding : null,
      relevanceScore: Math.min(100, 40 + targetOverlap * 10 + (isPivotal ? 25 : 0) + (sig ? 10 : 0)),
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
        provider: d.provider,
        recordType: d.recordType,
        summary: d.summary,
        objectiveFindings: d.objectiveFindings,
        diagnosis: d.diagnosis,
        treatment: d.treatment,
        imagingFindings: d.imagingFindings,
        functionalStatus: d.functionalStatus,
        workStatus: d.workStatus,
        restrictions: d.restrictions,
        clinicalSignificance: d.clinicalSignificance,
        sourceQuote: d.sourceQuote,
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
