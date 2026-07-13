import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma";
import { buildRecommendationDossier, type DossierItem, type DossierCondition, type DossierChronoEvent, type DossierCase, type DossierInterview } from "@/lib/engine/medicalNecessity";
import { mapRecommendationToCondition, validateCode, validatePricing, classifyRecommendation, hasPatientRecordSupport, bodyRegion, type RecInput, type CondInput } from "@/lib/engine/integrity";
import { specialtyLens } from "@/lib/engine/specialtyReasoning";

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

export type ConflictType = "DUPLICATE" | "REPLACED_BY" | "REPLACES" | "ALTERNATIVE_BOTH_INCLUDED" | "OVERLAP";
export interface ConflictFlag { type: ConflictType; otherService: string; note: string }

// Set-level context computed across ALL of a case's recommendations, injected
// into the per-item builder so one assessment can reason about its neighbours
// (duplicates, staged replacements, alternatives) without a second model.
export interface SetContext { conflicts: ConflictFlag[]; replacedByActive: boolean }

export interface LiteratureAssessment { title: string; pmid?: string; supports: string; applicability: string; evidenceLevel: number; limitations: string | null }

export interface ReasoningAssessment {
  recommendationService: string;
  supportingDiagnosisIds: string[];
  bodyRegion: string;
  responsibleSpecialty: string;
  conditionTrajectory: string;
  causalRelationshipStatus: string;
  clinicalPurpose: string;
  objectiveEvidenceSummary: string | null;
  subjectiveEvidenceSummary: string | null;
  functionalBasisSummary: string | null;
  priorTreatmentSummary: string | null;
  treatmentResponseSummary: string | null;
  treatingRecordSupportSummary: string | null;
  medicalNecessityRationale: string;
  noTreatmentRisk: string;
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
  weakeningEvidence: string[];
  unknowns: string[];
  missingEvidenceRequests: string[];
  supportingGuidelineAssessments: { title: string; claim: string }[];
  supportingLiteratureAssessments: LiteratureAssessment[];
  literatureSynthesis: string;
  residualUncertainty: string;
  evidenceStrength: EvidenceStrength;
  recommendationConfidence: RecommendationConfidence;
  confidenceExplanation: string;
  costEligibilityStatus: string;
  inclusionInTotalsStatus: "included" | "excluded" | "contingency";
  physicianReviewStatus: string;
  validationStatus: "ok" | "blocking" | "pending";
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

// §13 (Phase C) — the honest counter-analysis: what could undermine this line.
function deriveWeakening(base: string[], ctx: { objectiveCount: number; physicianApproved: boolean; frequencySupported: boolean; durationClass: DurationClass; lifetimeWellSupported: boolean; weakPrimary: boolean; matched: boolean; region: string }): string[] {
  const out = [...base];
  const add = (s: string) => { if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  if (ctx.objectiveCount === 0) add(`No independent objective finding is documented for the ${ctx.region} in the current record.`);
  if (!ctx.matched) add("No diagnosis in the relevant body region maps to this recommendation.");
  if (!ctx.physicianApproved) add("Not yet confirmed or signed off by the treating physician.");
  if (!ctx.frequencySupported) add("The stated frequency is assumed rather than grounded in a documented cadence.");
  if (ctx.durationClass === "LIFETIME" && !ctx.lifetimeWellSupported) add("A lifetime duration is asserted on limited supporting evidence.");
  if (ctx.weakPrimary) add("The strongest available citation is only a case series or case report.");
  return out;
}

// §14 (Phase C) — actionable missing-evidence requests, not vague gaps.
function deriveMissing(base: string[], ctx: { objectiveCount: number; physicianApproved: boolean; frequencySupported: boolean; region: string }): string[] {
  const out = [...base.map((s) => s.trim()).filter(Boolean)];
  const add = (s: string) => { if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  if (ctx.objectiveCount === 0) add(`Obtain objective confirmation (imaging or examination) for the ${ctx.region}.`);
  if (!ctx.physicianApproved) add("Treating-physician review and sign-off.");
  if (!ctx.frequencySupported) add("Document the treatment cadence supporting the stated frequency.");
  return out.slice(0, 5);
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

function durationOf(item: ReasoningItem, lifetimeWellSupported: boolean): { durationClass: DurationClass; durationRationale: string } {
  const svc = item.service.toLowerCase();
  if (item.startTrigger || item.contingencyOnly) {
    if (/surgery|arthroplasty|fusion|replacement|revision/.test(svc)) return { durationClass: "UNTIL_SURGERY", durationRationale: `Conditional: this care applies only if ${lc(item.startTrigger ?? "the trigger criteria")} — it is not open-ended.` };
    return { durationClass: "CONDITIONAL", durationRationale: `Conditional on ${lc(item.startTrigger ?? "a documented trigger")}; excluded from finalized totals until the trigger is met.` };
  }
  if (item.isLifetime) {
    return {
      durationClass: "LIFETIME",
      durationRationale: lifetimeWellSupported
        ? "Lifetime care is supported: the condition is chronic and progressive on the objective record and/or applicable guidance, and no event is expected to end the need."
        : "Lifetime duration is asserted but rests on limited support — a chronic/progressive objective basis, guideline, or physician endorsement is needed before it is defensible over the full life expectancy.",
    };
  }
  const yrs = item.durationYears ?? 0;
  if (yrs === 0) return { durationClass: "ONE_TIME", durationRationale: "A one-time service; no recurring course is anticipated." };
  if (yrs <= 1) return { durationClass: "SHORT_TERM", durationRationale: `A short, defined course (~${yrs} year) tied to the current recovery phase.` };
  if (/therapy|injection/.test(svc)) return { durationClass: "EPISODIC", durationRationale: `Episodic over ~${yrs} years, used during symptomatic flares rather than continuously.` };
  return { durationClass: "MULTI_YEAR", durationRationale: `A multi-year course (~${yrs} years) reflecting the expected treatment horizon for this condition.` };
}

/** Build the structured reasoning assessment for one recommendation (pure). */
export function buildReasoningAssessment(
  item: ReasoningItem,
  conditions: (CondInput & DossierCondition & { id: string })[],
  chronology: DossierChronoEvent[],
  kase: DossierCase,
  interviews: DossierInterview[] = [],
  setContext: SetContext = { conflicts: [], replacedByActive: false },
): ReasoningAssessment {
  const rec = item as unknown as RecInput;
  const mapping = mapRecommendationToCondition(rec, conditions);
  const condition = (conditions.find((c) => c.id === mapping.conditionId) ?? null) as DossierCondition | null;
  const dossier = buildRecommendationDossier(item, condition, chronology, kase, interviews);
  const code = validateCode(rec);
  const pricing = validatePricing(rec);
  const recordSupport = hasPatientRecordSupport({ missingSupport: item.missingSupport, confidence: item.confidence }, mapping.condition);
  const codeCritical = code.status === "Code mismatch" || pricing.status === "Pricing mismatch";
  const classify = classifyRecommendation(rec, { matched: mapping.matched, codeCritical, hasRecordSupport: recordSupport });

  const lens = specialtyLens(item.category, item.service);
  const region = bodyRegion(`${item.service} ${condition?.name ?? ""}`);
  const staged = !!item.contingencyOnly || !!item.startTrigger;

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
  const frequencySupported = se.priorTreatment.length > 0 || se.guidelines.length > 0 || physicianApproved;
  const freqN = item.frequencyPerYear ?? 1;
  const frequencyRationale = frequencySupported
    ? `The ${freqN}×/yr frequency is grounded in ${[se.priorTreatment.length ? "the documented treatment cadence" : "", se.guidelines.length ? "cited clinical guidance" : "", physicianApproved ? "physician review" : ""].filter(Boolean).join(", ")}.`
    : `The ${freqN}×/yr frequency is an assumption not yet grounded in a documented cadence, guideline, or physician review; it is pending review and should not enter finalized totals until supported.`;

  // §11 duration.
  const lifetimeWellSupported = se.guidelines.length > 0 || objectiveItems.length > 0 || physicianApproved;
  const { durationClass, durationRationale } = durationOf(item, lifetimeWellSupported);

  const bestLevel = dossier.literature.length ? Math.min(...dossier.literature.map((l) => l.evidenceLevel)) : null;
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

  const trajectory = condition?.opposingRecords && /improv/i.test(condition.opposingRecords) ? "improving" : item.isLifetime ? "chronic, stable-to-worsening" : "uncertain";
  const weakPrimary = bestLevel != null && bestLevel >= 9;
  const weakeningEvidence = deriveWeakening(dossier.contradictoryEvidence, { objectiveCount: objectiveItems.length, physicianApproved, frequencySupported, durationClass, lifetimeWellSupported, weakPrimary, matched: mapping.matched, region });
  const missing = deriveMissing([condition?.missingInfo ?? "", item.missingSupport ?? "", ...dossier.unknowns], { objectiveCount: objectiveItems.length, physicianApproved, frequencySupported, region });
  const literatureAssessments = dossier.literature.map((l) => ({ title: l.title, pmid: l.pmid, supports: l.supports, applicability: l.applicability, evidenceLevel: l.evidenceLevel, limitations: l.limitations }));
  const literatureSynthesis = synthesizeLiterature(literatureAssessments, se.guidelines.length > 0, item.service);
  const residualUncertainty = residualUncertaintyOf(recommendationConfidence, dossier.confidence.factors, missing);

  const materialHash = hashStr([item.service, item.category ?? "", mapping.conditionId ?? "", region, purposeFor(item.category, !!item.isLifetime), freqN, durationClass, probabilityClassification, inclusionInTotalsStatus, item.startTrigger ?? "", item.replacesService ?? "", item.physicianStatus ?? "", setContext.conflicts.map((c) => c.type + c.otherService).sort().join(",")].join("|"));

  return {
    recommendationService: item.service,
    supportingDiagnosisIds: mapping.conditionId ? [mapping.conditionId] : [],
    bodyRegion: region,
    responsibleSpecialty: lens.label,
    conditionTrajectory: trajectory,
    causalRelationshipStatus: CAUSAL[condition?.relatedness ?? "UNCLEAR"] ?? "unclear",
    clinicalPurpose: purposeFor(item.category, !!item.isLifetime),
    objectiveEvidenceSummary: sum(objectiveItems),
    subjectiveEvidenceSummary: sum(subjectiveItems),
    functionalBasisSummary: dossier.functionalLink ? `${dossier.functionalLink.domain} — ${dossier.functionalLink.limitation}` : sum(se.functionalLimitations),
    priorTreatmentSummary: sum(se.priorTreatment),
    treatmentResponseSummary: se.priorTreatment.length ? "Documented treatment has not resolved the impairment (residual deficit on the record)." : null,
    treatingRecordSupportSummary: sum(se.physicianDocumentation),
    medicalNecessityRationale: dossier.medicalNecessity,
    noTreatmentRisk: `Without ${lc(item.service)}, ${lens.concern} would go unaddressed for ${kase.subject}.`,
    probabilityClassification,
    clinicalPathwayStage: staged ? "contingent / staged" : classify.includedInTotal ? "active plan" : "proposed",
    clinicalPathway: pathwayOf(item),
    conflictFlags: setContext.conflicts,
    alternativesConsidered: alternativesFor(item),
    inclusionRationale,
    frequencyRationale,
    frequencySupported,
    durationClass,
    durationRationale,
    weakeningEvidence,
    unknowns: dossier.unknowns,
    missingEvidenceRequests: missing,
    supportingGuidelineAssessments: se.guidelines.map((g) => ({ title: g.text.slice(0, 140), claim: "supports the diagnosis and the intervention" })),
    supportingLiteratureAssessments: literatureAssessments,
    literatureSynthesis,
    residualUncertainty,
    evidenceStrength,
    recommendationConfidence,
    confidenceExplanation: dossier.confidence.explanation,
    costEligibilityStatus,
    inclusionInTotalsStatus,
    physicianReviewStatus: item.physicianStatus ?? "PENDING",
    validationStatus,
    materialHash,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

const toRow = (a: ReasoningAssessment) => ({
  recommendationService: a.recommendationService,
  status: "ASSESSED" as const,
  supportingDiagnosisIds: a.supportingDiagnosisIds as unknown as Prisma.InputJsonValue,
  bodyRegion: a.bodyRegion,
  responsibleSpecialty: a.responsibleSpecialty,
  conditionTrajectory: a.conditionTrajectory,
  causalRelationshipStatus: a.causalRelationshipStatus,
  clinicalPurpose: a.clinicalPurpose,
  objectiveEvidenceSummary: a.objectiveEvidenceSummary,
  subjectiveEvidenceSummary: a.subjectiveEvidenceSummary,
  functionalBasisSummary: a.functionalBasisSummary,
  priorTreatmentSummary: a.priorTreatmentSummary,
  treatmentResponseSummary: a.treatmentResponseSummary,
  treatingRecordSupportSummary: a.treatingRecordSupportSummary,
  medicalNecessityRationale: a.medicalNecessityRationale,
  noTreatmentRisk: a.noTreatmentRisk,
  probabilityClassification: a.probabilityClassification,
  clinicalPathwayStage: a.clinicalPathwayStage,
  clinicalPathway: a.clinicalPathway,
  conflictFlags: a.conflictFlags as unknown as Prisma.InputJsonValue,
  alternativesConsidered: a.alternativesConsidered as unknown as Prisma.InputJsonValue,
  inclusionRationale: a.inclusionRationale,
  frequencyRationale: a.frequencyRationale,
  frequencySupported: a.frequencySupported,
  durationClass: a.durationClass,
  durationRationale: a.durationRationale,
  weakeningEvidence: a.weakeningEvidence as unknown as Prisma.InputJsonValue,
  unknowns: a.unknowns as unknown as Prisma.InputJsonValue,
  missingEvidenceRequests: a.missingEvidenceRequests as unknown as Prisma.InputJsonValue,
  supportingGuidelineAssessments: a.supportingGuidelineAssessments as unknown as Prisma.InputJsonValue,
  supportingLiteratureAssessments: a.supportingLiteratureAssessments as unknown as Prisma.InputJsonValue,
  literatureSynthesis: a.literatureSynthesis,
  residualUncertainty: a.residualUncertainty,
  evidenceStrength: a.evidenceStrength,
  recommendationConfidence: a.recommendationConfidence,
  confidenceExplanation: a.confidenceExplanation,
  costEligibilityStatus: a.costEligibilityStatus,
  inclusionInTotalsStatus: a.inclusionInTotalsStatus,
  physicianReviewStatus: a.physicianReviewStatus,
  validationStatus: a.validationStatus,
  materialHash: a.materialHash,
  generatedByModel: "deterministic-reasoning-v1",
});

/**
 * Assess every current recommendation of a case and persist. Upserts by
 * (caseId, recommendationId): an unchanged assessment (same materialHash) is
 * left alone; a changed one is updated in place (approval-invalidation is wired
 * in Phase D); assessments for removed recommendations are superseded. Returns
 * the persisted set.
 */
export async function persistCaseReasoning(caseId: string, firmId: string) {
  const [items, conditions, kase, chronology, interviews] = await Promise.all([
    prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null } }),
    prisma.condition.findMany({ where: { caseId } }),
    prisma.case.findUnique({ where: { id: caseId }, select: { clientName: true, dateOfBirth: true, lifeExpectancyYears: true } }),
    prisma.chronologyEvent.findMany({ where: { caseId } }),
    prisma.interviewFinding.findMany({ where: { caseId } }),
  ]);
  const adult = !kase?.dateOfBirth || (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  const dossierCase: DossierCase = { subject: kase?.clientName ?? "the patient", pronounPoss: "the patient's", lifeExpectancyYears: kase?.lifeExpectancyYears ?? 40, adult };
  const conds = conditions as unknown as (CondInput & DossierCondition & { id: string })[];

  const existing = await prisma.clinicalReasoningAssessment.findMany({ where: { caseId }, select: { id: true, recommendationId: true, materialHash: true, status: true } });
  const byRec = new Map(existing.map((e) => [e.recommendationId, e]));
  const seenRec = new Set<string>();
  const ops: Prisma.PrismaPromise<unknown>[] = [];

  // Phase B — cross-recommendation coherence, computed once across the set.
  const { flags: conflictFlags, replacedByActive } = detectSetConflicts(items as unknown as ReasoningItem[]);

  for (const it of items) {
    seenRec.add(it.id);
    const a = buildReasoningAssessment(it as unknown as ReasoningItem, conds, chronology as unknown as DossierChronoEvent[], dossierCase, interviews as unknown as DossierInterview[], { conflicts: conflictFlags.get(it.id) ?? [], replacedByActive: replacedByActive.has(it.id) });
    const prior = byRec.get(it.id);
    if (!prior) ops.push(prisma.clinicalReasoningAssessment.create({ data: { ...toRow(a), caseId, firmId, recommendationId: it.id } }));
    else if (prior.materialHash !== a.materialHash || prior.status !== "ASSESSED") ops.push(prisma.clinicalReasoningAssessment.update({ where: { id: prior.id }, data: toRow(a) }));
  }
  // Recommendations that no longer exist → supersede their assessment.
  for (const e of existing) if (!seenRec.has(e.recommendationId) && e.status !== "SUPERSEDED") ops.push(prisma.clinicalReasoningAssessment.update({ where: { id: e.id }, data: { status: "SUPERSEDED" } }));

  await prisma.$transaction(ops);
  return prisma.clinicalReasoningAssessment.findMany({ where: { caseId, status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "asc" } });
}
