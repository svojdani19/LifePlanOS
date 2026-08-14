import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { admissibleToMedicalTimeline } from "@/lib/records/encounterSubstance";

const docFingerprint = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Credentials and honorifics that do not identify a person. */
const CREDENTIAL_TOKENS = new Set([
  "md", "do", "dpt", "pt", "ot", "pa", "pac", "np", "rn", "lvn", "dc", "dds", "phd", "psyd", "faaos", "facs",
  "msn", "crna", "aprn", "jr", "sr", "ii", "iii", "iv", "dr", "mr", "mrs", "ms", "the", "and", "llc", "pllc", "pa",
]);

/**
 * Order-independent identity key for a provider name, so the same clinician
 * written "Paul English, MD" in a chart and "ENGLISH, PAUL W" on a billing
 * record resolves to one person. Returns "" when no provider is named.
 */
/**
 * Append credentials only when the name does not already carry them — charts
 * routinely write "Mark Filley, MD" in the name field AND "MD" in the
 * credential field, which naively joined reads "Mark Filley, MD, MD".
 */
export function composeProviderName(name: string | null | undefined, credentials: string | null | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  const cred = credentials?.trim();
  if (!cred) return n;
  const have = new Set(n.toLowerCase().replace(/[^a-z\s]+/g, " ").split(/\s+/).filter(Boolean));
  const missing = cred
    .split(/[,;/]+/)
    .map((c) => c.trim())
    .filter((c) => c && !have.has(c.toLowerCase().replace(/[^a-z]+/g, "")));
  return missing.length ? `${n}, ${missing.join(", ")}` : n;
}

export function providerIdentityKey(provider: string | null | undefined): string {
  return providerNameTokens(provider).join(" ");
}

/** Sorted, credential-free name tokens for a provider string. */
export function providerNameTokens(provider: string | null | undefined): string[] {
  if (!provider) return [];
  const tokens = provider
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !CREDENTIAL_TOKENS.has(t));
  return [...new Set(tokens)].sort();
}

/**
 * Do two provider strings name the same clinician? Charts abbreviate: the
 * same PA is "BRITTANY R IRWIN, PA-C" on the chart note and "R Irwin, PA-C" on
 * the billing abstract. One name being a SUBSET of the other is the
 * abbreviation case; disjoint names are different people. An unnamed side is
 * missing information, not a different person.
 */
export function sameProvider(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = providerNameTokens(a);
  const tb = providerNameTokens(b);
  if (!ta.length || !tb.length) return true; // one side unnamed
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => large.includes(t));
}
import { typeLabel } from "@/lib/documents/taxonomy";
import { pageForOffset, pageMarks } from "@/lib/documents/meta";
import { stripChartFurniture } from "@/lib/documents/chartStructure";
import {
  expansionVerdict,
  compressedSummary,
  imagingImpression,
  responseMilestone,
  statusPostAnchor,
  careGapNote,
  diagnosisKey,
  POST_OP_MENTION_RE,
  isBoilerplate,
  looksLikeProcedureLabel,
} from "@/lib/engine/chronologyEmphasis";
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
// Single, deliberately-uploaded records that carry LCP data points even when
// not "pivotal" — current medications, impairment/MMI, cognitive testing, labs,
// or capacity — so their unique data points reach the timeline.
export const SUPPORTING_INCLUDE = new Set([
  "PHARMACY_RECORD",
  "LAB_REPORT",
  "IME_REPORT",
  "NEUROPSYCHOLOGICAL_EVALUATION",
  "FUNCTIONAL_CAPACITY_EVALUATION",
  "EMG_NCS_REPORT",
]);

export const EXCLUDED_TYPES = new Set([
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
export function hasTerm(lower: string, term: string): boolean {
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

// The sentence in a body that best speaks to the case's diagnoses — used as the
// encounter headline for messy OCR segments, so the knee-relevant line wins over
// incidental ICU/lab noise on the same page.
function caseRelevantSentence(body: string, condNames: string[]): string | null {
  const terms = [...new Set(condNames.flatMap((n) => sigTerms(n)).filter((t) => !DX_GENERIC.has(t)))];
  if (!terms.length) return null;
  const sents = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 15 && s.length < 220 && looksLikeProse(s));
  let best: { s: string; score: number } | null = null;
  for (const s of sents) {
    const lower = s.toLowerCase();
    const score = terms.filter((t) => hasTerm(lower, t)).length;
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best ? firstSentence(best.s) : null;
}

// A usable finding reads like prose — not an OCR fragment ("ning to airlift"),
// a bare label ("Problems: for Time: 07:43"), or a null value ("None recorded").
function looksLikeProse(s: string): boolean {
  const words = (s.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (words < 4) return false;
  if (!/^["'(]?[A-Z0-9]/.test(s.trim())) return false; // mid-word OCR fragment
  if (/^(none\b|n\/?a\b|problems?:|date[\s/]?time|time:|page \d)/i.test(s.trim())) return false;
  return true;
}

// A candidate sentence that leads with a metadata label or report boilerplate,
// not a clinical finding — never a valid summary.
const META_LEAD = /^(facility|location|date of|collected|fill date|\bndc\b|dispense|prepared by|reviewed by|dictated by|evaluated by|reported by|therapist|pharmacist|attending|surgeon|examiner|provider|page \d)\b|pharmacy record|record of fills|fills below|as written\b/i;

/** Pull a single-sentence relevant finding from a record, or null if none. */
export function extractFinding(text: string, complaint: Set<string>): string | null {
  if (!text || text.trim().length < 15) return null;

  for (const re of FINDING_LABELS) {
    const m = text.match(re);
    if (m && m[1]) {
      const s = firstSentence(m[1]);
      if (s.replace(/[^a-z]/gi, "").length > 4 && looksLikeProse(s)) return s;
    }
  }

  // Fallback: split on sentence boundaries AND line breaks (so header lines
  // like "PHYSICAL THERAPY PROGRESS NOTE" don't get merged into the finding),
  // then score each candidate by clinical + complaint keyword hits.
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 12 && !/^[A-Z0-9 :/,\-]+$/.test(s) && !META_LEAD.test(s) && looksLikeProse(s)); // prose only — no OCR fragments, labels, or boilerplate
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
function pickSection(text: string, labels: RegExp[], max = 500): string | null {
  for (const re of labels) {
    const m = text.match(re);
    if (m && m[1]) {
      const v = m[1].replace(/\s+/g, " ").trim().replace(/[;,]\s*$/, "").replace(/\s*\([^)]*p\.?\s*\d[^)]*\)\s*$/i, "").trim();
      if (v.replace(/[^a-z]/gi, "").length > 3 && !UNINFORMATIVE.test(v)) return v.length > max ? v.slice(0, max - 1).trim() + "…" : v;
    }
  }
  return null;
}

// LCP-style encounter sections. Line-scoped capture (records put each labeled
// field on its own line), stopping at the next labeled field on the same line
// so a value never bleeds into the following section or a signature.
const NEXT_LABEL = "(?=\\s+(?:subjective|objective|exam(?:ination)?|assessment|impression|pre-?operative diagnosis|post-?operative diagnosis|discharge diagnosis|diagnos[ie]s|plan(?:\\s+of\\s+care)?|procedure(?:\\s+performed)?|disposition|condition|diagnostic studies|technique|comparison|anesthesia|estimated blood loss|surgeon|dictated by|reviewed by|reported by|prepared by|electronically signed|attending|treating|examining|therapist|provider|history|past medical|social history|family history|allergies|medications?|triage|mode of arrival|time of arrival|date of|page\\s+\\d)\\b\\s*:|$)";
const L = (label: string) => new RegExp(label + "\\s*:\\s*(.+?)" + NEXT_LABEL, "i");
const SECTIONS = {
  subjective: [L("chief complaint"), L("history of present illness"), L("\\bhpi"), L("subjective"), /\b((?:the )?patient (?:presents?|presented)[^\n]{6,300})/i],
  objectiveFindings: [L("physical exam(?:ination)?"), L("\\bexam"), L("objective"), L("\\bfindings")],
  diagnosis: [L("post-?operative diagnosis"), L("discharge diagnosis"), L("assessment(?:\\s*&?\\s*(?:and\\s*)?plan)?"), L("\\bimpression"), L("pre-?operative diagnosis"), L("diagnos[ie]s")],
  treatment: [L("plan of care"), L("\\bplan"), L("\\btreatment"), L("recommendation")],
  procedure: [L("procedure performed"), L("\\bprocedure"), L("\\boperation")],
  disposition: [L("discharge disposition"), L("disposition"), L("\\bcondition")],
  imaging: [L("diagnostic studies"), L("\\bfindings"), L("\\bimpression"), L("\\bimaging")],
  functional: [/(?:functional status|ambulation|gait|range of motion|\badls?\b|transfers?)[^:\n]{0,26}:?\s*([^\n]+)/i, /(gait training[^\n]+)/i, /(range of motion[^\n]+)/i],
  work: [/(?:work status|return to work|disability status)[^:\n]{0,20}:?\s*([^\n]+)/i],
  restrictions: [/(?:restrictions?|limitations?|precautions?|weight[- ]bearing)[^:\n]{0,20}:?\s*([^\n]+)/i],
  pastMedicalHistory: [L("past medical history"), L("\\bpmh"), L("comorbidities"), L("past history")],
  medications: [L("prescription"), L("medications?"), L("\\bmeds"), L("current medications"), /\b((?:gabapentin|pregabalin|oxycodone|hydrocodone|acetaminophen|ibuprofen|naproxen|tramadol|morphine|lidocaine|duloxetine|cyclobenzaprine|baclofen|meloxicam|celecoxib)\b[^\n]{0,90})/i],
  impairment: [/((?:whole[- ]person )?impairment rating[^\n]{0,120})/i, /(reached\s+maximum medical improvement[^\n]{0,60})/i, /(maximum medical improvement[^\n]{0,60})/i, /(\bmmi\b[^\n]{0,60})/i],
  labs: [/\b([A-Z][A-Za-z ]{2,26}?\s+[\d.]+\s*\(?\s*(?:reference (?:range|interval)|ref\.?)[^)\n]{0,40}\)?[^\n]{0,40})/i, /(hemoglobin[^\n]{0,70})/i, /(white blood cell[^\n]{0,70})/i, /([A-Za-z][A-Za-z ]{2,24}\s+[\d.]+\b[^\n]{0,30}\bflag\s+(?:low|high|critical)[^\n]{0,20})/i],
  provider: [/(?:attending physician|treating physician|examining physician|dictated by|reported by|reviewed by|surgeon|therapist|examiner|provider|physician)\s*:\s*(?:dr\.?\s+)?([A-Z][a-z][A-Za-z.'-]*(?:\s+[A-Z][a-z][A-Za-z.'-]*){0,3}(?:,\s*[A-Za-z.]+)*(?:\s*[—–-]\s*[A-Z][a-z][^\n.]{0,40})?)/],
};

// ── Provider extraction ──────────────────────────────────────────────────────
// A person-name core: First [middle initial(s)] Last — first and last are full
// Title-case words so it won't truncate at "M" or absorb trailing "MD".
const NAME_CORE = "[A-Z][a-z]+(?:\\s+[A-Z](?![a-z])\\.?){0,2}\\s+[A-Z][a-z]+";
const CRED_RE = "M\\.?D\\.?|D\\.?O\\.?|APRN|PA-?C|N\\.?P\\.?|DPT|P\\.?T\\.?|R\\.?N\\.?|MSN|PharmD|CRNA|FNP|DNP|PhD|OTR";
// Ordered from most to least authoritative; each captures (name[, credentials]).
const PROVIDER_PATTERNS: { re: RegExp; lastFirst?: boolean }[] = [
  { re: new RegExp(`attending\\s+dr\\.?\\s*[:\\-]?\\s*(${NAME_CORE})(?:\\s*,?\\s*(${CRED_RE}))?`, "i") },
  { re: new RegExp(`electronically signed by\\s+(${NAME_CORE})(?:\\s*,?\\s*(${CRED_RE}))?`, "i") },
  { re: new RegExp(`attending\\s+physician\\s*[:\\-]\\s*(${NAME_CORE})(?:\\s*,?\\s*(${CRED_RE}))?`, "i") },
  { re: new RegExp(`(?:surgeon|treating physician|examining physician|provider|physician|examiner|therapist|dictated by|reported by|signed by)\\s*[:\\-]\\s*(?:dr\\.?\\s+)?(${NAME_CORE})(?:\\s*,?\\s*(${CRED_RE}))?`, "i") },
  { re: new RegExp(`\\bdr\\.?\\s+(${NAME_CORE})(?:\\s*,?\\s*(${CRED_RE}))?`, "i") },
];
const PROVIDER_REJECT = /\b(date|time|name|number|note|comment|complete|completes|site|order|record|id|patient|resident|nursing|home|facility|hospital|center|report|signed)\b/i;

// Normalize a name to Title Case (all-caps OCR → "Vincent S Culpepper"),
// preserving single-letter middle initials.
function titleCaseName(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length <= 1 || /^[A-Za-z]\.$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

/** The treating provider named in a record/segment, "Name, CRED" — or null. */
function extractProviderName(text: string, patientName?: string): string | null {
  const patientTokens = new Set((patientName ?? "").toLowerCase().match(/[a-z]+/g) ?? []);
  for (const { re } of PROVIDER_PATTERNS) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const name = m[1].replace(/\s+/g, " ").trim();
    if (PROVIDER_REJECT.test(name)) continue;
    // Never surface the patient's own name as the provider.
    const nameTokens = name.toLowerCase().match(/[a-z]+/g) ?? [];
    if (nameTokens.length && nameTokens.every((t) => patientTokens.has(t))) continue;
    const cred = m[2] ? `, ${m[2].replace(/\./g, "").toUpperCase()}` : "";
    return titleCaseName(name) + cred;
  }
  return null;
}

// A single token that looks like a real word (right length, sane vowel ratio,
// no run of 4+ consonants) — used to detect OCR garbage.
function plausibleWord(w: string): boolean {
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(w) || w.length < 2) return false;
  if (w.length <= 3) return true; // short tokens/abbreviations pass
  const vowels = (w.match(/[aeiou]/gi) ?? []).length;
  const vr = vowels / w.length;
  return vr >= 0.2 && vr <= 0.75 && !/[^aeiou]{4,}/i.test(w);
}

// A headline reads cleanly only if it looks like real prose, not a lab-value row
// ("Total Bili 0.8(b) 0.3-1.0 mg/dL"), an abbreviation string ("1 MO FU BIL
// KNEE"), or OCR consonant-soup ("RX: B67 37 RC RKTT Adon to ower…").
function isCleanClinical(s: string): boolean {
  if (/[\[\]{}|~^\\]/.test(s)) return false; // stray OCR bracket/symbol noise
  const words = s.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (words.length < 4) return false;
  const implausible = words.filter((w) => !plausibleWord(w)).length;
  if (implausible >= 3 || implausible / words.length > 0.28) return false;
  const realWords = words.filter((w) => /[a-z]{3,}/.test(w) && /[aeiou]/i.test(w));
  if (realWords.length < 3) return false; // mostly all-caps / abbreviations
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits / s.length > 0.18) return false; // value-laden lab line
  return true;
}

// Significant, non-generic terms — for matching an event to a diagnosis or a
// future-care service. Anatomy/procedure words are kept; filler is dropped.
const SIG_STOP = new Set([...STOP, "patient", "status", "note", "record", "records", "visit", "visits", "history", "clinical", "management", "care", "chronic", "severe", "acute", "initial", "residual", "incomplete", "follow", "followup", "ongoing", "maintenance", "general", "exam", "examination", "reached", "provided", "report", "review", "medical", "additional", "level", "unspecified", "encounter", "affected", "anticipated", "internal", "reaction"]);
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
export const DX_GENERIC = new Set(["fracture", "fractures", "injury", "injuries", "pain", "disorder", "syndrome", "disease", "deficit", "dysfunction", "residual"]);

export function sigTerms(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !SIG_STOP.has(w)))];
}

// Does the event text speak to this diagnosis? Requires a DISTINCTIVE shared term
// (anatomy/pathology beyond the generic ones) so "fracture" alone can't make a
// lumbar MRI "document" a tibial-plateau fracture.
export function documentsDiagnosis(hay: string, name: string): boolean {
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
export function significance(hay: string, condNames: string[], careServices: string[]): string | null {
  const dx = condNames.filter((n) => documentsDiagnosis(hay, n));
  const care = careServices.filter((s) => groundsCare(hay, s)).slice(0, 3);
  const parts: string[] = [];
  if (dx.length) parts.push(`Documents ${humanList(dx.slice(0, 2))}`);
  if (care.length) parts.push(`${dx.length ? "supports the anticipated" : "Supports the anticipated"} ${humanList(care)}`);
  if (!parts.length) return null;
  return parts.join("; ") + ".";
}

// Compose a specific event summary from the extracted detail.
function composeSummary(fields: { treatment?: string | null; diagnosis?: string | null; objectiveFindings?: string | null; imaging?: string | null; medications?: string | null }, fallback: string): string {
  const { treatment, diagnosis, objectiveFindings, imaging, medications } = fields;
  if (treatment && diagnosis) return firstSentence(`${treatment} for ${diagnosis.replace(/\.$/, "")}`.replace(/\s+/g, " "));
  if (treatment) return firstSentence(treatment);
  if (imaging) return firstSentence(imaging);
  if (objectiveFindings) return firstSentence(objectiveFindings);
  if (diagnosis) return firstSentence(diagnosis);
  // A pharmacy dispensing line reads as "Drug dose. SIG: …" — keep the fuller
  // line (not just the first micro-sentence "Gabapentin 300 mg").
  if (medications) return medications.length > 100 ? medications.slice(0, 99).trim() + "…" : medications;
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

// ── Encounter segmentation ────────────────────────────────────────────────────
// A consolidated chart (hospital stay, multi-visit clinic printout, a
// 1,000-page records production) is not ONE event. Clinical date labels anchor
// ENCOUNTERS: each label starts a segment that runs to the next anchor, and
// segments sharing a calendar date merge into one encounter, so the chronology
// can yield as many events as the record actually documents.

const ANCHOR_LABEL = /\b(?:date of (?:service|procedure|operation|exam(?:ination)?|evaluation|visit|admission|discharge|consult(?:ation)?)|(?:service|admission|admit|discharge|exam|visit|encounter|procedure|operation|consult(?:ation)?)\s+date|date)\s*(?:\/\s*time)?\s*[:\-]\s*/gi;
const ANCHOR_VALUE = /^\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|20\d{2}-\d{1,2}-\d{1,2}|[A-Z][a-z]+\.?\s+\d{1,2},?\s+20\d{2})/;
// Labels that are ABOUT a date but not a clinical encounter (DOB, print/report
// stamps, policy periods) — looked for just before the matched label.
const NON_CLINICAL_DATE = /(birth|dob|print(?:ed)?|report(?:ed)?|signed|expir|effective|policy|paid|statement|due)\s*$/i;

function anchorToIso(raw: string): string | null {
  let y = 0, mo = 0, da = 0;
  let m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    mo = +m[1]; da = +m[2]; y = +m[3];
    if (y < 100) y += y > 50 ? 1900 : 2000;
  } else if ((m = raw.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/))) {
    y = +m[1]; mo = +m[2]; da = +m[3];
  } else if ((m = raw.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(20\d{2})$/))) {
    mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; da = +m[2]; y = +m[3];
  }
  if (!y || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const iso = `${y}-${pad(mo)}-${pad(da)}`;
  const t = new Date(`${iso}T00:00:00Z`).getTime();
  // Plausibility: a clinical encounter, not a DOB or a future policy date.
  if (t < new Date("1990-01-01").getTime() || t > Date.now() + 60 * 24 * 3600 * 1000) return null;
  return iso;
}

export interface Encounter {
  dateIso: string;
  date: Date;
  /** page the encounter's first anchor appears on (from "Page N of M" marks) */
  page: number | null;
  /** the encounter's text (all same-date segments concatenated, capped) */
  text: string;
}

const ENCOUNTER_TEXT_CAP = 8000; // enough for detail extraction, bounded for safety

// Narrative/report-style encounter header: a date at the START of a line,
// followed by a dash (or a dated range, "07/13/2023 - 02/26/2024 -") and a
// capitalized provider/heading — the format of records-review documents and
// compiled chronology reports, where dates are never labeled "Date of Service".
const NARRATIVE_HEADER = /^[ \t]*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*[-–—]\s*\d{1,2}\/\d{1,2}\/\d{4})?\s*[-–—,]\s*(?=[A-Z])/gm;

/**
 * Is this segment a repeated date header rather than a new note?
 *
 * Charts restate "Date of Service: 03/15/2024" in table rows, page headers and
 * continuation banners. Those repeats used to be harmless because every
 * same-date segment merged anyway; now that each anchor starts an encounter,
 * a repeat would become a duplicate event.
 *
 * The test is deliberately narrow — a repeat carries almost no text of its own,
 * and anything with a note's worth of content is treated as a new note even
 * when it shares a date with the one before it. Splitting one note in two is a
 * visible, correctable error; silently merging two encounters is a deletion.
 */
export function isHeaderRepeat(segment: string, openText: string): boolean {
  const body = segment.replace(ANCHOR_LABEL, " ").replace(/\s+/g, " ").trim();
  if (body.length > 200) return false;
  // A short segment that introduces a different clinician or a different kind
  // of record is a new note however brief it is.
  const seen = extractProviderName(openText);
  const here = extractProviderName(segment);
  if (seen && here && !sameProvider(seen, here)) return false;
  return true;
}

export function segmentEncounters(text: string, marks: { offset: number; page: number }[]): Encounter[] {
  const anchors: { offset: number; iso: string }[] = [];
  const re = new RegExp(ANCHOR_LABEL.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (NON_CLINICAL_DATE.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
    const v = text.slice(m.index + m[0].length, m.index + m[0].length + 40).match(ANCHOR_VALUE);
    if (!v) continue;
    const iso = anchorToIso(v[1].trim());
    if (iso) anchors.push({ offset: m.index, iso });
  }
  // Narrative fallback: when labeled anchors can't segment the document, look
  // for line-leading "MM/DD/YYYY - Provider…" headers (report-style sources).
  if (new Set(anchors.map((a) => a.iso)).size < 2) {
    const nre = new RegExp(NARRATIVE_HEADER.source, "gm");
    while ((m = nre.exec(text))) {
      if (NON_CLINICAL_DATE.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
      const iso = anchorToIso(m[1].trim());
      if (iso) anchors.push({ offset: m.index, iso });
    }
    anchors.sort((a, b) => a.offset - b.offset);
  }
  // Segmentation needs more than one anchor, not more than one DATE. Requiring
  // two distinct dates meant a document whose encounters all fall on one day —
  // a hospital admission, a surgical day, a combined same-day production — was
  // declared a single encounter and never segmented at all, which is the same
  // date-is-identity assumption from the other direction.
  if (anchors.length < 2) return []; // single-encounter document — no segmentation

  // Each anchor starts an encounter. Anchors are NOT collapsed by date: a
  // combined production carries a therapy session, an imaging study, an
  // emergency visit and a follow-up on one day, and keying encounters by date
  // reported all four as a single event. Two anchors join only when the second
  // is a repeated header rather than a new note — see `isHeaderRepeat`.
  const out: Encounter[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1].offset : text.length;
    const seg = text.slice(a.offset, end);
    const open = out.at(-1);
    if (open && open.dateIso === a.iso && isHeaderRepeat(seg, open.text)) {
      if (open.text.length < ENCOUNTER_TEXT_CAP) open.text += "\n" + seg.slice(0, ENCOUNTER_TEXT_CAP - open.text.length);
      continue;
    }
    out.push({
      dateIso: a.iso,
      date: new Date(`${a.iso}T00:00:00Z`),
      page: pageForOffset(a.offset, marks),
      text: seg.slice(0, ENCOUNTER_TEXT_CAP),
    });
  }
  return out.sort((x, y) => x.date.getTime() - y.date.getTime());
}

// Event type + a readable record type from the ENCOUNTER'S OWN content (a
// consolidated chart's document type says nothing about what happened on a given
// day). Order matters: the most specific/reliable signatures come first.
type SegClass = { eventType: EventType; specialty: string; recordType: string };
const SEG_TYPES: { re: RegExp; eventType: EventType; specialty: string; recordType: string }[] = [
  { re: /surgical pathology|gross description|microscopic|specimen(?:s)?\s*(?:submitted|received)|final (?:pathologic )?diagnosis:|reference (?:range|interval)|\blab(?:oratory)? (?:report|results)\b|troponin|\bcbc\b|metabolic panel/i, eventType: "LAB", specialty: "Laboratory / Pathology", recordType: "Laboratory / Pathology Report" },
  { re: /transforaminal|epidural steroid|injection performed|radiofrequency ablation|nerve block|arthrocentesis/i, eventType: "CLINIC_VISIT", specialty: "Pain Management", recordType: "Injection / Procedure Note" },
  { re: /operative (?:report|note)|procedure performed|operation performed|surgeon\s*:|anesthesia\s*:|\borif\b|arthroplasty performed|manipulation under anesthesia|revision (?:total )?knee|\bincision\b/i, eventType: "SURGERY", specialty: "Surgery", recordType: "Operative / Procedure Note" },
  { re: /emergency (?:department|room)|\bed\b triage|\btriage\b|chief complaint[\s\S]{0,120}(ambulance|ems\b)|patient care report/i, eventType: "ER_VISIT", specialty: "Emergency", recordType: "Emergency Department Report" },
  { re: /discharge summary|hospital course|history and physical|\bh&p\b|admitted to|admission diagnosis|discharged to|inpatient/i, eventType: "HOSPITALIZATION", specialty: "Inpatient", recordType: "Hospital / Inpatient Record" },
  { re: /\b(mri|ct|x-?ray|radiograph|ultrasound|fluoroscop)\b[\s\S]{0,80}(impression|findings)|technique:[\s\S]{0,40}(imaging|sequences)/i, eventType: "IMAGING", specialty: "Radiology", recordType: "Imaging Report" },

  { re: /physical therapy|occupational therapy|therapeutic exercise|gait training|home exercise program|therapy progress|plan of care/i, eventType: "THERAPY", specialty: "Rehabilitation", recordType: "Therapy Note" },
];
export function classifySegment(text: string): SegClass {
  let base: SegClass = { eventType: "CLINIC_VISIT", specialty: "Provider", recordType: "Clinical Encounter" };
  for (const s of SEG_TYPES) if (s.re.test(text)) { base = { eventType: s.eventType, specialty: s.specialty, recordType: s.recordType }; break; }
  // Complication is a modifier on the base encounter, not its own record type.
  const lower = text.toLowerCase();
  // Negated mentions ("no complications", "without complication", "denies
  // infection") never classify the encounter as a complication.
  const complicationHit = CONTENT_COMPLICATION.some((k) => {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(k, from);
      if (i === -1) return false;
      const before = lower.slice(Math.max(0, i - 30), i);
      if (!/\b(?:no|without|denies|denied|negative for|free of|not?)\s+(?:\w+\s+){0,2}$/.test(before)) return true;
      from = i + k.length;
    }
  });
  if (complicationHit) return { ...base, eventType: "COMPLICATION" };
  return base;
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

// The full set of LCP data points captured for one medical-record event
// (a single-encounter record, or one encounter of a consolidated chart).
export interface EncounterData {
  subjective: string | null; // chief complaint / HPI / mechanism
  pastMedicalHistory: string | null; // comorbidities documented at the encounter
  objectiveFindings: string | null; // exam
  diagnosis: string | null; // assessment (post-op "Same." resolves to the pre-op dx)
  treatment: string | null; // plan / goals
  procedure: string | null; // procedure performed (+ anesthesia, EBL)
  disposition: string | null; // admitted / discharged / condition
  imagingFindings: string | null; // diagnostic studies — imaging findings or a lab result
  medications: string | null; // drug, dose, SIG, days supply, refills
  functionalStatus: string | null; // gait / ROM / ADLs / assistive device
  workStatus: string | null; // work / disability status
  restrictions: string | null; // restrictions / precautions / weight-bearing
  impairmentRating: string | null; // MMI status / impairment rating (medicolegal)
}

/**
 * Extract every LCP data point from one encounter's text. Pure and deterministic
 * (label-scoped section capture) — the single source of truth for what a
 * medical-record event carries, used by the chronology builder and unit-tested
 * directly.
 */
export function extractEncounterData(body: string, opts: { isImaging?: boolean } = {}): EncounterData {
  const isImaging = !!opts.isImaging;
  const objectiveFindings = isImaging ? null : pickSection(body, SECTIONS.objectiveFindings);
  // Assessment: a post-op "Same." (or a blank value) resolves to the pre-op dx.
  const diagnosisRaw = pickSection(body, SECTIONS.diagnosis);
  const preopDx = pickSection(body, [L("pre-?operative diagnosis")]);
  const diagnosis = diagnosisRaw && !/^same\b/i.test(diagnosisRaw) ? diagnosisRaw : preopDx ?? diagnosisRaw;
  // Procedure, with anesthesia and estimated blood loss appended when present.
  const procedureRaw = pickSection(body, SECTIONS.procedure);
  const anesthesia = pickSection(body, [/\banesthesia\s*:?\s*([A-Za-z][^\n.]{1,34})/i], 40);
  const ebl = body.match(/estimated blood loss\s*:?\s*([\d.,]+\s*(?:m?l|cc))/i)?.[1] ?? null;
  const procedure = procedureRaw
    ? `${procedureRaw}${anesthesia || ebl ? ` (${[anesthesia ? `${anesthesia.replace(/\.$/, "")} anesthesia` : null, ebl ? `EBL ${ebl}` : null].filter(Boolean).join("; ")})` : ""}`
    : procedureRaw;
  // Diagnostic Studies covers imaging AND labs; a non-imaging record falls back
  // to a lab result line (value + reference range + flag).
  const imagingRaw = isImaging ? pickSection(body, SECTIONS.imaging) : pickSection(body, [SECTIONS.imaging[0]]);
  const imagingSection = imagingRaw && imagingRaw !== diagnosis ? imagingRaw : null; // avoid Assessment == Diagnostic Studies
  const labResult = isImaging ? null : pickSection(body, SECTIONS.labs, 140);
  const imagingFindings = imagingSection ?? (labResult && labResult !== diagnosis ? labResult : null);
  return {
    subjective: pickSection(body, SECTIONS.subjective),
    pastMedicalHistory: pickSection(body, SECTIONS.pastMedicalHistory, 220),
    objectiveFindings,
    diagnosis,
    treatment: pickSection(body, SECTIONS.treatment),
    procedure,
    disposition: pickSection(body, SECTIONS.disposition),
    imagingFindings,
    medications: pickSection(body, SECTIONS.medications, 160),
    functionalStatus: pickSection(body, SECTIONS.functional),
    workStatus: pickSection(body, SECTIONS.work),
    restrictions: pickSection(body, SECTIONS.restrictions),
    impairmentRating: pickSection(body, SECTIONS.impairment, 160),
  };
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

  // No records → clear and return. (When records exist, the clear happens
  // atomically with the insert at the end, so an interrupted build can never
  // leave the case with an empty timeline.)
  if (docs.length === 0) {
    await prisma.chronologyEvent.deleteMany({ where: { caseId } });
    return { kept: 0, screened: 0, excluded: 0 };
  }

  type Draft = {
    eventDate: Date;
    eventDateEnd: Date | null;
    eventType: EventType;
    specialty: string;
    provider: string | null;
    facility: string | null;
    recordType: string;
    summary: string;
    subjective: string | null;
    pastMedicalHistory: string | null;
    objectiveFindings: string | null;
    diagnosis: string | null;
    treatment: string | null;
    procedure: string | null;
    disposition: string | null;
    imagingFindings: string | null;
    medications: string | null;
    functionalStatus: string | null;
    workStatus: string | null;
    restrictions: string | null;
    impairmentRating: string | null;
    clinicalSignificance: string | null;
    sourceQuote: string | null;
    relevanceScore: number;
    sourceDocumentId: string;
    sourcePage: number | null;
    dateInferred: boolean;
    mentionsPostOp?: boolean;
  };
  const drafts: Draft[] = [];
  const fingerprintByDoc = new Map<string, string>();

  // Source-grounded extraction results take precedence: when a document has a
  // COMPLETE extraction run, its VALIDATED, claim-cited encounters supply the
  // timeline for that document and the regex path is skipped. Documents
  // without completed extractions still flow through the deterministic
  // extractor, so the program keeps producing initial work either way.
  const extractionRuns = await prisma.recordExtraction.findMany({
    where: { caseId, status: "COMPLETE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, sourceDocumentId: true },
  });
  const latestRunByDoc = new Map<string, string>();
  for (const r of extractionRuns) if (!latestRunByDoc.has(r.sourceDocumentId)) latestRunByDoc.set(r.sourceDocumentId, r.id);
  const extractedByDoc = new Map<string, Awaited<ReturnType<typeof prisma.extractedEncounter.findMany>>>();
  if (latestRunByDoc.size) {
    const encRows = await prisma.extractedEncounter.findMany({
      where: {
        caseId,
        status: { in: ["AI_DRAFT", "AI_AUDIT_PASSED", "HUMAN_EDITED", "REVIEWED", "VERIFIED"] },
        dateStatus: { in: ["DOCUMENTED", "INFERRED"] },
      },
    });
    for (const e of encRows) {
      // The chronology is the story of the patient's CARE. Administrative
      // paperwork and ancillary logs stay on the Records page (each with its
      // reviewable exclusion reason) — they never become timeline events. A
      // NULL class means "not yet classified" and stays visible; a reviewer's
      // reclassification is simply the stored value, so promoting an excluded
      // encounter is one PATCH away.
      // Admission is decided by the KIND of document the row came from —
      // testimony, billing, legal filings, employment records and
      // unclassified material never become treating timeline events, whatever
      // their field names look like. A legacy row with no recorded kind keeps
      // the prior substance-class behaviour so nothing already reviewed
      // vanishes, and a reviewer's reclassification is still one PATCH away.
      if (!admissibleToMedicalTimeline(e)) continue;
      const arr = extractedByDoc.get(e.sourceDocumentId) ?? [];
      arr.push(e);
      extractedByDoc.set(e.sourceDocumentId, arr);
    }
  }

  const claimValue = (claims: unknown, field: string): string | null => {
    const arr = Array.isArray(claims) ? (claims as { field?: string; value?: string }[]) : [];
    const vals = arr.filter((c) => c.field === field && typeof c.value === "string").map((c) => c.value as string);
    return vals.length ? [...new Set(vals)].join("; ").slice(0, 600) : null;
  };
  const firstExcerpt = (claims: unknown): string | null => {
    const arr = Array.isArray(claims) ? (claims as { excerpt?: string }[]) : [];
    return arr.find((c) => typeof c.excerpt === "string")?.excerpt?.slice(0, 400) ?? null;
  };
  // Whole-word patterns, most specific first. Substring matching is unsafe
  // here: a bare "er" makes "Interventional" and "Other" read as ER visits,
  // and "ct" matches half the words in English.
  const EXTRACTION_TYPE_RULES: [RegExp, EventType][] = [
    [/\b(?:operative|operation|surgery|surgical|arthroscop\w*|arthroplast\w*|fusion|discectomy|laminectomy|meniscectomy|orif)\b/, "SURGERY"],
    [/\b(?:injection|epidural|nerve block|somatic blockade|ablation|rhizotomy|discogram|arthrocentesis|infusion)\b/, "CLINIC_VISIT"],
    [/\b(?:mri|ct scan|cat scan|x-?ray|radiograph\w*|radiology|ultrasound|imaging|myelogram|emg|ncs|dexa)\b/, "IMAGING"],
    [/\b(?:lab|labs|laboratory|pathology|urinalysis|blood work|serology)\b/, "LAB"],
    [/\b(?:emergency|\ber\b|trauma bay|urgent care)\b/, "ER_VISIT"],
    [/\b(?:hospitalization|hospital|inpatient|admission|discharge)\b/, "HOSPITALIZATION"],
    [/\b(?:physical therapy|occupational therapy|therapy|rehabilitation|rehab|chiropractic)\b/, "THERAPY"],
  ];

  for (const doc of docs) {
    if (EXCLUDED_TYPES.has(doc.type)) continue; // administrative / legal — not a clinical finding

    // Strip learned page furniture (banners/footers/audit/flowsheet) before
    // building events; a no-op on small single-encounter records.
    const text = stripChartFurniture(doc.extractedText ?? "");
    fingerprintByDoc.set(doc.id, docFingerprint(doc.extractedText ?? ""));
    const marks = pageMarks(text);

    const extractedEncs = extractedByDoc.get(doc.id);
    if (extractedEncs?.length) {
      for (const enc of extractedEncs) {
        if (!enc.encounterDate) continue; // undated stays out of the dated timeline
        const typeKey = (enc.encounterType ?? "").toLowerCase();
        const eventType = EXTRACTION_TYPE_RULES.find(([re]) => re.test(typeKey))?.[1] ?? "CLINIC_VISIT";
        const hay = `${enc.factualSummary}\n${claimValue(enc.claims, "assessment") ?? ""}`.toLowerCase();
        drafts.push({
          eventDate: enc.encounterDate,
          eventDateEnd: enc.encounterDateEnd,
          eventType,
          specialty: enc.encounterType ?? "Provider",
          provider: composeProviderName(enc.provider, enc.providerCredentials),
          facility: enc.facility,
          recordType: enc.encounterType ?? typeLabel(doc.type),
          // The FACTUAL encounter summary leads; relevance is computed
          // separately below and stays a labeled system suggestion.
          summary: enc.factualSummary,
          subjective: claimValue(enc.claims, "subjective"),
          pastMedicalHistory: claimValue(enc.claims, "pastMedicalHistory"),
          objectiveFindings: claimValue(enc.claims, "objectiveFindings"),
          diagnosis: claimValue(enc.claims, "assessment"),
          treatment: claimValue(enc.claims, "treatment"),
          procedure: claimValue(enc.claims, "procedure"),
          disposition: claimValue(enc.claims, "disposition"),
          imagingFindings: claimValue(enc.claims, "diagnosticStudies"),
          medications: claimValue(enc.claims, "medications"),
          functionalStatus: claimValue(enc.claims, "functionalStatus"),
          workStatus: claimValue(enc.claims, "workStatus"),
          restrictions: claimValue(enc.claims, "restrictions"),
          impairmentRating: null,
          clinicalSignificance: significance(hay, condNames, careServices),
          sourceQuote: firstExcerpt(enc.claims),
          relevanceScore: 60,
          sourceDocumentId: doc.id,
          sourcePage: enc.page, // unknown page STAYS null — never coerced to 1
          dateInferred: enc.dateStatus === "INFERRED",
          mentionsPostOp: POST_OP_MENTION_RE.test(enc.factualSummary),
        });
      }
      continue; // extraction supplies this document's events
    }

    // Draft one candidate event from a body of text (a whole single-encounter
    // record, or ONE encounter of a consolidated chart). Applies the relevance
    // policy: keep only pivotal events or those bearing on a diagnosis /
    // anticipated future-care item.
    // Provider header for the LCP line: "Name, Credentials — Role" from the
    // record metadata, with a per-encounter fallback extracted from the segment.
    const docProvider = [doc.authorName, doc.authorCredentials].filter(Boolean).join(", ") + (doc.authorRole ? ` — ${doc.authorRole}` : "") || null;

    const draftFrom = (body: string, ev: { eventType: EventType; specialty: string; recordType?: string }, eventDate: Date, eventDateEnd: Date | null, dateInferred: boolean, page: number | null, encounter: boolean, keepAnyway = false): Draft | null => {
      // Every LCP data point for this encounter, from the single extractor.
      const enc = extractEncounterData(body, { isImaging: ev.eventType === "IMAGING" });
      // The finding headlines the event; for records whose value is a structured
      // data point (a pharmacy dispensing line, an IME impairment), fall back to
      // that when no clinical sentence extracts — otherwise the event would drop.
      // Exemplar coverage rule: a dated clinical visit with a clean assessment
      // or treatment line is never dropped merely because no complaint-matching
      // sentence extracts — the fragment itself anchors a compressed entry.
      const notBoiler = (v: string | null) => (v && !isBoilerplate(v) ? v : null);
      const finding =
        notBoiler(extractFinding(body, complaint)) ?? notBoiler(enc.medications) ?? notBoiler(enc.impairmentRating) ?? notBoiler(enc.diagnosis) ??
        (!dateInferred && enc.treatment && looksLikeProse(enc.treatment) ? notBoiler(enc.treatment) : null) ??
        (!dateInferred && enc.subjective && looksLikeProse(enc.subjective) ? notBoiler(enc.subjective) : null);
      // Exemplar low-content ledger rule: a dated pivotal or core-clinical
      // record whose text yields no extractable finding (thin scan of an
      // injection report, a one-page imaging cover) still earns a one-line
      // ledger entry — "X was performed" — rather than vanishing. Files whose
      // NAME identifies them as billing artifacts never qualify.
      if (!finding) {
        const ledgerEligible =
          !encounter &&
          !dateInferred &&
          (PIVOTAL.has(ev.eventType) || CORE_CLINICAL.has(doc.type)) &&
          !/\b(bill|invoice|statement|balance|ledger)\b/i.test(doc.filename);
        if (!ledgerEligible) {
          if (process.env.CHRONO_DEBUG) console.log(`[chrono-drop] no-finding ${doc.filename.slice(0, 50)}`);
          return null;
        }
        return {
          eventDate, eventDateEnd, eventType: ev.eventType, specialty: ev.specialty,
          provider: docProvider ?? null, facility: doc.facility ?? null,
          recordType: typeLabel(doc.type),
          summary: `${typeLabel(doc.type)} was performed and is on file; see the cited source record for its contents.`,
          subjective: null, pastMedicalHistory: null, objectiveFindings: null, diagnosis: null,
          treatment: null, procedure: null, disposition: null, imagingFindings: null,
          medications: null, functionalStatus: null, workStatus: null, restrictions: null,
          impairmentRating: null, clinicalSignificance: null, sourceQuote: null,
          relevanceScore: 25, sourceDocumentId: doc.id, sourcePage: page, dateInferred,
        };
      }
      const hay = `${finding}\n${body}`.toLowerCase();
      const targetOverlap = overlapCount(body, targets);
      const sig = significance(hay, condNames, careServices);
      const isPivotal = PIVOTAL.has(ev.eventType);
      // Exemplar emphasis profile (chronologyEmphasis.ts): does this encounter
      // carry an expansion signal (imaging, procedure, escalation, response
      // milestone, medico-legal content, disposition)?
      const verdict = expansionVerdict(enc, body, { eventType: ev.eventType });
      // Selection follows the exemplar's COVERAGE-OVER-OMISSION rule: an
      // encounter that would previously have been dropped as non-significant
      // is kept as a COMPRESSED interval entry when it is a real, dated
      // clinical encounter with clean extractable content — the run of routine
      // visits itself documents the treatment course. Pure noise (no date, no
      // clean clinical content) still drops.
      const previousPolicyKeeps = encounter ? !(!sig && targetOverlap < 2) : !(!isPivotal && !sig && !keepAnyway);
      let compressed = false;
      if (!previousPolicyKeeps) {
        const hasCleanContent = [enc.diagnosis, enc.treatment, enc.subjective, enc.medications].some(
          (v) => v && looksLikeProse(v),
        );
        if (dateInferred || !hasCleanContent) { if (process.env.CHRONO_DEBUG) console.log(`[chrono-drop] ${dateInferred ? "date-inferred" : "no-clean-content"} ${doc.filename.slice(0,50)}`); return null; }
        compressed = !verdict.expanded;
        // An undated-signal-free fragment of an unrelated chart: keep only when
        // it reads as a genuine visit (assessment or treatment present).
        if (compressed && !enc.diagnosis && !enc.treatment) { if (process.env.CHRONO_DEBUG) console.log(`[chrono-drop] compressed-no-dx-tx ${doc.filename.slice(0,50)}`); return null; }
      }
      const {
        subjective, pastMedicalHistory, objectiveFindings, diagnosis, treatment, procedure,
        disposition, imagingFindings: imaging, medications, functionalStatus, workStatus, restrictions, impairmentRating,
      } = enc;
      const segFacilityRaw = pickSection(body, [/\bfacility\s*:?\s*([^\n]{3,90})/i, /\blocation\s*:?\s*([^\n]{3,90})/i], 90);
      // Trim trailing OCR labels that ran into the facility ("… Date Taken: …").
      const segFacility = segFacilityRaw?.replace(/\s+(?:date|time|dob|mrn|account|device|room|bed|unit|provider|taken)\b.*$/i, "").replace(/\s+[A-Z][a-z]+\s*:.*$/, "").trim() || null;
      const segProvider = extractProviderName(body, c.clientName) ?? pickSection(body, SECTIONS.provider, 90);
      // For a consolidated chart, each encounter must use ITS OWN provider — the
      // document-level author would wrongly stamp every line. Single-encounter
      // records prefer the parsed record author, then a name found in the body.
      const provider = encounter ? segProvider : (docProvider ?? segProvider);
      // Per-encounter record type from the segment's content; single-encounter
      // records keep the document's classified type.
      const recordType = encounter ? (ev.recordType ?? "Clinical Encounter") : typeLabel(doc.type);
      // The SUMMARY (list headline) is composed only from values that read as
      // prose — noisy OCR fragments stay out; raw sections remain in the fields.
      const prose = (v: string | null) => (v && looksLikeProse(v) ? v : null);
      // For messy segments with no clean labeled sections, headline the sentence
      // that actually speaks to the case rather than an incidental OCR line.
      const caseSentence = !subjective && !objectiveFindings && !diagnosis && !treatment && !procedure ? caseRelevantSentence(body, condNames) : null;
      let summary: string;
      if (compressed) {
        // Exemplar §5: the stereotyped interval-visit line — date, response,
        // unchanged assessment, treatment continued.
        summary = compressedSummary(enc, ev.recordType ?? typeLabel(doc.type));
      } else if (ev.eventType === "IMAGING" && prose(imaging)) {
        // Exemplar §3: imaging survives near-verbatim — levels, laterality,
        // measurements, root/cord involvement are never paraphrased away.
        summary = imagingImpression(imaging!);
      } else {
        summary = composeSummary(
          { treatment: prose(procedure ?? treatment), diagnosis: prose(diagnosis), objectiveFindings: prose(subjective ?? objectiveFindings), imaging: prose(imaging), medications },
          prose(caseSentence) ?? (looksLikeProse(finding) ? finding : "Documented clinical encounter — see the cited page of the source record."),
        );
        // Exemplar §10: a quantified treatment response is the follow-up's
        // load-bearing fact — surface it on the headline when present.
        const milestone = responseMilestone(subjective);
        if (milestone && !summary.toLowerCase().includes(milestone.toLowerCase().slice(0, 30))) {
          summary = `${summary.replace(/\.$/, "")}. Response: ${milestone}.`;
        }
      }
      // Final guard: if the OCR headline is still garbled, derive a clean one
      // naming the diagnosis this encounter documents (the significance already
      // establishes the link) so no OCR soup ever surfaces as the summary.
      if (!isCleanClinical(summary) || isBoilerplate(summary)) {
        const topCond = condNames.find((n) => documentsDiagnosis(hay, n));
        // A placeholder headline adds nothing — drop the event rather than surface
        // "Documented clinical encounter — see the cited page." When the encounter
        // clearly documents a diagnosis, headline that instead.
        if (!topCond) { if (process.env.CHRONO_DEBUG) console.log(`[chrono-drop] garbled-no-cond ${doc.filename.slice(0,50)}`); return null; }
        summary = `${ev.recordType ?? typeLabel(doc.type)} addressing ${topCond.replace(/,\s*initial encounter$/i, "").toLowerCase()}`;
      }
      return {
        eventDate,
        eventDateEnd,
        eventType: ev.eventType,
        specialty: ev.specialty,
        provider,
        facility: segFacility ?? doc.facility ?? null,
        recordType,
        summary,
        subjective,
        pastMedicalHistory,
        objectiveFindings,
        diagnosis,
        treatment,
        procedure,
        disposition,
        imagingFindings: imaging,
        medications,
        functionalStatus,
        workStatus,
        restrictions,
        impairmentRating,
        clinicalSignificance: sig,
        sourceQuote: finding !== summary ? finding : null,
        mentionsPostOp: POST_OP_MENTION_RE.test(body),
        relevanceScore: compressed
          ? 25
          : Math.min(100, 40 + targetOverlap * 10 + (isPivotal ? 25 : 0) + (sig ? 10 : 0) + verdict.signals.length * 4),
        sourceDocumentId: doc.id,
        sourcePage: page,
        dateInferred,
      };
    };

    // A consolidated chart with multiple dated encounters yields ONE EVENT PER
    // RELEVANT ENCOUNTER — however many the record documents; a single-encounter
    // record yields at most one, as before.
    const encounters = segmentEncounters(text, marks);
    if (encounters.length >= 2) {
      for (const enc of encounters) {
        const d = draftFrom(enc.text, classifySegment(enc.text), enc.date, null, false, enc.page, true);
        if (d) drafts.push(d);
      }
    } else {
      const iso = extractDates(text)[0];
      // A record with NO documented date and NO parsed service date carries no
      // encounter date. It stays visible on the Records page in the
      // "Undated / date requires review" group — it never silently enters the
      // dated chronology, and the case-creation date / date of injury /
      // upload date are NEVER substituted as an encounter date.
      const eventDate = iso ? new Date(`${iso}T00:00:00Z`) : doc.serviceDate ?? null;
      if (!eventDate) continue;
      const d = draftFrom(
        text,
        classifyEvent(doc.type, text),
        eventDate,
        doc.serviceDateEnd ?? null,
        !iso,
        marks.length ? pageForOffset(0, marks) : null,
        false,
        SUPPORTING_INCLUDE.has(doc.type),
      );
      if (d) drafts.push(d);
    }
  }

  // De-duplicate: the same day's care is often documented in several overlapping
  // records (an ER note ALSO classified as a hospitalization, a therapy note
  // reprinted). Keep the strongest event per (date, summary-prefix) REGARDLESS of
  // event type, so an identical-summary duplicate never appears twice.
  // ── One real-world encounter = one timeline entry ──────────────────────────
  // The SAME visit is routinely documented in several uploaded files (a
  // billing record and a medical record for one ER visit; an affidavit copy of
  // a note). Those are distinct documents — the Records page rightly shows
  // each — but the chronology describes the patient's care, so the same
  // encounter must appear ONCE. Identity is date + provider + event type;
  // fields are merged, and the richest description wins. Encounters that
  // differ in provider or type (genuinely distinct same-day visits) stay
  // separate.
  const richness = (d: (typeof drafts)[number]) =>
    [d.diagnosis, d.procedure, d.treatment, d.imagingFindings, d.objectiveFindings, d.subjective, d.disposition, d.medications, d.functionalStatus, d.workStatus, d.restrictions].filter(Boolean).length;
  const merged: (typeof drafts)[number][] = [];
  for (const d of [...drafts].sort((a, b) => richness(b) - richness(a) || b.relevanceScore - a.relevanceScore)) {
    if (!Number.isFinite(d.eventDate.getTime())) continue;
    const day = d.eventDate.toISOString().slice(0, 10);
    // Same day + same event type + a compatible provider. "Compatible" means
    // the same clinician (allowing for abbreviated name forms), or one copy
    // simply not naming them (a billing abstract of a visit the chart records
    // in full) — an unnamed provider is missing information, not evidence of a
    // different encounter. Two named and DIFFERENT clinicians stay distinct.
    const held = merged.find(
      (o) => o.eventDate.toISOString().slice(0, 10) === day && o.eventType === d.eventType && sameProvider(o.provider, d.provider),
    );
    if (!held) {
      merged.push(d);
      continue;
    }
    // Merge: the held draft is the richer one; fill only what it is missing.
    for (const f of ["subjective", "pastMedicalHistory", "objectiveFindings", "diagnosis", "treatment", "procedure", "disposition", "imagingFindings", "medications", "functionalStatus", "workStatus", "restrictions", "impairmentRating", "facility", "sourceQuote"] as const) {
      if (!held[f] && d[f]) (held as Record<string, unknown>)[f] = d[f];
    }
    if (!held.provider && d.provider) held.provider = d.provider;
    held.relevanceScore = Math.max(held.relevanceScore, d.relevanceScore);
    if (!held.eventDateEnd && d.eventDateEnd) held.eventDateEnd = d.eventDateEnd;
  }
  drafts.length = 0;
  drafts.push(...merged);

  const seenKeys = new Set<string>();
  const deduped = drafts
    // Real-world scans occasionally yield an unparseable date (e.g. an OCR'd
    // "13/45/2023") — an event whose date is invalid can never be placed on
    // the timeline, so it is dropped rather than crashing the build.
    .filter((d) => Number.isFinite(d.eventDate.getTime()) && d.eventDate.getTime() <= Date.now() + 86_400_000)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .filter((d) => {
      // Provider is part of the key: two clinicians can document the same day
      // in the same words without it being the same encounter.
      const key = `${d.eventDate.toISOString().slice(0, 10)}|${providerIdentityKey(d.provider)}|${d.summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40)}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
  drafts.length = 0;
  drafts.push(...deduped);

  drafts.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());

  // ── Longitudinal pass (exemplar emphasis profile §§4, 6, 11, 12) ───────────
  // Walk the date-sorted timeline once to apply the devices that only exist
  // across encounters: first-visit-with-provider and new/changed-assessment
  // markers, "status post" anchors after a surgery, and explicit care-gap
  // notes — the exemplar never silently bridges a treatment gap.
  // Gap statements are only permitted once every uploaded document covering
  // the period has completed processing (no OCR queued/failed, text present).
  const allDocsProcessed = docs.every((d0) => {
    const f = d0.flags ?? "";
    return !/OCR queued|OCR in progress|OCR failed/i.test(f) && (d0.extractedText ?? "").length > 0;
  });
  const seenProviders = new Set<string>();
  const seenDiagnoses = new Set<string>();
  let lastSurgery: { date: Date; label: string } | null = null;
  let prevDate: Date | null = null;
  for (const d of drafts) {
    const providerKey = d.provider?.toLowerCase().replace(/[^a-z]+/g, " ").trim() ?? null;
    const notes: string[] = [];
    if (providerKey && !seenProviders.has(providerKey)) {
      seenProviders.add(providerKey);
      if (d.eventType === "CLINIC_VISIT" || d.eventType === "THERAPY") notes.push("Initial encounter with this provider.");
    }
    const dxKey = diagnosisKey(d.diagnosis);
    if (dxKey && !seenDiagnoses.has(dxKey)) {
      seenDiagnoses.add(dxKey);
      if (seenDiagnoses.size > 1) notes.push("New or changed assessment at this encounter.");
    }
    if (prevDate && allDocsProcessed) {
      const gap = careGapNote(prevDate, d.eventDate);
      if (gap) notes.push(gap);
    }
    if (d.eventType !== "SURGERY") {
      // A status-post anchor is attached ONLY when the encounter's own text
      // documents post-operative context — chronological proximity to a
      // surgery is never enough to assert a post-operative relationship.
      const anchor = d.mentionsPostOp ? statusPostAnchor(d.eventDate, lastSurgery) : null;
      if (anchor && !d.summary.toLowerCase().includes("status post")) {
        d.summary = `${d.summary.replace(/\.$/, "")} (${anchor}).`;
      }
    } else {
      const label = (d.procedure ?? d.summary).split(/[.;(]/)[0].trim().slice(0, 70);
      if (looksLikeProcedureLabel(label)) lastSurgery = { date: d.eventDate, label };
    }
    if (notes.length) {
      d.clinicalSignificance = [d.clinicalSignificance, ...notes].filter(Boolean).join(" ");
      d.relevanceScore = Math.min(100, d.relevanceScore + 5);
    }
    prevDate = d.eventDate;
  }

  // Atomic swap: clear the old timeline and insert the new one in one
  // transaction, so a failure never leaves the case with zero events.
  const rows = drafts.map((d) => ({
    caseId,
    eventDate: d.eventDate,
    eventDateEnd: d.eventDateEnd,
    eventType: d.eventType,
    specialty: d.specialty,
    provider: d.provider,
    facility: d.facility,
    recordType: d.recordType,
    summary: d.summary,
    subjective: d.subjective,
    pastMedicalHistory: d.pastMedicalHistory,
    objectiveFindings: d.objectiveFindings,
    diagnosis: d.diagnosis,
    treatment: d.treatment,
    procedure: d.procedure,
    disposition: d.disposition,
    imagingFindings: d.imagingFindings,
    medications: d.medications,
    functionalStatus: d.functionalStatus,
    workStatus: d.workStatus,
    restrictions: d.restrictions,
    impairmentRating: d.impairmentRating,
    clinicalSignificance: d.clinicalSignificance,
    sourceQuote: d.sourceQuote,
    relevanceScore: d.relevanceScore,
    sourceDocumentId: d.sourceDocumentId,
    // An unknown source page STAYS unknown — never coerced to page 1.
    sourcePage: d.sourcePage,
    dateInferred: d.dateInferred,
    // Causal relatedness is a professional judgment, not an extraction output:
    // events enter the timeline UNCLEAR until a qualified human (or a gated
    // medical-opinion workflow) determines otherwise.
    relatedness: "UNCLEAR" as const,
    reviewStatus: "AI_DRAFT",
    sourceFingerprint: fingerprintByDoc.get(d.sourceDocumentId) ?? null,
  }));
  // ── Preservation-aware swap ────────────────────────────────────────────────
  // Human work is never destroyed by a regeneration: HUMAN_EDITED / REVIEWED /
  // VERIFIED events (and legacy `edited` rows) are preserved. When their
  // source document's bytes changed, they are marked STALE — the fresh draft
  // generated alongside is the comparison candidate. Only AI drafts are
  // replaced. A reviewer's correction is never silently overwritten, and
  // verification never carries to materially changed content.
  const preserved = await prisma.chronologyEvent.findMany({
    where: { caseId, OR: [{ edited: true }, { reviewStatus: { in: ["HUMAN_EDITED", "REVIEWED", "VERIFIED", "STALE"] } }] },
  });
  for (const h of preserved) {
    const currentFp = h.sourceDocumentId ? fingerprintByDoc.get(h.sourceDocumentId) ?? null : null;
    if (h.reviewStatus !== "STALE" && h.sourceFingerprint && currentFp && h.sourceFingerprint !== currentFp) {
      await prisma.chronologyEvent.update({
        where: { id: h.id },
        data: { reviewStatus: "STALE", staleReason: "Source document content changed after review; re-review required." },
      });
    }
  }
  const preservedKeys = new Set(
    preserved.map((h) => `${h.eventDate.toISOString().slice(0, 10)}|${(h.provider ?? "").toLowerCase()}|${h.sourceDocumentId ?? ""}`),
  );
  const freshRows = rows.filter(
    (r) => !preservedKeys.has(`${r.eventDate.toISOString().slice(0, 10)}|${(r.provider ?? "").toLowerCase()}|${r.sourceDocumentId ?? ""}`),
  );
  await prisma.$transaction([
    prisma.chronologyEvent.deleteMany({ where: { caseId, edited: false, reviewStatus: { in: ["AI_DRAFT", "SUPERSEDED"] } } }),
    ...(freshRows.length ? [prisma.chronologyEvent.createMany({ data: freshRows })] : []),
  ]);

  return { kept: freshRows.length + preserved.length, screened: docs.length, excluded: Math.max(0, docs.length - drafts.length) };
}

/**
 * Zero reliable events: raise a clear review finding and leave the chronology
 * EMPTY. A fabricated specialty-template timeline is never created.
 */
export async function handleEmptyChronology(caseId: string): Promise<void> {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, select: { firmId: true } });
  const existing = await prisma.attentionItem
    .findFirst({ where: { caseId, validationRuleId: "chronology.empty", status: { not: "RESOLVED" } } })
    .catch(() => null);
  if (existing) return;
  await prisma.attentionItem
    .create({
      data: {
        caseId,
        firmId: c.firmId,
        category: "chronology_empty",
        severity: "HIGH",
        title: "No reliable chronology events were extracted",
        summary:
          "The uploaded records did not yield reliably dated, cited clinical encounters. The chronology has been left empty rather than filled with template content.",
        whyItMatters: "An empty chronology means the clinical course cannot yet be established from the records as processed.",
        suggestedAction: "Review the records for readability (OCR state), documented service dates, and classification; re-run extraction once corrected.",
        validationRuleId: "chronology.empty",
      },
    })
    .catch(() => {});
}
