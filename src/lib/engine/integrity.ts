// ─────────────────────────────────────────────────────────────────────────────
// Life Care Plan integrity / correction layer (additive — no schema change).
//
// A deterministic validation layer that runs at report time (and is reusable at
// generation time) to keep every future-care recommendation clinically coherent:
//   • diagnosis mapping by anatomy / body region / specialty, instead of
//     defaulting every item to the primary diagnosis;
//   • CPT / HCPCS ↔ service ↔ region ↔ pricing consistency;
//   • literature relevance (diagnosis / region / intervention / population /
//     evidence level) with a minimum threshold before a citation may appear;
//   • honest recommendation status and inclusion-in-totals rules;
//   • an integrity check that flags issues, grades severity, and blocks export
//     on critical errors.
//
// Everything here is pure and deterministic — no network, no fabrication — and
// takes minimal structural inputs so it is trivially unit-testable and does not
// couple the report to the Prisma types.
// ─────────────────────────────────────────────────────────────────────────────

// ── Body region / anatomy ────────────────────────────────────────────────────
export type BodyRegion =
  | "knee" | "hip" | "shoulder" | "spine" | "ankle_foot" | "wrist_hand" | "elbow"
  | "brain_head" | "genitourinary" | "psych" | "general";

const REGION_PATTERNS: { region: BodyRegion; re: RegExp }[] = [
  { region: "genitourinary", re: /\b(bladder|urolog|urinary|neurogenic bladder|catheter|incontinen|urethra|renal|nephro|voiding)\b/i },
  { region: "brain_head", re: /\b(brain|tbi|concussion|intracranial|cranial|head injury|cognit|neuropsych|memory|encephal)\b/i },
  { region: "psych", re: /\b(depress|anxi|ptsd|psychiatr|psycholog|mood|emotional)\b/i },
  { region: "spine", re: /\b(spine|spinal|lumbar|thoracic|cervical|vertebra|vertebral|disc\b|discectomy|radiculopath|stenosis|myelopath|fusion|arthrodesis|laminectomy|sci\b|spinal cord|paraparesis|tetrapar|quadripar|thoracolumbar|burst fracture|compression fracture)\b|\b(?:[LTCS][1-9]|T1[0-2])\b/i },
  { region: "knee", re: /\b(knee|patell|tibial plateau|meniscus|\bacl\b|\bpcl\b|\btka\b|genu|femorotibial|tibiofemoral)\b/i },
  { region: "hip", re: /\b(hip|acetabul|femoral head|femoral neck|\btha\b|coxa)\b/i },
  { region: "shoulder", re: /\b(shoulder|rotator cuff|glenohumeral|glenoid|labr(?:um|al)|supraspinatus|acromio)\b/i },
  { region: "ankle_foot", re: /\b(ankle|foot|calcaneus|achilles|plantar|hindfoot|midfoot|talus|metatars)\b/i },
  { region: "wrist_hand", re: /\b(wrist|hand|carpal|metacarp|scaphoid|finger|thumb)\b/i },
  { region: "elbow", re: /\b(elbow|olecranon|epicondyl|radial head)\b/i },
];

/** The dominant body region named in a piece of clinical text. */
export function bodyRegion(text: string | null | undefined): BodyRegion {
  const s = text || "";
  for (const { region, re } of REGION_PATTERNS) if (re.test(s)) return region;
  return "general";
}

// ── Minimal input shapes (structurally satisfied by the Prisma rows) ─────────
export interface RecInput {
  service: string;
  specialty?: string | null;
  category?: string | null;
  cptCode?: string | null;
  pricingSource?: string | null;
  unitCost?: number;
  presentValue?: number;
  probability?: string;
  physicianStatus?: string;
  conditionId?: string | null;
}
export interface CondInput {
  id: string;
  name: string;
  relatedness?: string;
  supportingRecords?: string | null;
  evidenceSources?: unknown;
}

// ── 1. Diagnosis mapping ─────────────────────────────────────────────────────
export interface MappingResult {
  conditionId: string | null;
  condition: CondInput | null;
  region: BodyRegion;
  matched: boolean; // false = a region-specific rec with no diagnosis in that region
  reason: string;
}

const injuryRelated = (c: CondInput) => c.relatedness === "RELATED" || c.relatedness === "AGGRAVATION" || c.relatedness == null;

/**
 * Map a recommendation to the diagnosis it actually belongs to, by body region
 * (falling back to specialty). Region-agnostic care (case management, generic
 * labs, transportation) maps to any injury-related diagnosis without a mismatch.
 * A region-specific rec with NO diagnosis in that region is left unmatched and
 * flagged.
 */
export function mapRecommendationToCondition(rec: RecInput, conditions: CondInput[]): MappingResult {
  const region = bodyRegion(`${rec.service} ${rec.specialty ?? ""}`);
  const related = conditions.filter(injuryRelated);
  const pool = related.length ? related : conditions;

  if (region === "general") {
    const first = pool[0] ?? null;
    return { conditionId: first?.id ?? null, condition: first, region, matched: true, reason: "Region-agnostic service; mapped to an injury-related diagnosis." };
  }
  const hit = pool.find((c) => bodyRegion(c.name) === region);
  if (hit) return { conditionId: hit.id, condition: hit, region, matched: true, reason: `Mapped to ${hit.name} on ${region.replace(/_/g, "/")} region match.` };
  return { conditionId: null, condition: null, region, matched: false, reason: `No documented ${region.replace(/_/g, "/")} diagnosis supports this recommendation.` };
}

// ── 2. CPT / HCPCS coding & pricing ──────────────────────────────────────────
type CodeKind =
  | "arthroplasty" | "revision_arthroplasty" | "fracture_fixation" | "fusion" | "discectomy"
  | "laminectomy" | "injection_tf" | "injection_il" | "injection_joint" | "emg_ncs"
  | "imaging_mri" | "office_visit" | "therapy" | "other";
interface CodeProfile { region: BodyRegion | "any" | "large_joint"; kind: CodeKind; desc: string }

// A compact, real CPT reference — enough to validate the common LCP procedures.
const CPT_TABLE: Record<string, CodeProfile> = {
  // Knee arthroplasty / revision
  "27447": { region: "knee", kind: "arthroplasty", desc: "Total knee arthroplasty" },
  "27446": { region: "knee", kind: "arthroplasty", desc: "Unicompartmental knee arthroplasty" },
  "27486": { region: "knee", kind: "revision_arthroplasty", desc: "Revision TKA, one component" },
  "27487": { region: "knee", kind: "revision_arthroplasty", desc: "Revision TKA, femoral and tibial components" },
  "27535": { region: "knee", kind: "fracture_fixation", desc: "ORIF tibial plateau, unicondylar" },
  "27536": { region: "knee", kind: "fracture_fixation", desc: "ORIF tibial plateau, bicondylar" },
  // Hip arthroplasty / revision
  "27130": { region: "hip", kind: "arthroplasty", desc: "Total hip arthroplasty" },
  "27132": { region: "hip", kind: "arthroplasty", desc: "Conversion to total hip arthroplasty" },
  "27134": { region: "hip", kind: "revision_arthroplasty", desc: "Revision total hip arthroplasty" },
  // Shoulder
  "23412": { region: "shoulder", kind: "other", desc: "Rotator cuff repair, open" },
  "29827": { region: "shoulder", kind: "other", desc: "Arthroscopic rotator cuff repair" },
  // Spine fusion / decompression
  "22558": { region: "spine", kind: "fusion", desc: "Anterior lumbar interbody fusion" },
  "22612": { region: "spine", kind: "fusion", desc: "Posterior lumbar fusion" },
  "22630": { region: "spine", kind: "fusion", desc: "Posterior lumbar interbody fusion" },
  "22633": { region: "spine", kind: "fusion", desc: "Posterior/transforaminal lumbar interbody fusion" },
  "63030": { region: "spine", kind: "discectomy", desc: "Lumbar discectomy" },
  "63047": { region: "spine", kind: "laminectomy", desc: "Lumbar laminectomy/decompression" },
  // Epidural / transforaminal injections
  "62321": { region: "spine", kind: "injection_il", desc: "Interlaminar epidural, cervical/thoracic" },
  "62323": { region: "spine", kind: "injection_il", desc: "Interlaminar epidural, lumbar/sacral" },
  "64479": { region: "spine", kind: "injection_tf", desc: "Transforaminal epidural, cervical/thoracic" },
  "64483": { region: "spine", kind: "injection_tf", desc: "Transforaminal epidural, lumbar/sacral" },
  "64484": { region: "spine", kind: "injection_tf", desc: "Transforaminal epidural, lumbar/sacral, add-on" },
  // Large-joint injection
  "20610": { region: "large_joint", kind: "injection_joint", desc: "Major joint injection/aspiration" },
  "20611": { region: "large_joint", kind: "injection_joint", desc: "Major joint injection with ultrasound" },
  // EMG / NCS
  "95886": { region: "any", kind: "emg_ncs", desc: "Needle EMG, complete, with NCS" },
  "95910": { region: "any", kind: "emg_ncs", desc: "Nerve conduction studies" },
  "95911": { region: "any", kind: "emg_ncs", desc: "Nerve conduction studies" },
  "95913": { region: "any", kind: "emg_ncs", desc: "Nerve conduction studies" },
  // MRI
  "72148": { region: "spine", kind: "imaging_mri", desc: "MRI lumbar spine" },
  "72146": { region: "spine", kind: "imaging_mri", desc: "MRI thoracic spine" },
  "72141": { region: "spine", kind: "imaging_mri", desc: "MRI cervical spine" },
  "73721": { region: "knee", kind: "imaging_mri", desc: "MRI lower extremity joint (knee)" },
  "73221": { region: "shoulder", kind: "imaging_mri", desc: "MRI upper extremity joint (shoulder)" },
  // Office visits (region-agnostic E/M)
  "99203": { region: "any", kind: "office_visit", desc: "Office visit, new" },
  "99204": { region: "any", kind: "office_visit", desc: "Office visit, new" },
  "99213": { region: "any", kind: "office_visit", desc: "Office visit, established" },
  "99214": { region: "any", kind: "office_visit", desc: "Office visit, established" },
  "97129": { region: "any", kind: "therapy", desc: "Cognitive function intervention" },
  "92507": { region: "any", kind: "therapy", desc: "Speech/language treatment" },
  "97110": { region: "any", kind: "therapy", desc: "Therapeutic exercise" },
  "97112": { region: "any", kind: "therapy", desc: "Neuromuscular re-education" },
  "97530": { region: "any", kind: "therapy", desc: "Therapeutic activities" },
  // Additional common LCP codes (E/M, consult, psych, labs, DME/HCPCS, case mgmt,
  // facet/RFA) — recognized so the system's own assignments validate cleanly.
  "99202": { region: "any", kind: "office_visit", desc: "Office visit, new" },
  "99205": { region: "any", kind: "office_visit", desc: "Office visit, new" },
  "99212": { region: "any", kind: "office_visit", desc: "Office visit, established" },
  "99215": { region: "any", kind: "office_visit", desc: "Office visit, established" },
  "99244": { region: "any", kind: "office_visit", desc: "Office consultation" },
  "99245": { region: "any", kind: "office_visit", desc: "Office consultation" },
  "90837": { region: "any", kind: "other", desc: "Psychotherapy, 60 minutes" },
  "80053": { region: "any", kind: "other", desc: "Comprehensive metabolic panel" },
  "70551": { region: "brain_head", kind: "imaging_mri", desc: "MRI brain without contrast" },
  "95885": { region: "any", kind: "emg_ncs", desc: "Needle EMG, limited, with NCS" },
  "95907": { region: "any", kind: "emg_ncs", desc: "Nerve conduction studies" },
  "95908": { region: "any", kind: "emg_ncs", desc: "Nerve conduction studies" },
  "64633": { region: "spine", kind: "other", desc: "Facet joint denervation, cervical/thoracic" },
  "64635": { region: "spine", kind: "other", desc: "Facet joint denervation (RFA), lumbar/sacral" },
  "L5301": { region: "any", kind: "other", desc: "Below-knee prosthesis" },
  "K0001": { region: "any", kind: "other", desc: "Standard wheelchair" },
  "K0861": { region: "any", kind: "other", desc: "Power wheelchair, Group 3" },
  "T2022": { region: "any", kind: "other", desc: "Targeted case management" },
};

interface ServiceProfile { region: BodyRegion; kind: CodeKind | "unknown" }
function serviceProfile(service: string): ServiceProfile {
  const s = service.toLowerCase();
  const region = bodyRegion(service);
  let kind: CodeKind | "unknown" = "unknown";
  if (/\brevision\b.*(arthroplast|replacement)|revision (tka|thka|tha|knee|hip)/.test(s)) kind = "revision_arthroplasty";
  else if (/arthroplast|joint replacement|\btka\b|\btha\b|knee replacement|hip replacement/.test(s)) kind = "arthroplasty";
  else if (/\borif\b|open reduction|fracture fixation|internal fixation/.test(s)) kind = "fracture_fixation";
  else if (/fusion|arthrodesis|interbody/.test(s)) kind = "fusion";
  else if (/discectom|microdiscectom/.test(s)) kind = "discectomy";
  else if (/laminectom|decompress/.test(s)) kind = "laminectomy";
  else if (/transforaminal/.test(s)) kind = "injection_tf";
  else if (/interlaminar|epidural steroid|\besi\b/.test(s)) kind = "injection_il";
  else if (/inject|aspiration|viscosupplement|corticosteroid injection/.test(s)) kind = "injection_joint";
  else if (/\bemg\b|\bncs\b|electromyograph|nerve conduction/.test(s)) kind = "emg_ncs";
  else if (/\bmri\b|magnetic resonance/.test(s)) kind = "imaging_mri";
  else if (/office visit|follow-?up|consultation|evaluation|clinic visit|\be\/?m\b/.test(s)) kind = "office_visit";
  else if (/therap(y|ies)|rehabilitation/.test(s)) kind = "therapy";
  return { region, kind };
}

const LARGE_JOINT: BodyRegion[] = ["knee", "hip", "shoulder", "ankle_foot", "elbow", "wrist_hand"];
function regionsConflict(a: CodeProfile["region"], b: BodyRegion): boolean {
  if (a === "any" || b === "general") return false;
  if (a === "large_joint") return !LARGE_JOINT.includes(b);
  return a !== b;
}

export type CodeStatus = "Validated" | "Missing code" | "Code mismatch" | "Requires review";
export interface CodeResult { status: CodeStatus; detail: string; expected?: string }

/** Validate the CPT/HCPCS code against the service name and its body region. */
export function validateCode(rec: RecInput): CodeResult {
  const code = (rec.cptCode ?? "").trim();
  const svc = serviceProfile(rec.service);
  if (!code) {
    // A blank code is acceptable when the pricing basis transparently discloses
    // a bundled / non-code-specific estimate (e.g. attendant care, medications).
    if (/bundl|estimate|allowance|composite|non-code|package|global/i.test(rec.pricingSource ?? "")) {
      return { status: "Validated", detail: "Non-code-specific bundled service; pricing disclosed as a bundled estimate." };
    }
    return { status: "Missing code", detail: "No procedure code assigned to a coded service." };
  }
  const prof = CPT_TABLE[code];
  if (!prof) return { status: "Requires review", detail: `CPT ${code} is not in the validated reference; confirm it matches “${rec.service}”.` };
  // Region conflict (e.g. a knee arthroplasty code on a spine procedure).
  if (regionsConflict(prof.region, svc.region)) {
    return { status: "Code mismatch", detail: `CPT ${code} (${prof.desc}) is a ${prof.region.replace(/_/g, " ")} code but the service is ${svc.region.replace(/_/g, "/")}.` };
  }
  // Modality / kind conflict (EMG service billed as MRI, etc.).
  if (svc.kind === "emg_ncs" && prof.kind === "imaging_mri") return { status: "Code mismatch", detail: `CPT ${code} (${prof.desc}) is imaging, but the service is an electrodiagnostic (EMG/NCS) study.` };
  if (svc.kind === "imaging_mri" && prof.kind === "emg_ncs") return { status: "Code mismatch", detail: `CPT ${code} is an electrodiagnostic code, but the service is imaging.` };
  // Injection approach conflict (transforaminal vs interlaminar).
  if (svc.kind === "injection_tf" && prof.kind === "injection_il") return { status: "Code mismatch", detail: `CPT ${code} (${prof.desc}) is an interlaminar code, but the service is a transforaminal injection (expected 64483/64484).`, expected: "64483/64484" };
  if (svc.kind === "injection_il" && prof.kind === "injection_tf") return { status: "Code mismatch", detail: `CPT ${code} (${prof.desc}) is a transforaminal code, but the service is described as interlaminar.` };
  return { status: "Validated", detail: `CPT ${code} (${prof.desc}) is consistent with the service.` };
}

export type PricingStatus = "Validated" | "Requires review" | "Pricing mismatch" | "Unsupported bundled estimate";
export interface PricingResult { status: PricingStatus; detail: string }

/** Validate the pricing basis against the service (modality/region/coding). */
export function validatePricing(rec: RecInput): PricingResult {
  const src = (rec.pricingSource ?? "").trim();
  const svc = serviceProfile(rec.service);
  const code = (rec.cptCode ?? "").trim();
  const hasCost = (rec.unitCost ?? 0) > 0;
  // Pricing basis names a modality/region that conflicts with the service.
  if (svc.kind === "emg_ncs" && /\bmri\b|magnetic resonance|\bct\b|imaging/i.test(src)) return { status: "Pricing mismatch", detail: `Pricing basis references imaging (“${src}”) for an electrodiagnostic (EMG/NCS) study.` };
  if (svc.kind === "imaging_mri" && /\bemg\b|\bncs\b|nerve conduction/i.test(src)) return { status: "Pricing mismatch", detail: `Pricing basis references electrodiagnostics for an imaging study.` };
  if (svc.region === "spine" && /\bknee\b|hip\b|arthroplasty/i.test(src)) return { status: "Pricing mismatch", detail: `Pricing basis (“${src}”) does not match a spine service.` };
  // A blank code paired with a precise cost and no bundled/estimate disclosure.
  if (!code && hasCost && !/bundl|estimate|allowance|composite|non-code|package|global/i.test(src)) {
    return { status: "Unsupported bundled estimate", detail: `A specific unit cost is stated with no procedure code and no bundled/estimate disclosure.` };
  }
  if (!src) return { status: "Requires review", detail: "No pricing source recorded." };
  return { status: "Validated", detail: `Pricing basis: ${src}.` };
}

// ── 3. Literature relevance ──────────────────────────────────────────────────
export interface CitationInput { title?: string; journal?: string; year?: string; pubtype?: string[]; abstract?: string; pmid?: string; doi?: string; url?: string }
export interface RelevanceContext { diagnosis: string; region?: BodyRegion; service: string; adult?: boolean }
export interface RelevanceResult {
  relevant: boolean;
  relevanceScore: number; // 0..100
  evidenceLevel: number; // 1 (guideline) .. 8 (case report)
  evidenceLabel: string;
  diagnosisMatch: boolean;
  interventionMatch: boolean;
  populationMatch: boolean;
  outcomeMatch: boolean;
  rationale: string;
}

const EVIDENCE_TIERS: { level: number; label: string; re: RegExp }[] = [
  { level: 1, label: "Clinical practice guideline", re: /\b(guideline|consensus|recommendation|practice advisory|appropriate use criteria|position statement)\b/i },
  { level: 2, label: "Systematic review / meta-analysis", re: /\b(systematic review|meta-?analysis|meta-?analytic)\b/i },
  { level: 3, label: "Cohort / registry study", re: /\b(cohort|registry|longitudinal|prospective|survivorship)\b/i },
  { level: 5, label: "Randomized controlled trial", re: /\b(randomi[sz]ed|randomised|\brct\b|controlled trial)\b/i },
  { level: 7, label: "Case series", re: /\b(case series|retrospective series)\b/i },
  { level: 8, label: "Case report", re: /\b(case report|a case of)\b/i },
];
const STOP = new Set(["and", "the", "of", "with", "for", "due", "initial", "encounter", "unspecified", "chronic", "acute", "status", "post", "left", "right", "bilateral", "severe", "mild", "moderate", "pain", "injury", "fracture", "disorder", "syndrome", "care", "management", "treatment"]);
function keyTerms(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
}
const POP_MISMATCH = /\b(pediatric|paediatric|congenital|neonat|infant|adolescen|in children|childhood|\bchild\b)\b/i;

/** Evaluate a single citation against a recommendation's clinical context. */
export function evaluateCitation(cite: CitationInput, ctx: RelevanceContext): RelevanceResult {
  const hay = `${cite.title ?? ""} ${(cite.pubtype ?? []).join(" ")}`.toLowerCase();
  const abs = (cite.abstract ?? "").toLowerCase();
  const tier = EVIDENCE_TIERS.find((t) => t.re.test(hay)) ?? { level: 6, label: "Specialty review", re: /./ };

  const dxTerms = keyTerms(ctx.diagnosis);
  const diagnosisMatch = dxTerms.some((t) => hay.includes(t) || abs.includes(t)) || (ctx.region != null && ctx.region !== "general" && bodyRegion(hay) === ctx.region);
  const svcTerms = keyTerms(ctx.service);
  const interventionMatch = svcTerms.some((t) => hay.includes(t) || abs.includes(t));
  // Population: an adult, injury-related case is not supported by pediatric /
  // congenital literature.
  const adult = ctx.adult !== false;
  const populationMatch = !(adult && POP_MISMATCH.test(hay));
  const outcomeMatch = /\b(outcome|survivorship|complication|frequency|duration|natural history|necessity|efficac|revision rate|prognos)\b/i.test(hay + " " + abs);

  let score = Math.max(0, 60 - tier.level * 5); // stronger evidence → higher base
  if (diagnosisMatch) score += 25;
  if (interventionMatch) score += 15;
  if (outcomeMatch) score += 5;
  if (!populationMatch) score -= 60;
  // A case report only counts for a rare/unusual condition; otherwise it is
  // discounted below threshold.
  const rare = /\b(rare|unusual|atypical|novel)\b/i.test(hay);
  if (tier.level >= 7 && !rare) score -= 40;
  score = Math.max(0, Math.min(100, score));

  const relevant = score >= 50 && diagnosisMatch && populationMatch;
  const reasons: string[] = [];
  if (!diagnosisMatch) reasons.push("diagnosis/region not addressed");
  if (!populationMatch) reasons.push("population mismatch (pediatric/congenital vs. adult injury)");
  if (tier.level >= 7 && !rare) reasons.push("case-level evidence for a non-rare condition");
  if (!interventionMatch) reasons.push("intervention not addressed");
  const rationale = relevant
    ? `${tier.label}; addresses the diagnosis${interventionMatch ? " and intervention" : ""}.`
    : `Excluded — ${reasons.join("; ") || "insufficient relevance"}.`;

  return { relevant, relevanceScore: score, evidenceLevel: tier.level, evidenceLabel: tier.label, diagnosisMatch, interventionMatch, populationMatch, outcomeMatch, rationale };
}

/** Keep only citations meeting the relevance threshold, best evidence first. */
export function filterCitations(cites: CitationInput[], ctx: RelevanceContext): { kept: (CitationInput & { relevance: RelevanceResult })[]; rejected: (CitationInput & { relevance: RelevanceResult })[] } {
  const kept: (CitationInput & { relevance: RelevanceResult })[] = [];
  const rejected: (CitationInput & { relevance: RelevanceResult })[] = [];
  for (const c of cites) {
    const relevance = evaluateCitation(c, ctx);
    (relevance.relevant ? kept : rejected).push({ ...c, relevance });
  }
  kept.sort((a, b) => a.relevance.evidenceLevel - b.relevance.evidenceLevel || b.relevance.relevanceScore - a.relevance.relevanceScore);
  return { kept, rejected };
}

// ── 7. Functional assessment extraction ──────────────────────────────────────
// A finding is "quantified" when the sentence carries a measured value.
const FUNCTIONAL_QUANT = /\d+\s?(?:°|degrees?|%|percent|feet|ft\b|minutes?|mins?|pounds?|lbs?|meters?|steps?|blocks?)|\b\d+\/10\b|grade\s?[0-5]|\b[0-5]\/5\b|\d+\s?(?:reps|sets)/i;

/**
 * Pull the specific documented finding for a functional domain out of the
 * record text — so "rolling walker" or "gait training" is carried into the
 * Functional Assessment instead of a generic "impairment documented" phrase.
 * Returns null when the domain is not addressed.
 */
export function functionalFinding(text: string, re: RegExp): { snippet: string; quantified: boolean } | null {
  const sentences = (text || "").split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const s = sentences.find((x) => re.test(x));
  if (!s) return null;
  const snippet = s.length > 150 ? s.slice(0, 149).trimEnd() + "…" : s;
  return { snippet, quantified: FUNCTIONAL_QUANT.test(s) };
}

// ── 5/6. Recommendation status & inclusion in totals ─────────────────────────
export type RecStatus =
  | "SUPPORTED_INCLUDED" | "RECORD_SUPPORTED_PENDING" | "POSSIBLE_CONTINGENCY"
  | "SPECULATIVE" | "INSUFFICIENT" | "REJECTED";

const STATUS_LABEL: Record<RecStatus, string> = {
  SUPPORTED_INCLUDED: "Supported and included",
  RECORD_SUPPORTED_PENDING: "Record-supported; physician confirmation pending",
  POSSIBLE_CONTINGENCY: "Possible contingency; not included",
  SPECULATIVE: "Speculative; not included",
  INSUFFICIENT: "Insufficient evidence; requires review",
  REJECTED: "Rejected by reviewer",
};

// Physician-review labels — accurate to the review action actually recorded.
const REVIEW_LABEL: Record<string, string> = {
  PENDING: "Proposed by planner; awaiting physician review",
  APPROVED: "Physician approved",
  MODIFIED: "Physician approved with modification",
  REJECTED: "Physician rejected",
};
export function reviewLabel(physicianStatus: string | undefined, hasRecordSupport: boolean): string {
  const st = physicianStatus ?? "PENDING";
  if (st === "PENDING" && hasRecordSupport) return "Supported in treating record; awaiting physician review";
  return REVIEW_LABEL[st] ?? "Not reviewed";
}

export interface ClassifyContext { matched: boolean; codeCritical: boolean; hasRecordSupport: boolean }
export interface ClassifyResult { status: RecStatus; label: string; includedInTotal: boolean; reason: string }

/**
 * Determine a recommendation's status and whether it may enter the damages
 * total. A recommendation is included only when it is region-matched, free of a
 * critical coding/pricing error, and either physician-approved or
 * record-supported and medically probable. "Offered for confirmation" is NOT
 * sufficient to include an unsupported item.
 */
export function classifyRecommendation(rec: RecInput, ctx: ClassifyContext): ClassifyResult {
  const st = rec.physicianStatus ?? "PENDING";
  const prob = rec.probability ?? "POSSIBLE";
  if (st === "REJECTED") return { status: "REJECTED", label: STATUS_LABEL.REJECTED, includedInTotal: false, reason: "Declined on physician review." };

  // A critical mapping/coding defect blocks inclusion regardless of status.
  if (!ctx.matched) return { status: "INSUFFICIENT", label: STATUS_LABEL.INSUFFICIENT, includedInTotal: false, reason: "No region-matched diagnosis supports this recommendation." };
  if (ctx.codeCritical) return { status: "INSUFFICIENT", label: STATUS_LABEL.INSUFFICIENT, includedInTotal: false, reason: "Coding/pricing inconsistency must be resolved before inclusion." };

  if (st === "APPROVED" || st === "MODIFIED") return { status: "SUPPORTED_INCLUDED", label: STATUS_LABEL.SUPPORTED_INCLUDED, includedInTotal: true, reason: "Approved on physician review." };
  if (prob === "NOT_SUPPORTED") return { status: "INSUFFICIENT", label: STATUS_LABEL.INSUFFICIENT, includedInTotal: false, reason: "Not supported by the current record." };
  if (prob === "SPECULATIVE") return { status: "SPECULATIVE", label: STATUS_LABEL.SPECULATIVE, includedInTotal: false, reason: "Foreseeable but not more likely than not." };

  const probable = prob === "PROBABLE";
  if (ctx.hasRecordSupport && probable) return { status: "RECORD_SUPPORTED_PENDING", label: STATUS_LABEL.RECORD_SUPPORTED_PENDING, includedInTotal: true, reason: "Record-supported and medically probable; physician confirmation pending." };
  return { status: "POSSIBLE_CONTINGENCY", label: STATUS_LABEL.POSSIBLE_CONTINGENCY, includedInTotal: false, reason: "Record support is thin; additional evidence or physician confirmation required." };
}

// ── 10. Integrity check ──────────────────────────────────────────────────────
export type Severity = "Critical" | "High" | "Moderate" | "Low";
export interface IntegrityFinding {
  recommendation: string;
  result: string;
  issue: string;
  severity: Severity;
  suggestedCorrection: string;
  exportBlocking: boolean;
}
export interface PerItem {
  rec: RecInput;
  mapping: MappingResult;
  code: CodeResult;
  pricing: PricingResult;
  classify: ClassifyResult;
  includedInTotal: boolean;
}
export interface IntegrityReport {
  perItem: Map<RecInput, PerItem>;
  findings: IntegrityFinding[];
  blocking: boolean;
  counts: { proposed: number; recordSupported: number; physicianApproved: number; awaitingReview: number; excluded: number; included: number };
}

const MAJOR_PV = 100_000; // "major recommendation" threshold for literature criticality

export interface IntegrityInput {
  recommendations: RecInput[];
  conditions: CondInput[];
  /** whether the matched diagnosis has patient-specific record support */
  hasRecordSupport: (rec: RecInput, matched: CondInput | null) => boolean;
}

/** Run the full integrity check across a case's recommendations. */
export function runIntegrityCheck(input: IntegrityInput): IntegrityReport {
  const perItem = new Map<RecInput, PerItem>();
  const findings: IntegrityFinding[] = [];
  let recordSupported = 0, physicianApproved = 0, awaitingReview = 0, excluded = 0, included = 0;

  for (const rec of input.recommendations) {
    const mapping = mapRecommendationToCondition(rec, input.conditions);
    const code = validateCode(rec);
    const pricing = validatePricing(rec);
    const hasRecordSupport = input.hasRecordSupport(rec, mapping.condition);
    const codeCritical = code.status === "Code mismatch" || pricing.status === "Pricing mismatch";
    const classify = classifyRecommendation(rec, { matched: mapping.matched, codeCritical, hasRecordSupport });

    perItem.set(rec, { rec, mapping, code, pricing, classify, includedInTotal: classify.includedInTotal });
    if (classify.includedInTotal) included++; else excluded++;
    if (hasRecordSupport) recordSupported++;
    if (rec.physicianStatus === "APPROVED" || rec.physicianStatus === "MODIFIED") physicianApproved++;
    if ((rec.physicianStatus ?? "PENDING") === "PENDING") awaitingReview++;

    // Findings.
    if (!mapping.matched) findings.push({ recommendation: rec.service, result: "Diagnosis mismatch", issue: mapping.reason, severity: "Critical", suggestedCorrection: `Link to a documented ${mapping.region.replace(/_/g, "/")} diagnosis, or remove the recommendation.`, exportBlocking: true });
    if (code.status === "Code mismatch") findings.push({ recommendation: rec.service, result: "Code mismatch", issue: code.detail, severity: "Critical", suggestedCorrection: code.expected ? `Assign an appropriate code (${code.expected}).` : "Assign a code matching the service and region.", exportBlocking: true });
    else if (code.status === "Missing code") findings.push({ recommendation: rec.service, result: "Missing code", issue: code.detail, severity: "Moderate", suggestedCorrection: "Assign the applicable CPT/HCPCS code, or state the estimate is non-code-specific.", exportBlocking: false });
    else if (code.status === "Requires review") findings.push({ recommendation: rec.service, result: "Requires review", issue: code.detail, severity: "Low", suggestedCorrection: "Confirm the code against the service description.", exportBlocking: false });
    if (pricing.status === "Pricing mismatch") findings.push({ recommendation: rec.service, result: "Pricing mismatch", issue: pricing.detail, severity: "Critical", suggestedCorrection: "Re-price the service against the correct modality/region.", exportBlocking: true });
    else if (pricing.status === "Unsupported bundled estimate") findings.push({ recommendation: rec.service, result: "Unsupported bundled estimate", issue: pricing.detail, severity: "High", suggestedCorrection: "Attach a code, or label the figure as a bundled/non-code-specific estimate.", exportBlocking: false });
    if (classify.status === "INSUFFICIENT" && mapping.matched && !codeCritical) findings.push({ recommendation: rec.service, result: "Insufficient support", issue: classify.reason, severity: "Moderate", suggestedCorrection: "Obtain treating-physician opinion or additional record support before inclusion.", exportBlocking: false });
    // An included item that lacks support is a defensive critical (should not occur).
    if (classify.includedInTotal && !hasRecordSupport && rec.physicianStatus !== "APPROVED" && rec.physicianStatus !== "MODIFIED") {
      findings.push({ recommendation: rec.service, result: "Unsupported item in totals", issue: "Included in totals without record support or physician approval.", severity: "Critical", suggestedCorrection: "Exclude from totals until supported.", exportBlocking: true });
    }
  }

  const severityRank: Record<Severity, number> = { Critical: 0, High: 1, Moderate: 2, Low: 3 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const blocking = findings.some((f) => f.exportBlocking);
  return {
    perItem,
    findings,
    blocking,
    counts: { proposed: input.recommendations.length, recordSupported, physicianApproved, awaitingReview, excluded, included },
  };
}

// Whether a citation is the "primary support" for a major recommendation but is
// irrelevant — a critical, export-blocking condition (§10).
export function irrelevantPrimaryLiterature(rec: RecInput, kept: CitationInput[], rejected: CitationInput[]): IntegrityFinding | null {
  const major = (rec.presentValue ?? 0) >= MAJOR_PV;
  if (major && kept.length === 0 && rejected.length > 0) {
    return { recommendation: rec.service, result: "Irrelevant literature", issue: "The only citations located for this major recommendation failed the relevance filter.", severity: "Critical", suggestedCorrection: "Cite relevant guideline/cohort evidence, or rely on documented treating-physician opinion.", exportBlocking: true };
  }
  return null;
}
