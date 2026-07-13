import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma";
import { buildReasoningAssessment, detectSetConflicts, type ReasoningAssessment, type ReasoningItem } from "@/lib/engine/clinicalReasoning";
import type { DossierCase, DossierChronoEvent, DossierCondition, DossierInterview } from "@/lib/engine/medicalNecessity";
import type { CondInput } from "@/lib/engine/integrity";

// Server-side persistence for the Clinical Reasoning Engine. Kept apart from the
// pure engine (clinicalReasoning.ts) so that module can be bundled client-side.

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
 * left alone; a changed one is updated in place; assessments for removed
 * recommendations are superseded. Returns the persisted set.
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

  // Cross-recommendation coherence, computed once across the set (Phase B).
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
