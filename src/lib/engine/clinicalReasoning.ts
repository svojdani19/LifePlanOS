import { buildRecommendationDossier, type DossierItem, type DossierCondition, type DossierChronoEvent, type DossierCase, type DossierInterview } from "@/lib/engine/medicalNecessity";
import { mapRecommendationToCondition, validateCode, validatePricing, classifyRecommendation, bodyRegion, anatomyCompatible, type RecInput, type CondInput } from "@/lib/engine/integrity";
import { resolveRecommendationCondition } from "@/lib/engine/recommendationCondition";
import { citationCompatible } from "@/lib/engine/citationQuality";
import { serviceKindOf } from "@/lib/engine/evidenceLedger";
import { entersSupportedTotal, supportClassOf } from "@/lib/engine/supportClass";
import { documentsNonResolution } from "@/lib/engine/assertionClassifier";
import { evidenceSetFingerprint, type EvidenceRowIdentity } from "@/lib/engine/evidenceSet";
import type { BasisRecord } from "@/lib/engine/recommendationBasis";
import { specialtyLens } from "@/lib/engine/specialtyReasoning";
import { lintAssessmentNarratives } from "@/lib/engine/narrativeSanity";
import { assessLifetimeSupport, describeLifetimeBasis, type LifetimeSupportResult } from "@/lib/engine/lifetimeSupport";

// ─────────────────────────────────────────────────────────────────────────────
// Clinical Reasoning Engine — Phase A.
//
// Reason FIRST, write second. For one recommendation this assembles the
// deterministic reasoning already produced by the dossier / integrity / citation
// engines into a single STRUCTURED assessment (condition, evidence, necessity,
// probability class, frequency & duration rationale, evidence strength vs.
// recommendation confidence, cost eligibility, inclusion, review status) — the
// object the report narrative and Evidence Explorer will render FROM in later
// phases. It reuses existing services and references existing records; it does
// not run a second recommendation model or approve anything.
//
// The pure builder is unit-tested; the async wrapper persists per-recommendation
// with a material-change hash (a change invalidates prior approval, Phase D).
// ─────────────────────────────────────────────────────────────────────────────

export type ProbabilityClassification = "PROBABLE_INCLUDED" | "CONDITIONAL_STAGED" | "POSSIBLE_CONTINGENCY_NOT_INCLUDED" | "INSUFFICIENTLY_SUPPORTED" | "NOT_RECOMMENDED" | "REJECTED_BY_REVIEWER";
export type EvidenceStrength = "STRONG" | "MODERATE" | "LIMITED" | "EXPERT_CONSENSUS" | "INSUFFICIENT";
export type RecommendationConfidence = "HIGH" | "MODERATE" | "LOW" | "INDETERMINATE";
export type DurationClass = "ONE_TIME" | "SHORT_TERM" | "FIXED_COURSE" | "EPISODIC" | "UNTIL_RECOVERY" | "UNTIL_SURGERY" | "MULTI_YEAR" | "LIFETIME" | "CONDITIONAL";

// A future-care row carries staged/conditional metadata beyond the dossier's view.
export type ReasoningItem = DossierItem & { contingencyOnly?: boolean | null; replacesService?: string | null };

export type ConflictType = "DUPLICATE" | "REPLACED_BY" | "REPLACES" | "ALTERNATIVE_BOTH_INCLUDED" | "OVERLAP" | "CONDITION_MAPPING";
export interface ConflictFlag { type: ConflictType; otherService: string; note: string }

// ── CRE v1 structured sub-objects ────────────────────────────────────────────

// Epistemic status of a piece of evidence — the engine must never present a
// patient report or an inference as a documented fact (§4).
export type EpistemicStatus = "documented_fact" | "patient_report" | "provider_opinion" | "planner_inference" | "ai_inference" | "unknown";
export type EvidenceCategory = "imaging" | "operative_findings" | "physical_examination" | "diagnostic_study" | "laboratory" | "symptom" | "functional_limitation" | "prior_treatment" | "treatment_response" | "treating_provider_recommendation" | "patient_interview" | "caregiver_interview" | "formal_assessment" | "guideline";
export interface ClassifiedEvidenceItem {
  category: EvidenceCategory;
  text: string;
  source: string | null; // filename / provider / "record"
  page: number | null;
  date: string | null;
  provider: string | null;
  objective: boolean;
  epistemic: EpistemicStatus;
}

// A weakening-evidence item (§9) — adverse evidence is never hidden.
export interface WeakeningItem {
  claim: string; // what part of the recommendation it weakens
  detail: string;
  source: string | null;
  page: number | null;
  materiality: "HIGH" | "MODERATE" | "LOW";
  reducesConfidence: boolean;
  changesInclusion: boolean;
  requiresReview: boolean;
}

// A precise unknown / evidence gap (§10) — never "progression is uncertain".
export interface UnknownItem {
  missing: string;
  whyItMatters: string;
  likelySource: string; // where the evidence would come from
  severity: "HIGH" | "MODERATE" | "LOW";
  blocksInclusion: boolean;
  reducesConfidence: boolean;
  suggestedAction: string;
}

export interface RejectedCitation { title: string; pmid?: string; reason: string }

// ── Reasoning Reliability sprint ─────────────────────────────────────────────
// Everything below exists to answer one physician question: "WHY did the AI
// reach this conclusion?" — with facts, inferences, and assumptions never
// blurred, and insufficiency stated instead of papered over.

/** One node of the immutable reasoning chain. `basis` separates what the
 *  record DOCUMENTS from what the engine INFERRED or ASSUMED. `rationale` is
 *  the edge explanation: why this node follows from the previous one. */
export interface ChainNode {
  stage: string;
  content: string | null; // null = honestly absent (never fabricated)
  source: string | null;
  basis: "documented_fact" | "inference" | "assumption" | "workflow";
  rationale: string;
}

/** Per-dimension evidence sufficiency with an explicit threshold verdict. */
export interface EvidenceSufficiency {
  objectiveFindings: number; // count of independent objective items
  imagingSupport: boolean;
  examSupport: boolean;
  recordSupport: number; // page-cited sources on the mapped diagnosis
  providerConsensus: boolean; // treating documentation / physician action on file
  chronologyConsistency: boolean; // events in the region's timeline support the course
  conflictingEvidence: number;
  score: number; // 0-100, deterministic
  sufficient: boolean; // score >= threshold
  threshold: number;
  missing: string[]; // exactly what evidence is missing
  explanation: string;
}

/** The engine's structured critique of its own recommendation (Phase 4). */
export interface SelfCritique {
  whyRecommended: string;
  whyPossiblyWrong: string[];
  evidenceAgainst: string[];
  recordsThatWouldChangeConfidence: string[];
  alternativeRecommendation: string | null;
  assumptions: string[]; // required but not documented
  inferredNotDocumented: string[]; // engine inferences vs explicit documentation
}

/** Ten independent confidence dimensions — never collapsed to one number. */
export interface ConfidenceVector {
  clinicalCertainty: number;
  evidenceQuality: number;
  objectiveEvidence: number;
  literatureSupport: number;
  guidelineSupport: number;
  providerAgreement: number;
  chronologyConsistency: number;
  medicalNecessity: number;
  contradictoryEvidence: number; // higher = MORE contradiction (a burden, not support)
  physicianReview: number;
}

export interface AlternativeExplanation { name: string; relation: string; whyConsidered: string }

export const SUFFICIENCY_THRESHOLD = 50; // configurable minimum evidence score


// Set-level context computed across ALL of a case's recommendations, injected
// into the per-item builder so one assessment can reason about its neighbours
// (duplicates, staged replacements, alternatives) without a second model.
export interface SetContext { conflicts: ConflictFlag[]; replacedByActive: boolean }

export interface LiteratureAssessment { title: string; pmid?: string; supports: string; applicability: string; evidenceLevel: number; limitations: string | null }

// Human-readable labels for rendering the structured assessment (report / UI).
export const PROBABILITY_LABEL: Record<ProbabilityClassification, string> = {
  PROBABLE_INCLUDED: "More likely than not — included in the plan",
  CONDITIONAL_STAGED: "Conditional / staged — disclosed, not totaled",
  POSSIBLE_CONTINGENCY_NOT_INCLUDED: "Possible contingency — disclosed, not totaled",
  INSUFFICIENTLY_SUPPORTED: "Insufficiently supported at this time",
  NOT_RECOMMENDED: "Not recommended",
  REJECTED_BY_REVIEWER: "Declined on physician review",
};
export const EVIDENCE_STRENGTH_LABEL: Record<EvidenceStrength, string> = { STRONG: "strong", MODERATE: "moderate", LIMITED: "limited", EXPERT_CONSENSUS: "expert consensus", INSUFFICIENT: "insufficient" };
export const CONFIDENCE_LABEL: Record<RecommendationConfidence, string> = { HIGH: "high", MODERATE: "moderate", LOW: "low", INDETERMINATE: "indeterminate" };

export type AssessmentLifecycleStatus = "NEEDS_REVIEW" | "VALIDATED" | "INVALID";

export interface ReasoningAssessment {
  recommendationService: string;
  supportingDiagnosisIds: string[];
  bodyRegion: string;
  laterality: string; // left | right | bilateral | n/a
  conditionSeverity: string; // mild | moderate | severe | end-stage | undetermined
  conditionChronicity: string; // acute | subacute | chronic | undetermined
  currentClinicalStatus: string; // under active treatment | surveillance | resolved | undetermined
  responsibleSpecialty: string;
  conditionTrajectory: string;
  causalRelationshipStatus: string;
  clinicalPurpose: string;
  evidenceItems: ClassifiedEvidenceItem[];
  objectiveEvidenceSummary: string | null;
  subjectiveEvidenceSummary: string | null;
  functionalBasisSummary: string | null;
  priorTreatmentSummary: string | null;
  treatmentResponseSummary: string | null;
  treatingRecordSupportSummary: string | null;
  medicalNecessityRationale: string;
  noTreatmentRisk: string;
  leastIntensiveRationale: string;
  timingRationale: string;
  probabilityClassification: ProbabilityClassification;
  clinicalPathwayStage: string | null;
  clinicalPathway: string;
  conflictFlags: ConflictFlag[];
  alternativesConsidered: { alternative: string; rationale: string }[];
  inclusionRationale: string;
  frequencyRationale: string;
  frequencySupported: boolean;
  durationClass: DurationClass;
  durationRationale: string;
  /** Deterministic lifetime-duration support verdict (Lifetime-Honesty sprint):
   *  the ONLY authority on whether a lifetime projection is clinically
   *  supported, and by what independent basis. `isLifetime` itself is a
   *  projection horizon and never counts as evidence. */
  durationSupport: LifetimeSupportResult;
  weakeningEvidence: WeakeningItem[];
  unknowns: UnknownItem[];
  missingEvidenceRequests: string[];
  supportingGuidelineAssessments: { title: string; claim: string }[];
  supportingLiteratureAssessments: LiteratureAssessment[];
  rejectedLiterature: RejectedCitation[];
  reasoningChain: ChainNode[];
  evidenceSufficiency: EvidenceSufficiency;
  selfCritique: SelfCritique;
  confidenceVector: ConfidenceVector;
  alternativeExplanations: AlternativeExplanation[];
  literatureSynthesis: string;
  residualUncertainty: string;
  evidenceStrength: EvidenceStrength;
  recommendationConfidence: RecommendationConfidence;
  confidenceExplanation: string;
  costEligibilityStatus: string;
  inclusionInTotalsStatus: "included" | "excluded" | "contingency";
  physicianReviewStatus: string;
  validationStatus: "ok" | "blocking" | "pending";
  /** CRE v1 lifecycle verdict — VALIDATED only when every gate passes. */
  lifecycleStatus: AssessmentLifecycleStatus;
  materialHash: string;
}

const lc = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

// §6 — the primary clinical purpose a category serves.
const PURPOSE: Partial<Record<string, string>> = {
  PAIN_MANAGEMENT: "symptom control", INJECTION: "symptom control", MEDICATION: "medication monitoring",
  PHYSICAL_THERAPY: "functional restoration", OCCUPATIONAL_THERAPY: "functional restoration", SPEECH_THERAPY: "functional restoration",
  PMR: "functional preservation", MOBILITY_AID: "maintenance of independence", ORTHOTICS_PROSTHETICS: "functional preservation",
  DME: "maintenance of independence", HOME_MODIFICATION: "maintenance of independence", ATTENDANT_CARE: "caregiver support", SKILLED_NURSING: "caregiver support",
  IMAGING: "disease surveillance", LABS: "disease surveillance", NEUROLOGY: "disease surveillance",
  ORTHOPEDIC_SURGERY: "treatment of progression", NEUROSURGERY: "treatment of progression", FUTURE_SURGERY: "treatment of progression", REVISION_SURGERY: "treatment of progression",
  COMPLICATION_MANAGEMENT: "complication prevention", PHYSICIAN_VISIT: "medication monitoring", SPECIALIST_VISIT: "disease surveillance", PRIMARY_CARE: "medication monitoring",
  PSYCH: "symptom control", COGNITIVE_THERAPY: "functional restoration",
};
function purposeFor(category: string | null | undefined, isLifetime: boolean): string {
  return PURPOSE[(category ?? "").toUpperCase()] ?? (isLifetime ? "functional preservation" : "treatment of the documented sequelae");
}

const CAUSAL: Record<string, string> = { RELATED: "incident-related", AGGRAVATION: "aggravated pre-existing condition", PREEXISTING_UNRELATED: "unrelated (pre-existing)", SUBSEQUENT_UNRELATED: "unrelated (subsequent)", UNCLEAR: "unclear" };

// ── CRE v1 §3 — condition definition ─────────────────────────────────────────

/** Laterality stated in a text ("right knee", "left L4-5", "bilateral"). */
export function lateralityOf(text: string): "left" | "right" | "bilateral" | "n/a" {
  const t = text.toLowerCase();
  if (/\bbilateral\b|\bboth (knees|hips|shoulders|wrists|ankles|eyes|ears|legs|arms)\b/.test(t)) return "bilateral";
  const left = /\bleft\b|\bl(?:t)?\.\s/.test(t);
  const right = /\bright\b|\br(?:t)?\.\s/.test(t);
  if (left && right) return "bilateral";
  if (left) return "left";
  if (right) return "right";
  return "n/a";
}

function severityOf(condition: DossierCondition | null): string {
  const quotes = Array.isArray(condition?.evidenceSources) ? (condition!.evidenceSources as { quote?: string }[]).map((e) => e?.quote ?? "").join(" ") : "";
  const hay = `${condition?.name ?? ""} ${condition?.objectiveEvidence ?? ""} ${quotes}`.toLowerCase();
  if (/end-?stage|bone-on-bone|complete (tear|rupture)|severe|grade (iv|4)|high-grade/.test(hay)) return "severe";
  if (/moderate|grade (iii|3)|partial (tear|rupture)/.test(hay)) return "moderate";
  if (/mild|grade (i{1,2}|[12])\b|low-grade|minimal/.test(hay)) return "mild";
  return "undetermined";
}

// Chronicity derives ONLY from independent condition evidence (documented
// diagnosis/prognosis language) — NEVER from the projection horizon. An item
// being projected over the lifetime (`isLifetime`) says nothing about whether
// the condition is chronic; insufficient evidence yields "undetermined".
function chronicityOf(condition: DossierCondition | null): string {
  const hay = `${condition?.name ?? ""} ${condition?.reasoning ?? ""}`.toLowerCase();
  if (/chronic|degenerat|arthrit|post-?traumatic|permanent/.test(hay)) return "chronic";
  if (/subacute/.test(hay)) return "subacute";
  if (/acute|initial encounter|fracture\b/.test(hay)) return "acute";
  return "undetermined";
}

function clinicalStatusOf(condition: DossierCondition | null, priorTreatmentCount: number): string {
  const opp = (condition?.opposingRecords ?? "").toLowerCase();
  if (/resolved|full recovery|returned to baseline/.test(opp)) return "resolved";
  if (priorTreatmentCount > 0) return "under active treatment";
  if (condition) return "surveillance";
  return "undetermined";
}

// ── CRE v1 §4 — epistemically classified evidence items ─────────────────────
// Symptoms/patient reports are never labeled objective; physician approval is
// never treating-record support; literature is never patient-specific evidence.
type Bucketed = { text: string; source?: string | null };
function classifyBucket(items: Bucketed[], category: EvidenceCategory, objective: boolean, epistemic: EpistemicStatus): ClassifiedEvidenceItem[] {
  return items.map((e) => {
    const page = e.source ? Number(/p\.\s*(\d+)/.exec(e.source)?.[1] ?? NaN) : NaN;
    const date = e.source ? (/\b(\d{4}-\d{2}-\d{2})\b/.exec(e.source)?.[1] ?? null) : null;
    const provider = e.source ? (/·\s*([^·(]+?)\s*(?:\(|$)/.exec(e.source)?.[1]?.trim() ?? null) : null;
    return { category, text: e.text, source: e.source ?? null, page: Number.isNaN(page) ? null : page, date, provider, objective, epistemic };
  });
}

// ── CRE v1 §5 — necessity extensions ─────────────────────────────────────────
function leastIntensiveOf(item: ReasoningItem, priorTreatmentCount: number, pathway: string, documentedNonResolution = false): string {
  if (item.lowerCostAlternative) return `A lower-intensity option (${lc(item.lowerCostAlternative)}) is documented as the alternative; ${lc(item.service)} is recommended because the documented clinical basis supports it, and only one of the two belongs in totals.`;
  if (/surgical|revision/.test(pathway)) {
    // Prior treatment EXISTING is not prior treatment FAILING. The record has
    // to say the impairment persisted, the course was completed, or the
    // options were exhausted — otherwise this asserted non-resolution from a
    // count of treatments.
    if (documentedNonResolution) return "Lower-intensity care is documented and the record states the impairment persisted; escalation along the treatment continuum is the clinically expected next step rather than a first resort.";
    if (priorTreatmentCount > 0) return "Lower-intensity care is documented, but the record does not state whether it resolved the impairment. Escalation to surgical care needs that response documented before it can be called the expected next step.";
    return "Surgical care is proposed without documented exhaustion of conservative care — the record should establish why lower-intensity options are not adequate.";
  }
  if (/conservative/.test(pathway)) return "This is itself the lower-intensity option on the treatment continuum — preferable to interventional or surgical escalation while it maintains function.";
  return "No treatment would leave the documented impairment unaddressed; this recommendation is the least-intensive documented means of addressing it.";
}

function timingOf(item: ReasoningItem): string {
  if (item.startTrigger) return `Begins when the documented trigger is met: ${lc(item.startTrigger)}.`;
  if (item.isLifetime) return "Begins from the date of the plan and continues across the projection horizon.";
  if ((item.durationYears ?? 0) === 0) return "A single occurrence anticipated within the projection horizon.";
  return "Begins from the date of the plan for the stated course.";
}

// ── CRE v1 §12 — recommendation-specific literature re-filter ───────────────
// Applicability outranks hierarchy: an article must be compatible with THIS
// recommendation (region, procedure family, scope, population) or it is
// rejected with a stated reason — keyword overlap alone never qualifies.
export function filterLiterature(
  literature: LiteratureAssessment[],
  ctx: { service: string; diagnosis: string; adult: boolean },
): { accepted: LiteratureAssessment[]; rejected: RejectedCitation[] } {
  const accepted: LiteratureAssessment[] = [];
  const rejected: RejectedCitation[] = [];
  for (const l of literature) {
    const gate = citationCompatible({ title: l.title }, { service: ctx.service, diagnosis: ctx.diagnosis, adult: ctx.adult });
    if (gate.compatible) accepted.push(l);
    else rejected.push({ title: l.title, pmid: l.pmid, reason: gate.reason });
  }
  return { accepted, rejected };
}

// §8 — where a recommendation sits on the treatment continuum.
const PATHWAY: Partial<Record<string, string>> = {
  PHYSICAL_THERAPY: "conservative management", OCCUPATIONAL_THERAPY: "conservative management", SPEECH_THERAPY: "conservative management", PMR: "conservative management", COGNITIVE_THERAPY: "conservative management",
  PAIN_MANAGEMENT: "interventional pain management", INJECTION: "interventional pain management", MEDICATION: "conservative management",
  IMAGING: "surveillance", LABS: "surveillance", PHYSICIAN_VISIT: "surveillance", SPECIALIST_VISIT: "surveillance", PRIMARY_CARE: "surveillance", NEUROLOGY: "surveillance",
  ORTHOPEDIC_SURGERY: "definitive surgical", NEUROSURGERY: "definitive surgical", FUTURE_SURGERY: "definitive surgical",
  REVISION_SURGERY: "revision / post-surgical",
  DME: "functional support", MOBILITY_AID: "functional support", HOME_MODIFICATION: "functional support", ORTHOTICS_PROSTHETICS: "functional support",
  ATTENDANT_CARE: "supportive care", SKILLED_NURSING: "supportive care", COMPLICATION_MANAGEMENT: "complication management", PSYCH: "behavioral health",
};
function pathwayOf(item: ReasoningItem): string {
  const base = PATHWAY[(item.category ?? "").toUpperCase()] ?? "individualized plan";
  return item.startTrigger || item.contingencyOnly ? `contingent ${base}` : base;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Cross-recommendation coherence (§9, Phase B). Detects duplicates, staged
 * replacement chains (A `replacesService` B), and a recommendation included in
 * totals alongside its own lower-cost alternative. Returns flags per item id
 * (or index when unsaved) plus which items are replaced by an active sibling.
 */
export function detectSetConflicts(items: ReasoningItem[]): { flags: Map<string, ConflictFlag[]>; replacedByActive: Set<string> } {
  const key = (it: ReasoningItem, i: number) => it.id ?? `#${i}`;
  const flags = new Map<string, ConflictFlag[]>();
  const replacedByActive = new Set<string>();
  const push = (k: string, f: ConflictFlag) => { const a = flags.get(k) ?? []; a.push(f); flags.set(k, a); };
  const active = (it: ReasoningItem) => !it.startTrigger && !it.contingencyOnly;

  items.forEach((a, i) => {
    const ka = key(a, i);
    items.forEach((b, j) => {
      if (i === j) return;
      const kb = key(b, j);
      // Duplicate: same service, both in the active plan.
      if (norm(a.service) === norm(b.service) && active(a) && active(b) && i < j) {
        push(ka, { type: "DUPLICATE", otherService: b.service, note: `Duplicated by another active line for "${b.service}"; only one should enter totals.` });
        push(kb, { type: "DUPLICATE", otherService: a.service, note: `Duplicates "${a.service}"; only one should enter totals.` });
      }
      // Staged replacement: A replaces B (A triggers, B becomes inactive).
      if (a.replacesService && norm(a.replacesService) === norm(b.service)) {
        push(ka, { type: "REPLACES", otherService: b.service, note: `If triggered, replaces "${b.service}" — hold as a staged alternative, not additive.` });
        push(kb, { type: "REPLACED_BY", otherService: a.service, note: `Superseded by "${a.service}" if its trigger is met.` });
        if (active(a)) replacedByActive.add(kb);
      }
      // Recommended option and its own lower-cost alternative both included.
      if (a.lowerCostAlternative && norm(a.lowerCostAlternative) === norm(b.service) && active(a) && active(b) && i < j) {
        push(ka, { type: "ALTERNATIVE_BOTH_INCLUDED", otherService: b.service, note: `Its lower-cost alternative "${b.service}" is also in totals — do not count both.` });
        push(kb, { type: "ALTERNATIVE_BOTH_INCLUDED", otherService: a.service, note: `Listed as the lower-cost alternative to "${a.service}"; counting both double-counts the need.` });
      }
    });
  });
  return { flags, replacedByActive };
}

function alternativesFor(item: ReasoningItem): { alternative: string; rationale: string }[] {
  if (!item.lowerCostAlternative) return [];
  return [{ alternative: item.lowerCostAlternative, rationale: `A lower-cost alternative (${item.lowerCostAlternative}) is on record. ${item.service} is recommended on the documented clinical basis; if the alternative is clinically acceptable for this patient it should be substituted, and only one belongs in totals.` }];
}

const EVIDENCE_LABEL: Record<number, string> = { 1: "clinical practice guideline", 2: "consensus statement", 3: "systematic review", 4: "meta-analysis", 5: "randomized controlled trial", 6: "prospective study", 7: "registry study", 8: "cohort study", 9: "case series", 10: "case report" };

// §15 (Phase C) — one honest paragraph on the body of published evidence.
function synthesizeLiterature(literature: LiteratureAssessment[], hasGuideline: boolean, service: string): string {
  if (!literature.length) {
    return hasGuideline
      ? `No individual published study was catalogued for ${lc(service)}; support rests on cited clinical guidance and the patient-specific record.`
      : `No accepted published literature was located for ${lc(service)} in this specific context; the recommendation rests on the patient-specific record rather than external evidence.`;
  }
  const best = Math.min(...literature.map((l) => l.evidenceLevel));
  const onPoint = literature.filter((l) => !/tangential|unrelated|different (region|population)/i.test(l.applicability ?? ""));
  const limits = literature.map((l) => l.limitations).filter(Boolean) as string[];
  const parts = [
    `The recommendation is supported by ${literature.length} citation${literature.length > 1 ? "s" : ""}, the strongest a ${EVIDENCE_LABEL[best] ?? "clinical study"}.`,
    onPoint.length ? `${onPoint.length === literature.length ? "Each" : `${onPoint.length} of ${literature.length}`} directly addresses this diagnosis-and-intervention pairing.` : "Applicability to this specific pairing is partial.",
  ];
  if (limits.length) parts.push(`Noted limitation${limits.length > 1 ? "s" : ""}: ${limits.slice(0, 2).join("; ")}.`);
  return parts.join(" ");
}

// §9 (CRE v1) — the honest counter-analysis, as structured items with
// materiality, source, and effect flags. Adverse evidence is never hidden and
// nothing is manufactured for a well-supported line.
function deriveWeakening(
  base: string[],
  ctx: { objectiveCount: number; physicianApproved: boolean; frequencySupported: boolean; durationClass: DurationClass; lifetimeClinicallySupported: boolean; weakPrimary: boolean; matched: boolean; lateralityMismatch: boolean; region: string; service: string; contradictorySource?: string | null },
): WeakeningItem[] {
  const out: WeakeningItem[] = base.map((detail) => ({
    claim: "the supporting record", detail, source: ctx.contradictorySource ?? "case record", page: null,
    materiality: /improv|resolved|normal/i.test(detail) ? "HIGH" : "MODERATE", reducesConfidence: true, changesInclusion: false, requiresReview: true,
  }));
  const add = (w: WeakeningItem) => { if (!out.some((x) => x.detail.toLowerCase() === w.detail.toLowerCase())) out.push(w); };
  if (!ctx.matched) add({ claim: "diagnosis linkage", detail: "No diagnosis in the relevant body region maps to this recommendation.", source: null, page: null, materiality: "HIGH", reducesConfidence: true, changesInclusion: true, requiresReview: true });
  if (ctx.lateralityMismatch) add({ claim: "anatomic laterality", detail: `The recommendation and its supporting diagnosis state different sides for the ${ctx.region}.`, source: null, page: null, materiality: "HIGH", reducesConfidence: true, changesInclusion: true, requiresReview: true });
  if (ctx.objectiveCount === 0) add({ claim: "objective basis", detail: `No independent objective finding is documented for the ${ctx.region} in the current record.`, source: null, page: null, materiality: "HIGH", reducesConfidence: true, changesInclusion: true, requiresReview: true });
  if (!ctx.physicianApproved) add({ claim: "treating-record support", detail: "Not yet confirmed or signed off by the treating physician.", source: null, page: null, materiality: "MODERATE", reducesConfidence: true, changesInclusion: false, requiresReview: true });
  if (!ctx.frequencySupported) add({ claim: "frequency", detail: "The stated frequency is assumed rather than grounded in a documented cadence.", source: null, page: null, materiality: "MODERATE", reducesConfidence: true, changesInclusion: false, requiresReview: true });
  if (ctx.durationClass === "LIFETIME" && !ctx.lifetimeClinicallySupported) add({ claim: "duration", detail: "The remaining-lifetime projection lacks independent clinical duration support and is carried as a projection assumption.", source: null, page: null, materiality: "HIGH", reducesConfidence: true, changesInclusion: false, requiresReview: true });
  if (ctx.weakPrimary) add({ claim: "published support", detail: "The strongest available citation is only a case series or case report.", source: null, page: null, materiality: "LOW", reducesConfidence: true, changesInclusion: false, requiresReview: false });
  return out;
}

// §10 (CRE v1) — precise unknowns: what is missing, why it matters, where it
// would come from, and what to do — never "progression is uncertain".
function deriveUnknowns(
  base: string[],
  ctx: { objectiveCount: number; physicianApproved: boolean; frequencySupported: boolean; region: string; service: string; isSurgical: boolean; isImagingRec: boolean },
): UnknownItem[] {
  const out: UnknownItem[] = base
    .map((s) => s.trim()).filter(Boolean)
    .map((missing) => ({ missing, whyItMatters: "It bears directly on whether this recommendation is supportable as stated.", likelySource: "treating records or updated studies", severity: "MODERATE" as const, blocksInclusion: false, reducesConfidence: true, suggestedAction: "Request the identified records or studies." }));
  const add = (u: UnknownItem) => { if (!out.some((x) => x.missing.toLowerCase() === u.missing.toLowerCase())) out.push(u); };
  if (ctx.objectiveCount === 0) add({
    missing: `No current objective study (imaging or examination) documents the ${ctx.region}.`,
    whyItMatters: `Without an objective finding, the need for ${lc(ctx.service)} rests on report alone and cannot be confirmed.`,
    likelySource: "updated imaging or a documented physical examination", severity: "HIGH", blocksInclusion: true, reducesConfidence: true,
    suggestedAction: `Obtain current imaging or an examination of the ${ctx.region}.`,
  });
  if (!ctx.physicianApproved) add({
    missing: "No treating-physician review of this recommendation is on file.",
    whyItMatters: "A recommendation carries materially more weight once the treating physician has reviewed and endorsed it.",
    likelySource: "the reviewing physician", severity: "MODERATE", blocksInclusion: false, reducesConfidence: true,
    suggestedAction: "Route the recommendation for physician review.",
  });
  if (!ctx.frequencySupported) add({
    missing: "No documented treatment cadence, guideline, or review supports the stated frequency.",
    whyItMatters: "An assumed frequency multiplies directly into the cost totals and is the first target of a challenge.",
    likelySource: "treatment records showing the actual visit cadence, or applicable clinical guidance", severity: "HIGH", blocksInclusion: false, reducesConfidence: true,
    suggestedAction: "Document the cadence supporting the stated frequency, or obtain physician confirmation.",
  });
  return out.slice(0, 6);
}

// Plain-language summary of what remains unknown and what would move the needle.
function residualUncertaintyOf(confidence: RecommendationConfidence, factors: string[], missing: string[]): string {
  const lead = confidence === "HIGH" ? "Little material uncertainty remains." : confidence === "MODERATE" ? "Some uncertainty remains." : confidence === "LOW" ? "Substantial uncertainty remains." : "The recommendation cannot yet be assessed with confidence.";
  const weak = factors.filter((f) => /^no |awaiting|contradictory|open missing|single source/i.test(f));
  const because = weak.length ? ` Chiefly driven by: ${weak.slice(0, 2).join("; ")}.` : "";
  const next = missing.length ? ` It would strengthen most with: ${missing[0].replace(/\.$/, "")}.` : "";
  return `${lead}${because}${next}`;
}

function evidenceStrengthFrom(bestLevel: number | null, hasGuideline: boolean): EvidenceStrength {
  if (bestLevel != null && bestLevel <= 2) return "EXPERT_CONSENSUS"; // guideline / consensus statement
  if (bestLevel != null && bestLevel <= 5) return "STRONG"; // systematic review / meta-analysis / RCT
  if (bestLevel != null && bestLevel <= 8) return "MODERATE"; // prospective / registry / cohort
  if (bestLevel != null) return "LIMITED"; // case series / report
  if (hasGuideline) return "EXPERT_CONSENSUS";
  return "INSUFFICIENT";
}
function mapConfidence(level: string): RecommendationConfidence {
  if (level === "Very High" || level === "High") return "HIGH";
  if (level === "Moderate") return "MODERATE";
  if (level === "Low") return "LOW";
  return "INDETERMINATE";
}

function durationOf(item: ReasoningItem, durationSupport: LifetimeSupportResult): { durationClass: DurationClass; durationRationale: string } {
  const svc = item.service.toLowerCase();
  if (item.startTrigger || item.contingencyOnly) {
    if (/surgery|arthroplasty|fusion|replacement|revision/.test(svc)) return { durationClass: "UNTIL_SURGERY", durationRationale: `Conditional: this care applies only if ${lc(item.startTrigger ?? "the trigger criteria")} — it is not open-ended.` };
    return { durationClass: "CONDITIONAL", durationRationale: `Conditional on ${lc(item.startTrigger ?? "a documented trigger")}; excluded from finalized totals until the trigger is met.` };
  }
  if (item.isLifetime) {
    // The lifetime horizon is a PROJECTION choice. The rationale states the
    // independent clinical basis when one exists, and otherwise discloses the
    // scenario honestly as an assumption — it never claims the condition is
    // chronic or progressive merely because the projection is lifetime.
    return {
      durationClass: "LIFETIME",
      durationRationale: durationSupport.clinicallySupported
        ? `The remaining-lifetime projection is based on ${describeLifetimeBasis(durationSupport)}; it applies the stated frequency over the remaining life-expectancy horizon.`
        : "A remaining-lifetime scenario is shown as a projection assumption; the clinical duration remains pending support. The lifetime scenario is disclosed for review and is not itself evidence of permanence.",
    };
  }
  const yrs = item.durationYears ?? 0;
  if (yrs === 0) return { durationClass: "ONE_TIME", durationRationale: "A one-time service; no recurring course is anticipated." };
  if (yrs <= 1) return { durationClass: "SHORT_TERM", durationRationale: `A short, defined course (~${yrs} year) tied to the current recovery phase.` };
  if (/therapy|injection/.test(svc)) return { durationClass: "EPISODIC", durationRationale: `Episodic over ~${yrs} years, used during symptomatic flares rather than continuously.` };
  return { durationClass: "MULTI_YEAR", durationRationale: `A multi-year course (~${yrs} years) reflecting the expected treatment horizon for this condition.` };
}


// Standalone sufficiency pre-check used by the lifecycle gate (computed before
// the full sufficiency object to keep derivation order stable).
function evidenceSufficiencyStandalone(objectiveCount: number, se: { imaging: { text: string }[]; examination: { text: string }[]; physicianDocumentation: { text: string }[] }, physicianApproved: boolean): boolean {
  let score = Math.min(30, objectiveCount * 10) + (se.imaging.length ? 15 : 0) + (se.examination.length ? 10 : 0) + (se.physicianDocumentation.length || physicianApproved ? 15 : 0);
  return score >= 25; // conservative pre-gate; the persisted object carries the full verdict
}

// ── Reasoning Reliability builders (pure, deterministic) ─────────────────────

/** Phase 2 — is there ENOUGH evidence, and if not, exactly what is missing? */
export function assessEvidenceSufficiency(input: {
  objectiveCount: number; imaging: boolean; exam: boolean; recordSources: number;
  providerDoc: boolean; chronologyEvents: number; conflicts: number; region: string;
  threshold?: number;
}): EvidenceSufficiency {
  const threshold = input.threshold ?? SUFFICIENCY_THRESHOLD;
  let score = 0;
  score += Math.min(30, input.objectiveCount * 10);
  score += input.imaging ? 15 : 0;
  score += input.exam ? 10 : 0;
  score += Math.min(20, input.recordSources * 10);
  score += input.providerDoc ? 15 : 0;
  score += input.chronologyEvents > 0 ? 10 : 0;
  score -= Math.min(20, input.conflicts * 10);
  score = Math.max(0, Math.min(100, score));
  const missing: string[] = [];
  if (input.objectiveCount === 0) missing.push(`No independent objective finding for the ${input.region}.`);
  if (!input.imaging) missing.push(`No imaging study of the ${input.region} on file.`);
  if (!input.exam) missing.push("No documented physical examination findings.");
  if (input.recordSources === 0) missing.push("No page-cited record sources on the mapped diagnosis.");
  if (!input.providerDoc) missing.push("No treating-provider documentation or review on file.");
  if (input.chronologyEvents === 0) missing.push(`No chronology events involving the ${input.region}.`);
  const sufficient = score >= threshold;
  return {
    objectiveFindings: input.objectiveCount, imagingSupport: input.imaging, examSupport: input.exam,
    recordSupport: input.recordSources, providerConsensus: input.providerDoc,
    chronologyConsistency: input.chronologyEvents > 0, conflictingEvidence: input.conflicts,
    score, sufficient, threshold, missing,
    explanation: sufficient
      ? `Evidence score ${score}/${threshold} required — sufficient to support a recommendation.`
      : `Insufficient supporting evidence (score ${score}, threshold ${threshold}). Missing: ${missing.slice(0, 3).join(" ")}`,
  };
}

/** Phase 6 — the immutable reasoning chain: each node cites its source and
 *  declares its basis; each edge (rationale) explains WHY the next step
 *  follows. Absent steps are recorded as null content, never invented. */
export function buildChainNodes(a: {
  service: string; diagnosis: string | null; region: string;
  subjective: string | null; objective: string | null; imaging: string | null; exam: string | null;
  functional: string | null; priorTreatment: string | null; response: string | null;
  necessity: boolean; pv: number | null; physicianStatus: string; sources: number; conservativeExhausted: boolean;
}): ChainNode[] {
  const src = a.sources > 0 ? `${a.sources} page-cited record source${a.sources === 1 ? "" : "s"}` : null;
  return [
    { stage: "Complaint / symptoms", content: a.subjective, source: a.subjective ? "patient-reported, per record" : null, basis: "documented_fact", rationale: "The clinical course begins with the documented presenting complaints." },
    { stage: "Objective findings", content: a.objective, source: src, basis: "documented_fact", rationale: "Independent findings corroborate (or fail to corroborate) the reported symptoms." },
    { stage: "Imaging", content: a.imaging, source: src, basis: "documented_fact", rationale: "Imaging localizes the pathology to the region at issue." },
    { stage: "Physical examination", content: a.exam, source: src, basis: "documented_fact", rationale: "Examination findings connect the pathology to clinical signs." },
    { stage: "Diagnosis", content: a.diagnosis, source: a.diagnosis ? "case causation map" : null, basis: a.diagnosis ? "documented_fact" : "inference", rationale: a.diagnosis ? `The findings above support the mapped diagnosis in the ${a.region}.` : "No diagnosis in the relevant region maps to this recommendation." },
    { stage: "Functional impairment", content: a.functional, source: a.functional ? "record / interview" : null, basis: a.functional ? "documented_fact" : "assumption", rationale: "The diagnosis matters clinically because of its documented effect on function." },
    { stage: "Prior treatment & response", content: a.priorTreatment, source: src, basis: a.priorTreatment ? "documented_fact" : "assumption", rationale: a.response ?? "Prior treatment and its response calibrate what future care is reasonable." },
    { stage: "Failed conservative care", content: a.conservativeExhausted ? "Documented conservative care has not resolved the impairment" : null, basis: a.conservativeExhausted ? "documented_fact" : "assumption", source: a.conservativeExhausted ? src : null, rationale: "Escalation is justified only after lower-intensity care is documented as insufficient." },
    { stage: "Medical necessity", content: a.necessity ? "Structured necessity rationale assessed" : null, source: "reasoning assessment", basis: "inference", rationale: "Necessity is synthesized from the documented chain above — an engine inference, not a documented fact." },
    { stage: "Recommendation", content: a.service, source: "care plan", basis: "inference", rationale: "The recommendation follows from necessity; it remains subject to physician authority." },
    { stage: "Cost", content: a.pv != null ? `Present value ${Math.round(a.pv).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}` : null, source: "cost engine", basis: "workflow", rationale: "Cost attaches only to a supportable recommendation, never the reverse." },
    { stage: "Physician review", content: a.physicianStatus === "PENDING" ? null : a.physicianStatus.toLowerCase(), source: a.physicianStatus === "PENDING" ? null : "review ledger", basis: "workflow", rationale: "The physician's decision is the final authority over the chain." },
  ];
}

/** Phase 4 — the engine critiques itself before physician review. */
export function buildSelfCritique(a: {
  service: string; diagnosis: string | null; weakening: WeakeningItem[]; unknowns: UnknownItem[];
  lowerCostAlternative: string | null; frequencySupported: boolean; isLifetime: boolean;
  lifetimeClinicallySupported: boolean; evidenceItems: ClassifiedEvidenceItem[]; necessity: string;
}): SelfCritique {
  const assumptions: string[] = [];
  if (!a.frequencySupported) assumptions.push("The stated frequency assumes a treatment cadence that is not documented.");
  if (a.isLifetime && !a.lifetimeClinicallySupported) assumptions.push("The remaining-lifetime horizon is a projection assumption; the clinical duration is not independently established.");
  const inferred = a.evidenceItems.filter((e) => e.epistemic !== "documented_fact").map((e) => `${e.category.replace(/_/g, " ")}: ${e.text.slice(0, 70)} (${e.epistemic.replace(/_/g, " ")})`);
  return {
    whyRecommended: a.necessity.slice(0, 300),
    whyPossiblyWrong: a.weakening.filter((w) => w.materiality !== "LOW").map((w) => w.detail).slice(0, 4),
    evidenceAgainst: a.weakening.filter((w) => w.source && w.source !== "case record").map((w) => `${w.detail} (${w.source})`).slice(0, 3),
    recordsThatWouldChangeConfidence: a.unknowns.map((u) => u.suggestedAction).slice(0, 4),
    alternativeRecommendation: a.lowerCostAlternative,
    assumptions,
    inferredNotDocumented: inferred.slice(0, 5),
  };
}

/** Phase 7 — ten independent confidence dimensions. Displayed independently;
 *  never collapsed into one number. */
export function buildConfidenceVector(a: {
  sufficiency: EvidenceSufficiency; bestLiteratureLevel: number | null; guideline: boolean;
  providerDoc: boolean; weakeningCount: number; unknownsBlocking: boolean; physicianStatus: string;
  necessityComplete: boolean; confidenceScore: number;
}): ConfidenceVector {
  const cap = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  return {
    clinicalCertainty: cap(a.confidenceScore),
    evidenceQuality: cap(a.sufficiency.score),
    objectiveEvidence: cap(a.sufficiency.objectiveFindings * 25 + (a.sufficiency.imagingSupport ? 25 : 0)),
    literatureSupport: cap(a.bestLiteratureLevel == null ? 0 : (11 - a.bestLiteratureLevel) * 10),
    guidelineSupport: a.guideline ? 100 : 0,
    providerAgreement: a.providerDoc ? 100 : 0,
    chronologyConsistency: a.sufficiency.chronologyConsistency ? 100 : 0,
    medicalNecessity: a.necessityComplete ? cap(60 + a.sufficiency.score * 0.4) : 30,
    contradictoryEvidence: cap(a.weakeningCount * 20),
    physicianReview: a.physicianStatus === "APPROVED" || a.physicianStatus === "MODIFIED" ? 100 : a.physicianStatus === "REJECTED" ? 0 : 50,
  };
}

/** Phase 3 — competing diagnoses / alternative explanations, drawn ONLY from
 *  the case's own causation map and pre-existing history (never invented). */
export function deriveAlternativeExplanations(
  region: string,
  mappedId: string | null,
  conditions: { id: string; name: string; relatedness?: string }[],
): AlternativeExplanation[] {
  return conditions
    .filter((c) => c.id !== mappedId && bodyRegion(c.name) === region)
    .map((c) => ({
      name: c.name,
      relation: (c.relatedness ?? "UNCLEAR").replace(/_/g, " ").toLowerCase(),
      whyConsidered: `Same body region (${region.replace(/_/g, "/")}); ${
        c.relatedness === "PREEXISTING_UNRELATED" || c.relatedness === "SUBSEQUENT_UNRELATED"
          ? "an unrelated condition that could explain some or all of the symptoms attributed to the injury"
          : "a related condition that could account for overlapping symptoms"
      }.`,
    }))
    .slice(0, 4);
}

/** Build the structured reasoning assessment for one recommendation (pure). */
export function buildReasoningAssessment(
  item: ReasoningItem,
  conditions: (CondInput & DossierCondition & { id: string })[],
  chronology: DossierChronoEvent[],
  kase: DossierCase,
  interviews: DossierInterview[] = [],
  setContext: SetContext = { conflicts: [], replacedByActive: false },
  /**
   * Citations a person attached to THIS recommendation by hand.
   *
   * They are not derivable, so they are not in the dossier — and they are
   * unambiguously material: a physician who approved a recommendation and then
   * added the paper that answers it has changed what the recommendation rests
   * on. Passed in by the callers that hold them (the panel, the report, the
   * persistence pass); omitted, the assessment is exactly what it was.
   */
  handEnteredEvidence: readonly EvidenceRowIdentity[] = [],
  /**
   * The RECORDED basis for this item, or an explicit null.
   *
   * REQUIRED, and deliberately not defaulted: every caller must state its
   * answer. Production consumers pass the persisted basis so the panel, the
   * report and the persistence pass all reason from the same record; a caller
   * with no basis available says `null` and gets a derivation, which is a
   * decision rather than an oversight.
   *
   * This function stays PURE — it takes the basis, it does not fetch one. Given
   * a database dependency it would stop running identically on the server and
   * in the browser, which is the property the whole engine is built on.
   */
  recordedBasis: BasisRecord | null,
): ReasoningAssessment {
  const rec = item as unknown as RecInput;
  const mapping = mapRecommendationToCondition(rec, conditions);
  const resolved = resolveRecommendationCondition(item, conditions);
  const condition = resolved.condition;
  const dossier = buildRecommendationDossier(item, condition, chronology, kase, interviews);
  const code = validateCode(rec);
  const pricing = validatePricing(rec);
  // The item's OWN classification. This read the matched CONDITION's records,
  // and failing that `confidence >= 60` — so a template's default confidence of
  // 75 could establish "record support" for a service nothing in the file
  // mentions.
  const itemSupportClass = supportClassOf(item as { supportClass?: string | null });
  const recordSupport = entersSupportedTotal(itemSupportClass);
  const codeCritical = code.status === "Code mismatch" || pricing.status === "Pricing mismatch";
  const classify = classifyRecommendation(rec, { matched: mapping.matched, codeCritical, supportClass: itemSupportClass });

  const lens = specialtyLens(item.category, item.service);
  const region = bodyRegion(`${item.service} ${condition?.name ?? ""}`);
  const staged = !!item.contingencyOnly || !!item.startTrigger;

  // CRE v1 §3 — condition definition: laterality (with mismatch detection),
  // severity, chronicity, and current clinical status.
  const recLaterality = lateralityOf(item.service);
  const dxLaterality = lateralityOf(condition?.name ?? "");
  const lateralityMismatch = recLaterality !== "n/a" && dxLaterality !== "n/a" && recLaterality !== dxLaterality && dxLaterality !== "bilateral" && recLaterality !== "bilateral";
  const laterality = recLaterality !== "n/a" ? recLaterality : dxLaterality;

  // §7 probability classification.
  let probabilityClassification: ProbabilityClassification;
  if (item.physicianStatus === "REJECTED") probabilityClassification = "REJECTED_BY_REVIEWER";
  else if (staged) probabilityClassification = "CONDITIONAL_STAGED";
  else if (classify.status === "SUPPORTED_INCLUDED" || classify.status === "RECORD_SUPPORTED_PENDING") probabilityClassification = "PROBABLE_INCLUDED";
  else if (classify.status === "POSSIBLE_CONTINGENCY" || classify.status === "SPECULATIVE") probabilityClassification = "POSSIBLE_CONTINGENCY_NOT_INCLUDED";
  else probabilityClassification = (item.probability ?? "POSSIBLE") === "NOT_SUPPORTED" ? "NOT_RECOMMENDED" : "INSUFFICIENTLY_SUPPORTED";

  const se = dossier.supportingEvidence;
  const sum = (arr: { text: string }[], n = 2) => (arr.length ? arr.slice(0, n).map((e) => e.text).join("; ") : null);
  const subjectiveItems = se.functionalLimitations.filter((e) => /patient reports/i.test(e.text));
  const objectiveItems = [...se.objectiveFindings, ...se.imaging, ...se.examination];

  // §10 frequency support.
  const physicianApproved = item.physicianStatus === "APPROVED" || item.physicianStatus === "MODIFIED";
  // ── §11 frequency — a CADENCE must be documented, not merely treatment ────
  // This read "any prior treatment OR any guideline OR approval". Existence of
  // treatment says a patient was treated; it says nothing about how often
  // future care is needed, and a guideline silent on cadence cannot establish
  // one. Both were letting an assumed frequency present as grounded.
  const statesCadence = (text: string): boolean =>
    /\b(?:\d+\s*(?:×|x|times)?\s*(?:per|a|each)\s*(?:day|week|month|year)|weekly|twice weekly|thrice weekly|biweekly|fortnightly|monthly|quarterly|annually|yearly|every\s+\d+\s+(?:day|week|month|year)s?|q\d+ ?(?:h|d|w|m)\b)/i.test(text);
  // …and the stated cadence must belong to THIS service. A record reading
  // "chiropractic three times weekly" states a cadence; it does not ground the
  // frequency of an injection series, and matching on cadence alone let one
  // service's documented rate justify another's assumed one. The comparison is
  // by service KIND, the same coarse vocabulary the evidence ledger uses, and
  // it fails closed: an entry whose kind cannot be identified is not a match.
  const itemKind = serviceKindOf(item);
  const namesThisService = (text: string): boolean => {
    const kind = serviceKindOf({ service: text, category: null });
    return kind !== "OTHER" && kind === itemKind;
  };
  const cadenceFromTreatment = se.priorTreatment.filter((e) => statesCadence(e.text) && namesThisService(e.text));
  const cadenceFromGuideline = se.guidelines.filter((g) => statesCadence(`${g.text} ${g.source ?? ""}`));
  const frequencySupported = cadenceFromTreatment.length > 0 || cadenceFromGuideline.length > 0 || physicianApproved;

  // Did the record actually state a RESPONSE — persistence, failure, or a
  // completed/exhausted course? Nothing downstream may say conservative care
  // "has not resolved the impairment" without one of these.
  // Examination is included deliberately: a deficit still present on exam is
  // the most direct statement that earlier care did not resolve it.
  // One shared definition — see assertionClassifier. This file carried its own
  // regex, medicalNecessity carried another, and they could drift.
  const documentedNonResolution = documentsNonResolution([...se.priorTreatment, ...se.examination, ...se.functionalLimitations, ...se.physicianDocumentation]);
  const freqN = item.frequencyPerYear ?? 1;
  const frequencyRationale = frequencySupported
    ? `The ${freqN}×/yr frequency is grounded in ${[cadenceFromTreatment.length ? "a cadence stated in the treatment record" : "", cadenceFromGuideline.length ? "a cadence stated in the cited guidance" : "", physicianApproved ? "physician review" : ""].filter(Boolean).join(", ")}.`
    : `The ${freqN}×/yr frequency is an assumption not yet grounded in a documented cadence, guideline, or physician review; it is pending review and should not enter finalized totals until supported.`;

  // §11 duration — ONE deterministic duration-support verdict. Replaces the old
  // ad-hoc inference (guideline OR any objective finding OR approval) that let a
  // generic MRI or a bare approval flag pass as lifetime-duration evidence.
  const durationSupport = assessLifetimeSupport({
    isLifetime: !!item.isLifetime,
    condition,
    // The dossier's guideline bucket: diagnosis/anatomy-gated, each entry
    // carrying its structured duration claim only when the guidance text (or
    // explicit source metadata) actually speaks to duration.
    guidelineEvidence: se.guidelines,
    service: item.service,
    providerOpinions: se.physicianDocumentation
      .filter((e) => e.source === "provider interview")
      .map((e) => ({ text: e.text })),
    physicianNote: item.physicianNote ?? null,
    physicianStatus: item.physicianStatus ?? null,
    objectiveFindingCount: objectiveItems.length,
  });
  const { durationClass, durationRationale } = durationOf(item, durationSupport);

  // CRE v1 §12 — the literature ledger. The dossier already gates citations
  // through the hard compatibility filter, so its output is the ACCEPTED set;
  // the ledger of REJECTED citations is computed from the item's raw stored
  // citations so every exclusion is auditable with its reason.
  const dossierLit = dossier.literature.map((l) => ({ title: l.title, pmid: l.pmid, supports: l.supports, applicability: l.applicability, evidenceLevel: l.evidenceLevel, limitations: l.limitations }));
  const { accepted: literatureAssessments } = filterLiterature(dossierLit, { service: item.service, diagnosis: condition?.name ?? item.service, adult: kase.adult !== false });
  const rawCitations = (Array.isArray(item.citation) ? item.citation : item.citation ? [item.citation] : []) as { title?: string; pmid?: string }[];
  const rejectedLiterature: RejectedCitation[] = rawCitations
    .filter((cc): cc is { title: string; pmid?: string } => !!cc.title)
    .map((cc) => ({ cc, gate: citationCompatible({ title: cc.title }, { service: item.service, diagnosis: condition?.name ?? item.service, adult: kase.adult !== false }) }))
    .filter(({ gate }) => !gate.compatible) // only genuine incompatibility — not mere non-selection as primary
    .map(({ cc, gate }) => ({ title: cc.title, pmid: cc.pmid, reason: gate.reason }));

  const bestLevel = literatureAssessments.length ? Math.min(...literatureAssessments.map((l) => l.evidenceLevel)) : null;
  const evidenceStrength = evidenceStrengthFrom(bestLevel, se.guidelines.length > 0);
  const recommendationConfidence = mapConfidence(dossier.confidence.level);

  // §9/§10 inclusion. Precedence: replaced-by-an-active-sibling → staged/contingent
  // → supported-and-included → excluded. A staged item is disclosed but never
  // entered into totals regardless of how well supported.
  const alternativeDoubleCount = setContext.conflicts.some((c) => c.type === "ALTERNATIVE_BOTH_INCLUDED");
  let inclusionInTotalsStatus: "included" | "excluded" | "contingency";
  let inclusionRationale: string;
  if (setContext.replacedByActive) { inclusionInTotalsStatus = "excluded"; inclusionRationale = "Excluded from totals: an active recommendation replaces this line, so counting it would double the cost."; }
  else if (staged) { inclusionInTotalsStatus = "contingency"; inclusionRationale = "Disclosed as a contingency, not entered into totals: it applies only if its trigger is met."; }
  else if (classify.includedInTotal) { inclusionInTotalsStatus = "included"; inclusionRationale = alternativeDoubleCount ? "Included, but a lower-cost alternative is also listed — only one belongs in totals; reconcile before finalizing." : "Included in totals: probable, supported, and cost-coherent."; }
  else { inclusionInTotalsStatus = "excluded"; inclusionRationale = "Excluded from totals: support is insufficient for a probable, defensible cost line at this time."; }
  const costEligibilityStatus = codeCritical ? "Coding/pricing inconsistency must be resolved before inclusion." : pricing.status === "Unsupported bundled estimate" ? "Bundled estimate — attach a code or disclose the bundled basis." : "Cost basis is coherent for inclusion.";
  const validationStatus: "ok" | "blocking" | "pending" = !mapping.matched || codeCritical ? "blocking" : physicianApproved || frequencySupported ? "ok" : "pending";

  // Trajectory derives ONLY from documented condition evidence — never from the
  // projection horizon. No manufactured progression: absent documented
  // progressive/degenerative language, the honest value is "undetermined".
  const condHay = `${condition?.name ?? ""} ${condition?.objectiveEvidence ?? ""} ${condition?.reasoning ?? ""}`.toLowerCase();
  const trajectory =
    condition?.opposingRecords && /improv/i.test(condition.opposingRecords)
      ? "improving"
      : /degenerat|progressiv|end-?stage/.test(condHay)
        ? "chronic, stable-to-worsening (per documented condition evidence)"
        : "undetermined";
  const weakPrimary = bestLevel != null && bestLevel >= 9;
  const isSurgicalRec = /surgical|revision/.test(pathwayOf(item));
  const weakeningEvidence = deriveWeakening(dossier.contradictoryEvidence, { objectiveCount: objectiveItems.length, physicianApproved, frequencySupported, durationClass, lifetimeClinicallySupported: durationSupport.clinicallySupported, weakPrimary, matched: mapping.matched, lateralityMismatch, region, service: item.service });
  const unknowns = deriveUnknowns([condition?.missingInfo ?? "", item.missingSupport ?? "", ...dossier.unknowns], { objectiveCount: objectiveItems.length, physicianApproved, frequencySupported, region, service: item.service, isSurgical: isSurgicalRec, isImagingRec: (item.category ?? "") === "IMAGING" });
  const missing = unknowns.map((u) => u.suggestedAction);
  const literatureSynthesis = synthesizeLiterature(literatureAssessments, se.guidelines.length > 0, item.service);
  const residualUncertainty = residualUncertaintyOf(recommendationConfidence, dossier.confidence.factors, missing);

  // CRE v1 §4 — itemized, epistemically classified evidence. Symptoms and
  // functional reports stay subjective; only independently documented findings
  // are objective; interview content is patient report; physician notes are
  // provider opinion. Nothing here is an AI inference presented as fact.
  const evidenceItems: ClassifiedEvidenceItem[] = [
    ...classifyBucket(se.imaging, "imaging", true, "documented_fact"),
    ...classifyBucket(se.objectiveFindings, "diagnostic_study", true, "documented_fact"),
    ...classifyBucket(se.examination, "physical_examination", true, "documented_fact"),
    ...classifyBucket(se.functionalLimitations.filter((e) => !/patient reports/i.test(e.text)), "functional_limitation", true, "documented_fact"),
    ...classifyBucket(subjectiveItems, "symptom", false, "patient_report"),
    ...classifyBucket(se.priorTreatment, "prior_treatment", true, "documented_fact"),
    ...classifyBucket(se.physicianDocumentation, "treating_provider_recommendation", false, "provider_opinion"),
    ...classifyBucket(se.guidelines, "guideline", false, "provider_opinion"),
  ];

  // Backstop for the anatomy gate: if any cited evidence text maps to a
  // DIFFERENT body region than this assessment, flag it and never validate.
  const crossRegionEvidence = evidenceItems.filter((e) => {
    if (region === "general" || e.category === "functional_limitation" || e.category === "symptom" || e.category === "guideline" || e.category === "treating_provider_recommendation") return false;
    const r = bodyRegion(e.text);
    if (r !== "general" && r !== region) return true;
    // Within-region specificity for EVERY anatomic region: spinal level for
    // spine, stated side for paired limb structures.
    if (r === region) return !anatomyCompatible(region, `${item.service} ${condition?.name ?? ""}`, e.text);
    return false;
  });
  for (const e of crossRegionEvidence) {
    weakeningEvidence.push({ claim: "anatomic evidence match", detail: `Cited ${e.category.replace(/_/g, " ")} evidence ("${e.text.slice(0, 60)}…") maps to a different body region than this ${region.replace(/_/g, "/")} recommendation.`, source: e.source, page: e.page, materiality: "HIGH", reducesConfidence: true, changesInclusion: true, requiresReview: true });
  }

  // CRE v1 lifecycle verdict — VALIDATED only when every gate passes.
  const blockingUnknowns = unknowns.some((u) => u.blocksInclusion);
  const structuralDefect = !mapping.matched || lateralityMismatch || codeCritical;
  const lifecycleStatus: AssessmentLifecycleStatus = structuralDefect
    ? "INVALID"
    : !frequencySupported || (durationClass === "LIFETIME" && !durationSupport.mayEnterFinalizedTotals) || blockingUnknowns || crossRegionEvidence.length > 0 || probabilityClassification === "INSUFFICIENTLY_SUPPORTED" || !evidenceSufficiencyStandalone(objectiveItems.length, se, physicianApproved)
      ? "NEEDS_REVIEW"
      : "VALIDATED";
  if (process.env.CRE_DEBUG) {
    console.log(`[cre] ${item.service}: structural=${structuralDefect} freq=${frequencySupported} lifetimeHold=${durationClass === "LIFETIME" && !durationSupport.mayEnterFinalizedTotals} blockUnknowns=${blockingUnknowns} crossRegion=${crossRegionEvidence.length} prob=${probabilityClassification} standalone=${evidenceSufficiencyStandalone(objectiveItems.length, se, physicianApproved)} → ${lifecycleStatus}`);
  }

  // ── Reasoning Reliability payload ──────────────────────────────────────────
  const regionEvents = chronology.filter((e) => bodyRegion(`${e.diagnosis ?? ""} ${e.procedure ?? ""} ${e.imagingFindings ?? ""}`) === region).length;
  const sources = Array.isArray(condition?.evidenceSources) ? (condition!.evidenceSources as unknown[]).length : 0;
  const evidenceSufficiencyObj = assessEvidenceSufficiency({
    objectiveCount: objectiveItems.length,
    imaging: se.imaging.length > 0,
    exam: se.examination.length > 0,
    recordSources: sources,
    providerDoc: se.physicianDocumentation.length > 0 || physicianApproved,
    chronologyEvents: regionEvents,
    conflicts: dossier.contradictoryEvidence.length,
    region,
  });
  const reasoningChain = buildChainNodes({
    service: item.service,
    diagnosis: condition?.name ?? null,
    region,
    subjective: sum(subjectiveItems),
    objective: sum(se.objectiveFindings),
    imaging: sum(se.imaging),
    exam: sum(se.examination),
    functional: dossier.functionalLink ? `${dossier.functionalLink.domain} — ${dossier.functionalLink.limitation}` : sum(se.functionalLimitations),
    priorTreatment: sum(se.priorTreatment),
    // The RECORD must state the response. This read the LENGTH of the
    // prior-treatment list, so any documented care produced "treatment has not
    // resolved the impairment" — a clinical conclusion manufactured from the
    // fact that treatment happened.
    response: documentedNonResolution ? "The record documents that prior treatment did not resolve the impairment." : null,
    // Necessity is a DETERMINATION, not a constant. Hard-coded true, this node
    // asserted medical necessity for every recommendation the engine ever
    // assessed, including ones it had just classified as unsupported.
    necessity: entersSupportedTotal(itemSupportClass),
    pv: item.presentValue ?? null,
    physicianStatus: item.physicianStatus ?? "PENDING",
    sources,
    // Exhaustion is a documented state, not a non-empty list.
    conservativeExhausted: documentedNonResolution,
  });
  const selfCritique = buildSelfCritique({
    service: item.service,
    diagnosis: condition?.name ?? null,
    weakening: weakeningEvidence,
    unknowns,
    lowerCostAlternative: item.lowerCostAlternative ?? null,
    frequencySupported,
    isLifetime: !!item.isLifetime,
    lifetimeClinicallySupported: durationSupport.clinicallySupported,
    evidenceItems,
    necessity: dossier.medicalNecessity,
  });
  const confidenceVector = buildConfidenceVector({
    sufficiency: evidenceSufficiencyObj,
    bestLiteratureLevel: bestLevel,
    guideline: se.guidelines.length > 0,
    providerDoc: se.physicianDocumentation.length > 0,
    weakeningCount: weakeningEvidence.filter((w) => w.materiality !== "LOW").length,
    unknownsBlocking: blockingUnknowns,
    physicianStatus: item.physicianStatus ?? "PENDING",
    necessityComplete: dossier.medicalNecessity.length > 120,
    confidenceScore: dossier.confidence.score,
  });
  const alternativeExplanations = deriveAlternativeExplanations(region, mapping.conditionId, conditions);

  // ── What makes this assessment MATERIALLY a different assessment ──────────
  // Duration-support evidence (or an attributed professional duration
  // rationale) is MATERIAL: a change in it changes the fingerprint, supersedes
  // the assessment version, and invalidates prior approval per existing policy.
  //
  // So is THE EVIDENCE ITSELF, which this omitted. Every input below is a
  // conclusion — the probability class, the strength band, the frequency —
  // and two different sets of findings routinely produce the same conclusions.
  // A physician therefore approved a recommendation on one body of evidence,
  // a citation was added or a record was corrected away, and the approval
  // carried over silently onto evidence they had never seen. The set's
  // fingerprint closes that: change the evidence and the assessment is a new
  // one, needing review again.
  // When a basis was recorded, its hash IS the evidence fingerprint: the two
  // must not be computed differently or an approval could be staled by one and
  // not the other.
  // BOTH identities, never one substituted for the other.
  //
  // This took the recorded hash when one was supplied and dropped the witness.
  // Since every field of this assessment is still derived from the CURRENT
  // dossier, that pinned the identity of re-derived content to an old record:
  // when the case moved and the basis did not, `materialHash` stayed put, the
  // approval was not invalidated, and `clinicalReasoningPersist` skipped the
  // recompute on a cache hit. The change made the hash LESS sensitive than the
  // witness it replaced — the opposite of the intent.
  //
  // Combining them can only increase sensitivity: the identity moves when the
  // record moves OR when the recorded basis moves. That is the correct
  // behaviour while presentation and witness reasoning share one function, and
  // it is what `assessmentFromBasis` / `deriveWitnessAssessment` below make
  // explicit at the call sites.
  const witnessFingerprint = evidenceSetFingerprint([...(dossier.ledger as unknown as EvidenceRowIdentity[]), ...handEnteredEvidence]);
  const evidenceFingerprint = recordedBasis?.basisHash ? `${recordedBasis.basisHash}+${witnessFingerprint}` : witnessFingerprint;
  const materialHash = hashStr([item.service, item.category ?? "", mapping.conditionId ?? "", region, laterality, purposeFor(item.category, !!item.isLifetime), freqN, durationClass, durationSupport.fingerprint, probabilityClassification, inclusionInTotalsStatus, item.startTrigger ?? "", item.replacesService ?? "", item.physicianStatus ?? "", evidenceStrength, evidenceFingerprint, setContext.conflicts.map((c) => c.type + c.otherService).sort().join(",")].join("|"));

  return {
    recommendationService: item.service,
    supportingDiagnosisIds: mapping.conditionId ? [mapping.conditionId] : [],
    bodyRegion: region,
    laterality,
    conditionSeverity: severityOf(condition),
    conditionChronicity: chronicityOf(condition),
    // Deliberately still the COUNT, and correct that way: a patient with
    // documented treatment is under active treatment. That is a statement
    // about care being delivered, not about whether it worked — which is the
    // inference the rest of this pass had to stop making. Over-applying the
    // rule here would deny an active-treatment status the record does support.
    currentClinicalStatus: clinicalStatusOf(condition, se.priorTreatment.length),
    responsibleSpecialty: lens.label,
    conditionTrajectory: trajectory,
    causalRelationshipStatus: CAUSAL[condition?.relatedness ?? "UNCLEAR"] ?? "unclear",
    clinicalPurpose: purposeFor(item.category, !!item.isLifetime),
    evidenceItems,
    objectiveEvidenceSummary: sum(objectiveItems),
    subjectiveEvidenceSummary: sum(subjectiveItems),
    functionalBasisSummary: dossier.functionalLink ? `${dossier.functionalLink.domain} — ${dossier.functionalLink.limitation}` : sum(se.functionalLimitations),
    priorTreatmentSummary: sum(se.priorTreatment),
    // Non-resolution is a STATEMENT the record either makes or does not. This
    // read `se.priorTreatment.length` — the existence of any prior treatment —
    // and so asserted that treatment had failed whenever treatment had merely
    // happened. `documentedNonResolution` above is the deterministic verdict
    // that the record says so; the else branch reports what is actually known
    // rather than filling the silence with the conclusion the plan needs.
    treatmentResponseSummary: documentedNonResolution
      ? "The record documents that prior treatment did not resolve the impairment (stated failure, persistence, or a residual deficit on examination)."
      : se.priorTreatment.length
        ? "Prior treatment is documented; the record does not state what it achieved. Response is not established here."
        : null,
    treatingRecordSupportSummary: sum(se.physicianDocumentation),
    medicalNecessityRationale: dossier.medicalNecessity,
    noTreatmentRisk: `Without ${lc(item.service)}, ${lens.concern} would go unaddressed for ${kase.subject}.`,
    leastIntensiveRationale: leastIntensiveOf(item, se.priorTreatment.length, pathwayOf(item), documentedNonResolution),
    timingRationale: timingOf(item),
    probabilityClassification,
    clinicalPathwayStage: staged ? "contingent / staged" : classify.includedInTotal ? "active plan" : "proposed",
    clinicalPathway: pathwayOf(item),
    conflictFlags: resolved.conflict
      ? [
          ...setContext.conflicts,
          {
            type: "CONDITION_MAPPING" as ConflictType,
            otherService: resolved.conflict.otherName,
            note: `This item is stored against "${resolved.conflict.persistedName}" but its service maps to "${resolved.conflict.mappedName}". The evidence below is drawn from ${resolved.condition?.name ?? "neither"}; confirm which diagnosis this item serves.`,
          },
        ]
      : setContext.conflicts,
    alternativesConsidered: alternativesFor(item),
    inclusionRationale,
    frequencyRationale,
    frequencySupported,
    durationClass,
    durationRationale,
    durationSupport,
    weakeningEvidence,
    unknowns,
    missingEvidenceRequests: missing,
    supportingGuidelineAssessments: se.guidelines.map((g) => ({ title: g.text.slice(0, 140), claim: "supports the diagnosis and the intervention" })),
    supportingLiteratureAssessments: literatureAssessments,
    rejectedLiterature,
    reasoningChain,
    evidenceSufficiency: evidenceSufficiencyObj,
    selfCritique,
    confidenceVector,
    alternativeExplanations,
    literatureSynthesis,
    residualUncertainty,
    evidenceStrength,
    recommendationConfidence,
    confidenceExplanation: dossier.confidence.explanation,
    costEligibilityStatus,
    inclusionInTotalsStatus,
    physicianReviewStatus: item.physicianStatus ?? "PENDING",
    validationStatus,
    lifecycleStatus,
    materialHash,
  };
}

// ── Export-gating findings (Phase D) ─────────────────────────────────────────

export interface ReasoningFinding {
  service: string;
  result: string;
  issue: string;
  severity: "Critical" | "High" | "Moderate" | "Low";
  suggestion: string;
  exportBlocking: boolean;
}

/**
 * Reasoning-derived validation findings, layered onto the existing integrity /
 * evidence / completeness checks (CRE v1 §16, §18). Export-blocking (final
 * export) applies to genuine double-counting and to totaled lines with an
 * unsupported frequency/duration, an unresolved critical evidence gap, or
 * assessment-rejected primary literature; a draft export remains available
 * with a watermark and an unresolved-issues appendix. `includedIds` are the
 * ids the cost engine actually totals, so we only gate what really counts.
 */
export function reasoningFindings(
  items: ReasoningItem[],
  conditions: (CondInput & DossierCondition & { id: string })[],
  chronology: DossierChronoEvent[],
  kase: DossierCase,
  includedIds: Set<string>,
): ReasoningFinding[] {
  const { flags, replacedByActive } = detectSetConflicts(items);
  const out: ReasoningFinding[] = [];
  for (const it of items) {
    const id = it.id ?? "";
    const inTotals = includedIds.has(id);
    // Set-level coherence only: this helper has no database and exists to
    // compare items against each other, so it states `null` rather than
    // pretending to a recorded basis it cannot see.
    // Explicitly the WITNESS entry point: these findings compare the current
    // set against itself, they are never displayed as the recorded assessment.
    const a = deriveWitnessAssessment(it, conditions, chronology, kase, { setContext: { conflicts: flags.get(id) ?? [], replacedByActive: replacedByActive.has(id) } });
    const physicianApproved = it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED";
    const pv = it.presentValue ?? 0;
    // Double-count: totaled alongside its own lower-cost alternative → blocking.
    if (inTotals && a.conflictFlags.some((c) => c.type === "ALTERNATIVE_BOTH_INCLUDED")) {
      out.push({ service: it.service, result: "Double-counted alternative", issue: `"${it.service}" is totaled alongside its own lower-cost alternative; only one should count.`, severity: "High", suggestion: "Keep one of the two in totals and disclose the other as an alternative.", exportBlocking: true });
    }
    // Replaced line still totaled → blocking (a staged replacement double-counts).
    if (inTotals && replacedByActive.has(id)) {
      out.push({ service: it.service, result: "Replaced line in totals", issue: `"${it.service}" is replaced by an active recommendation but is still in totals.`, severity: "High", suggestion: "Exclude the replaced line from totals; keep the replacement.", exportBlocking: true });
    }
    // Laterality mismatch — a right-sided service tied to a left-sided diagnosis.
    if (a.weakeningEvidence.some((w) => w.claim === "anatomic laterality")) {
      out.push({ service: it.service, result: "Laterality mismatch", issue: `"${it.service}" and its supporting diagnosis state different sides.`, severity: "High", suggestion: "Correct the service or map it to the diagnosis on the matching side.", exportBlocking: inTotals });
    }
    // Unsupported frequency on a totaled line: blocks FINAL export unless a
    // qualified reviewer has explicitly approved the item (§7, §18).
    if (inTotals && !a.frequencySupported) {
      out.push({ service: it.service, result: "Frequency unsupported", issue: `The stated frequency for "${it.service}" is not yet grounded in a cadence, guideline, or physician review.`, severity: "High", suggestion: "Document the cadence or obtain physician review before finalizing totals.", exportBlocking: !physicianApproved });
    }
    // Lifetime projection without independent duration support on a totaled
    // line — severity scales with financial materiality (§8); blocks final
    // export unless reviewer-approved (existing adoption policy). The scenario
    // itself stays calculated and disclosed — it is flagged, never dropped.
    if (inTotals && a.durationClass === "LIFETIME" && !a.durationSupport.clinicallySupported) {
      const critical = pv >= 100_000;
      out.push({ service: it.service, result: "Unsupported lifetime duration", issue: `"${it.service}" projects a remaining-lifetime scenario without independent clinical duration support${pv ? ` (PV ${Math.round(pv).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })})` : ""}; the lifetime horizon is a projection assumption, not established permanence.`, severity: critical ? "Critical" : "High", suggestion: "Obtain independent duration support: documented chronicity/prognosis in the record, diagnosis-keyed clinical guidance, or an attributed professional duration opinion.", exportBlocking: !physicianApproved });
    }
    // Critical evidence gap on a totaled line (a blocking unknown) → blocks final.
    const blockingUnknown = a.unknowns.find((u) => u.blocksInclusion);
    if (inTotals && blockingUnknown) {
      out.push({ service: it.service, result: "Material evidence gap", issue: `${blockingUnknown.missing} ${blockingUnknown.whyItMatters}`, severity: "High", suggestion: blockingUnknown.suggestedAction, exportBlocking: !physicianApproved });
    }
    // Assessment-rejected literature still attached to the recommendation.
    for (const r of a.rejectedLiterature) {
      out.push({ service: it.service, result: "Irrelevant literature", issue: `"${r.title.slice(0, 90)}" — ${r.reason}.`, severity: "High", suggestion: "Remove the citation or replace it with literature that addresses this diagnosis, region, and population.", exportBlocking: inTotals });
    }
    // Low recommendation confidence on a totaled line — advisory.
    if (inTotals && (a.recommendationConfidence === "LOW" || a.recommendationConfidence === "INDETERMINATE")) {
      out.push({ service: it.service, result: "Low recommendation confidence", issue: `"${it.service}" is in totals with ${a.recommendationConfidence.toLowerCase()} confidence.`, severity: "Moderate", suggestion: "Strengthen the patient-specific record support before finalizing.", exportBlocking: false });
    }
    // Narrative sanity (does this make sense to say in this situation?): every
    // generated narrative field is linted against the item's structured state —
    // anatomy coherence, state/numeric contradictions, broken citations,
    // garbled text. Anatomy incoherence on a totaled line blocks final export.
    const lint = lintAssessmentNarratives(a as unknown as Record<string, unknown> & { recommendationService: string; bodyRegion?: string | null }, {
      physicianStatus: it.physicianStatus,
      isLifetime: !!it.isLifetime,
      durationYears: it.durationYears ?? null,
      frequencyPerYear: it.frequencyPerYear,
      inclusionInTotalsStatus: a.inclusionInTotalsStatus,
      diagnosis: conditions.find((c) => c.id === a.supportingDiagnosisIds[0])?.name ?? null,
    });
    for (const li of lint) {
      out.push({ service: it.service, result: "Narrative coherence", issue: `[${li.rule}] ${li.explanation} — "${li.excerpt}"`, severity: li.severity === "High" ? "High" : "Moderate", suggestion: "Regenerate or edit the narrative — reader-facing text must match the structured clinical facts.", exportBlocking: li.rule === "anatomy_incoherence" && inTotals });
    }
    // Advisory: an included line the reasoning rates insufficiently supported.
    if (inTotals && a.probabilityClassification === "INSUFFICIENTLY_SUPPORTED") {
      out.push({ service: it.service, result: "Insufficiently supported", issue: `"${it.service}" is in totals but the reasoning rates its support insufficient.`, severity: "Moderate", suggestion: "Strengthen the record support or move it to a contingency.", exportBlocking: false });
    }
  }
  return out;
}

// Persistence lives in ./clinicalReasoningPersist (imports prisma). This module
// stays pure so it can be imported into client components and the report.


// ─────────────────────────────────────────────────────────────────────────────
// Two jobs, two entry points.
//
// `buildReasoningAssessment` serves both, and a caller reading it could not
// tell which one it was asking for. The distinction matters: an assessment that
// will be DISPLAYED or PERSISTED must be anchored to the recorded basis, while
// an assessment used to detect staleness must be derived from the record alone.
// Mixing them is how re-derived content came to sit under a recorded hash.
//
// Both are thin, and both stay pure — they take what they need and fetch
// nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The assessment shown to a reviewer and persisted — read FROM the record.
 *
 * This used to delegate straight to `buildReasoningAssessment`, which derives
 * every field from the current dossier. The recorded basis only coloured the
 * hash. So the panel and the report displayed freshly re-derived conclusions
 * under an identity that claimed to certify recorded ones: an approved
 * recommendation could show a different probability class, inclusion
 * rationale, confidence or duration verdict than the physician approved, and
 * nothing said so.
 *
 * Now every material and evidentiary conclusion comes from
 * `recordedBasis.assessmentBasis`. Nothing is re-derived to fill a gap: a
 * basis recorded before this field existed returns null rather than a
 * plausible reconstruction, and the caller must treat that as a basis it
 * cannot present (which the BASIS_STALE gate already does).
 *
 * Live workflow state is supplied by the caller, not read from the record:
 * conflict flags, physician review position, validation and lifecycle status
 * describe the case as it stands now. Freezing them would show a stale
 * workflow; their divergence from the record is caught by the specification
 * basis and reported as staleness.
 */
export function assessmentFromBasis(
  recordedBasis: BasisRecord,
  live: {
    conflictFlags?: ConflictFlag[];
    physicianReviewStatus?: string;
    validationStatus?: "ok" | "blocking" | "pending";
    lifecycleStatus?: AssessmentLifecycleStatus;
  } = {},
): ReasoningAssessment | null {
  const m = recordedBasis.assessmentBasis;
  if (!m) return null;

  const ev = recordedBasis.acceptedEvidence;
  const asClassified = (xs: { text: string; source: string | null }[], kind: string): ClassifiedEvidenceItem[] =>
    xs.map((x) => ({ text: x.text, source: x.source, kind } as unknown as ClassifiedEvidenceItem));

  return {
    recommendationService: recordedBasis.specification.service,
    supportingDiagnosisIds: recordedBasis.conditionId ? [recordedBasis.conditionId] : [],
    bodyRegion: m.bodyRegion,
    laterality: m.laterality,
    conditionSeverity: m.conditionSeverity,
    conditionChronicity: m.conditionChronicity,
    currentClinicalStatus: m.currentClinicalStatus,
    responsibleSpecialty: m.responsibleSpecialty,
    conditionTrajectory: m.conditionTrajectory,
    causalRelationshipStatus: m.causalRelationshipStatus,
    clinicalPurpose: m.clinicalPurpose,
    // The accepted evidence AS RECORDED — the same rows the hash covers.
    evidenceItems: [
      ...asClassified(ev.diagnoses, "DIAGNOSIS"),
      ...asClassified(ev.objectiveFindings, "OBJECTIVE"),
      ...asClassified(ev.functionalLimitations, "FUNCTIONAL"),
      ...asClassified(ev.priorTreatment, "PRIOR_TREATMENT"),
      ...asClassified(ev.guidelines, "GUIDELINE"),
    ],
    objectiveEvidenceSummary: m.objectiveEvidenceSummary,
    subjectiveEvidenceSummary: m.subjectiveEvidenceSummary,
    functionalBasisSummary: m.functionalBasisSummary,
    priorTreatmentSummary: m.priorTreatmentSummary,
    treatmentResponseSummary: m.treatmentResponseSummary,
    treatingRecordSupportSummary: m.treatingRecordSupportSummary,
    medicalNecessityRationale: m.medicalNecessityRationale,
    noTreatmentRisk: m.noTreatmentRisk,
    leastIntensiveRationale: m.leastIntensiveRationale,
    timingRationale: m.timingRationale,
    probabilityClassification: m.probabilityClassification as ProbabilityClassification,
    clinicalPathwayStage: m.clinicalPathwayStage,
    clinicalPathway: m.clinicalPathway,
    // LIVE: the conflict set is a property of the plan right now.
    conflictFlags: live.conflictFlags ?? [],
    alternativesConsidered: m.alternativesConsidered,
    inclusionRationale: m.inclusionRationale,
    frequencyRationale: m.frequencyRationale,
    frequencySupported: m.frequencySupported,
    durationClass: m.durationClass as DurationClass,
    durationRationale: m.durationRationale,
    // Reconstructed from the recorded verdict, not recomputed. `bases` and
    // `uncertaintyNotes` are the narrative expansion of a verdict the hash
    // already covers; the report prints the verdict and the rationale.
    durationSupport: {
      status: (m.durationSupported ? "SUPPORTED" : "UNSUPPORTED") as LifetimeSupportResult["status"],
      clinicallySupported: m.durationSupported,
      professionalAdoption: recordedBasis.specification.physicianStatus === "APPROVED" || recordedBasis.specification.physicianStatus === "MODIFIED",
      bases: m.durationBasisLabel ? ([{ kind: m.durationBasisLabel, detail: m.durationRationale, sourceRef: null }] as unknown as LifetimeSupportResult["bases"]) : [],
      uncertaintyNotes: [],
      reviewOutstanding: false,
      fingerprint: `${m.durationClass}|${m.durationSupported}|${m.durationBasisLabel ?? ""}`,
    } as unknown as LifetimeSupportResult,
    weakeningEvidence: recordedBasis.contradictions.map((t) => ({ text: t, why: "Recorded as contradictory evidence." } as unknown as WeakeningItem)),
    unknowns: recordedBasis.missingPremises.map((t) => ({ text: t } as unknown as UnknownItem)),
    missingEvidenceRequests: m.missingEvidenceRequests,
    supportingGuidelineAssessments: m.supportingGuidelineAssessments,
    supportingLiteratureAssessments: recordedBasis.literature.map((l) => ({
      title: l.title,
      pmid: l.pmid ?? undefined,
      supports: l.supports,
      applicability: l.studyType,
      evidenceLevel: 0,
      limitations: l.limitations,
    })),
    rejectedLiterature: [],
    reasoningChain: [],
    evidenceSufficiency: { sufficient: m.frequencySupported, gaps: m.missingEvidenceRequests } as unknown as EvidenceSufficiency,
    selfCritique: { weakestLink: m.residualUncertainty, whatWouldChangeTheOpinion: m.missingEvidenceRequests } as unknown as SelfCritique,
    confidenceVector: { overall: m.recommendationConfidence } as unknown as ConfidenceVector,
    alternativeExplanations: [],
    literatureSynthesis: m.literatureSynthesis,
    residualUncertainty: m.residualUncertainty,
    evidenceStrength: m.evidenceStrength as EvidenceStrength,
    recommendationConfidence: m.recommendationConfidence as RecommendationConfidence,
    confidenceExplanation: m.confidenceExplanation,
    costEligibilityStatus: m.costEligibilityStatus,
    inclusionInTotalsStatus: m.inclusionInTotalsStatus as ReasoningAssessment["inclusionInTotalsStatus"],
    // LIVE workflow position.
    physicianReviewStatus: live.physicianReviewStatus ?? recordedBasis.specification.physicianStatus,
    validationStatus: live.validationStatus ?? "pending",
    // Defaults to NEEDS_REVIEW, never VALIDATED: a basis read back from the
    // record has not been re-validated against the case as it stands, and a
    // reader must not infer that it has.
    lifecycleStatus: live.lifecycleStatus ?? "NEEDS_REVIEW",
    // The identity of the RECORD this assessment was read from. Not a fresh
    // derivation: two readers of the same basis must agree, and a reader must
    // never be able to move it by re-reading.
    materialHash: recordedBasis.basisHash,
  } as ReasoningAssessment;
}

/**
 * The assessment derived from the CURRENT record, for staleness only.
 *
 * Explicitly basis-free: passing a recorded basis here would defeat the point,
 * so the parameter is not offered.
 */
export function deriveWitnessAssessment(
  item: ReasoningItem,
  conditions: (CondInput & DossierCondition & { id: string })[],
  chronology: DossierChronoEvent[],
  kase: DossierCase,
  opts: { interviews?: DossierInterview[]; setContext?: SetContext; handEnteredEvidence?: readonly EvidenceRowIdentity[] } = {},
): ReasoningAssessment {
  return buildReasoningAssessment(
    item, conditions, chronology, kase,
    opts.interviews ?? [],
    opts.setContext ?? { conflicts: [], replacedByActive: false },
    opts.handEnteredEvidence ?? [],
    null,
  );
}
