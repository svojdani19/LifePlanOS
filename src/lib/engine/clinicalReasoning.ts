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
  frequencyRationale: string;
  frequencySupported: boolean;
  durationClass: DurationClass;
  durationRationale: string;
  weakeningEvidence: string[];
  unknowns: string[];
  missingEvidenceRequests: string[];
  supportingGuidelineAssessments: { title: string; claim: string }[];
  supportingLiteratureAssessments: LiteratureAssessment[];
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

  // A staged/contingent item is disclosed but never entered into totals (§10), regardless of how well supported.
  const inclusionInTotalsStatus: "included" | "excluded" | "contingency" = staged ? "contingency" : classify.includedInTotal ? "included" : "excluded";
  const costEligibilityStatus = codeCritical ? "Coding/pricing inconsistency must be resolved before inclusion." : pricing.status === "Unsupported bundled estimate" ? "Bundled estimate — attach a code or disclose the bundled basis." : "Cost basis is coherent for inclusion.";
  const validationStatus: "ok" | "blocking" | "pending" = !mapping.matched || codeCritical ? "blocking" : physicianApproved || frequencySupported ? "ok" : "pending";

  const trajectory = condition?.opposingRecords && /improv/i.test(condition.opposingRecords) ? "improving" : item.isLifetime ? "chronic, stable-to-worsening" : "uncertain";
  const missing = [condition?.missingInfo ?? "", item.missingSupport ?? "", ...dossier.unknowns].map((s) => String(s).trim()).filter(Boolean).slice(0, 4);

  const materialHash = hashStr([item.service, item.category ?? "", mapping.conditionId ?? "", region, purposeFor(item.category, !!item.isLifetime), freqN, durationClass, probabilityClassification, inclusionInTotalsStatus, item.startTrigger ?? "", item.replacesService ?? "", item.physicianStatus ?? ""].join("|"));

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
    frequencyRationale,
    frequencySupported,
    durationClass,
    durationRationale,
    weakeningEvidence: dossier.contradictoryEvidence,
    unknowns: dossier.unknowns,
    missingEvidenceRequests: missing,
    supportingGuidelineAssessments: se.guidelines.map((g) => ({ title: g.text.slice(0, 140), claim: "supports the diagnosis and the intervention" })),
    supportingLiteratureAssessments: dossier.literature.map((l) => ({ title: l.title, pmid: l.pmid, supports: l.supports, applicability: l.applicability, evidenceLevel: l.evidenceLevel, limitations: l.limitations })),
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
  frequencyRationale: a.frequencyRationale,
  frequencySupported: a.frequencySupported,
  durationClass: a.durationClass,
  durationRationale: a.durationRationale,
  weakeningEvidence: a.weakeningEvidence as unknown as Prisma.InputJsonValue,
  unknowns: a.unknowns as unknown as Prisma.InputJsonValue,
  missingEvidenceRequests: a.missingEvidenceRequests as unknown as Prisma.InputJsonValue,
  supportingGuidelineAssessments: a.supportingGuidelineAssessments as unknown as Prisma.InputJsonValue,
  supportingLiteratureAssessments: a.supportingLiteratureAssessments as unknown as Prisma.InputJsonValue,
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

  for (const it of items) {
    seenRec.add(it.id);
    const a = buildReasoningAssessment(it as unknown as ReasoningItem, conds, chronology as unknown as DossierChronoEvent[], dossierCase, interviews as unknown as DossierInterview[]);
    const prior = byRec.get(it.id);
    if (!prior) ops.push(prisma.clinicalReasoningAssessment.create({ data: { ...toRow(a), caseId, firmId, recommendationId: it.id } }));
    else if (prior.materialHash !== a.materialHash || prior.status !== "ASSESSED") ops.push(prisma.clinicalReasoningAssessment.update({ where: { id: prior.id }, data: toRow(a) }));
  }
  // Recommendations that no longer exist → supersede their assessment.
  for (const e of existing) if (!seenRec.has(e.recommendationId) && e.status !== "SUPERSEDED") ops.push(prisma.clinicalReasoningAssessment.update({ where: { id: e.id }, data: { status: "SUPERSEDED" } }));

  await prisma.$transaction(ops);
  return prisma.clinicalReasoningAssessment.findMany({ where: { caseId, status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "asc" } });
}
