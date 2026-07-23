import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma";
import { buildReasoningAssessment, detectSetConflicts, type ReasoningAssessment, type ReasoningItem } from "@/lib/engine/clinicalReasoning";
import type { DossierCase, DossierChronoEvent, DossierCondition, DossierInterview } from "@/lib/engine/medicalNecessity";
import type { CondInput } from "@/lib/engine/integrity";

// Server-side persistence for the Clinical Reasoning Engine (CRE v1). Kept
// apart from the pure engine (clinicalReasoning.ts) so that module can be
// bundled client-side.
//
// Lifecycle contract (§17, §19):
//   • unchanged material hash → the stored row is left alone (version-aware cache);
//   • material change → the prior row is SUPERSEDED (never updated in place,
//     never deleted) and a new row is created pointing back via lineage; when
//     the recommendation was physician-approved, the new row is forced to
//     NEEDS_REVIEW, reviewerMetadata records what changed, and an audit event
//     is written — approval is never silently carried forward;
//   • a removed recommendation's assessment is SUPERSEDED;
//   • a per-item computation failure is captured as an ERROR row without
//     aborting the rest of the case (partial-failure recovery).

const j = (v: unknown) => v as Prisma.InputJsonValue;

const toRow = (a: ReasoningAssessment) => ({
  recommendationService: a.recommendationService,
  status: a.lifecycleStatus, // NEEDS_REVIEW | VALIDATED | INVALID — never "validated merely because a row exists"
  supportingDiagnosisIds: j(a.supportingDiagnosisIds),
  bodyRegion: a.bodyRegion,
  laterality: a.laterality,
  conditionSeverity: a.conditionSeverity,
  conditionChronicity: a.conditionChronicity,
  currentClinicalStatus: a.currentClinicalStatus,
  responsibleSpecialty: a.responsibleSpecialty,
  conditionTrajectory: a.conditionTrajectory,
  causalRelationshipStatus: a.causalRelationshipStatus,
  clinicalPurpose: a.clinicalPurpose,
  evidenceItems: j(a.evidenceItems),
  objectiveEvidenceSummary: a.objectiveEvidenceSummary,
  subjectiveEvidenceSummary: a.subjectiveEvidenceSummary,
  functionalBasisSummary: a.functionalBasisSummary,
  priorTreatmentSummary: a.priorTreatmentSummary,
  treatmentResponseSummary: a.treatmentResponseSummary,
  treatingRecordSupportSummary: a.treatingRecordSupportSummary,
  medicalNecessityRationale: a.medicalNecessityRationale,
  noTreatmentRisk: a.noTreatmentRisk,
  leastIntensiveRationale: a.leastIntensiveRationale,
  timingRationale: a.timingRationale,
  probabilityClassification: a.probabilityClassification,
  clinicalPathwayStage: a.clinicalPathwayStage,
  clinicalPathway: a.clinicalPathway,
  conflictFlags: j(a.conflictFlags),
  alternativesConsidered: j(a.alternativesConsidered),
  inclusionRationale: a.inclusionRationale,
  frequencyRationale: a.frequencyRationale,
  frequencySupported: a.frequencySupported,
  durationClass: a.durationClass,
  durationRationale: a.durationRationale,
  weakeningEvidence: j(a.weakeningEvidence),
  unknowns: j(a.unknowns),
  missingEvidenceRequests: j(a.missingEvidenceRequests),
  supportingGuidelineAssessments: j(a.supportingGuidelineAssessments),
  supportingLiteratureAssessments: j(a.supportingLiteratureAssessments),
  rejectedLiterature: j(a.rejectedLiterature),
  reasoningChain: j(a.reasoningChain),
  evidenceSufficiency: j(a.evidenceSufficiency),
  selfCritique: j(a.selfCritique),
  confidenceVector: j(a.confidenceVector),
  alternativeExplanations: j(a.alternativeExplanations),
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
  generatedByModel: "deterministic-reasoning-v2",
});

// The material fields compared to report WHAT changed when approval is invalidated.
const MATERIAL_FIELDS = ["recommendationService", "supportingDiagnosisIds", "bodyRegion", "laterality", "clinicalPurpose", "responsibleSpecialty", "probabilityClassification", "durationClass", "inclusionInTotalsStatus", "evidenceStrength", "frequencySupported"] as const;
function changedFields(prior: Record<string, unknown>, next: ReasoningAssessment): string[] {
  const nextRow = toRow(next) as Record<string, unknown>;
  return MATERIAL_FIELDS.filter((f) => JSON.stringify(prior[f] ?? null) !== JSON.stringify(nextRow[f] ?? null));
}

export interface PersistOptions {
  /** Reassess only these recommendation ids (incremental, §19). */
  recommendationIds?: string[];
  /** Actor id recorded on approval-invalidation audit events. */
  actorUserId?: string | null;
}

/**
 * Assess the case's current recommendations and persist (CRE v1). Idempotent:
 * an unchanged assessment (same material hash) is untouched; re-running never
 * duplicates rows. Returns the current (non-superseded) set.
 */
export async function persistCaseReasoning(caseId: string, firmId: string, opts: PersistOptions = {}) {
  const [items, conditions, kase, chronology, interviews, latestSnapshot] = await Promise.all([
    prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null, ...(opts.recommendationIds ? { id: { in: opts.recommendationIds } } : {}) } }),
    prisma.condition.findMany({ where: { caseId } }),
    prisma.case.findUnique({ where: { id: caseId }, select: { clientName: true, dateOfBirth: true, lifeExpectancyYears: true } }),
    prisma.chronologyEvent.findMany({ where: { caseId } }),
    prisma.interviewFinding.findMany({ where: { caseId } }),
    prisma.caseSnapshot.findFirst({ where: { caseId }, orderBy: { version: "desc" }, select: { version: true } }),
  ]);
  const adult = !kase?.dateOfBirth || (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  const dossierCase: DossierCase = { subject: kase?.clientName ?? "the patient", pronounPoss: "the patient's", lifeExpectancyYears: kase?.lifeExpectancyYears ?? 40, adult };
  const conds = conditions as unknown as (CondInput & DossierCondition & { id: string })[];
  const caseVersion = latestSnapshot?.version ?? null;

  const existing = await prisma.clinicalReasoningAssessment.findMany({ where: { caseId, status: { not: "SUPERSEDED" } } });
  const byRec = new Map(existing.map((e) => [e.recommendationId, e]));
  const seenRec = new Set<string>();

  // Cross-recommendation coherence is computed over the FULL current set even
  // when only a subset is being reassessed (conflicts are set-level).
  const allItems = opts.recommendationIds
    ? await prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null } })
    : items;
  const { flags: conflictFlags, replacedByActive } = detectSetConflicts(allItems as unknown as ReasoningItem[]);

  for (const it of items) {
    seenRec.add(it.id);
    const lineage = { recommendationLineageId: (it as { lineageId?: string }).lineageId ?? null, recommendationVersion: (it as { version?: number }).version ?? null, caseVersion };
    try {
      const a = buildReasoningAssessment(it as unknown as ReasoningItem, conds, chronology as unknown as DossierChronoEvent[], dossierCase, interviews as unknown as DossierInterview[], { conflicts: conflictFlags.get(it.id) ?? [], replacedByActive: replacedByActive.has(it.id) });
      const prior = byRec.get(it.id);
      if (!prior) {
        await prisma.clinicalReasoningAssessment.create({ data: { ...toRow(a), ...lineage, caseId, firmId, recommendationId: it.id } });
        continue;
      }
      if (prior.materialHash === a.materialHash && prior.status !== "ERROR" && prior.reasoningChain != null && prior.generatedByModel === "deterministic-reasoning-v2") continue; // cache hit (recompute once per methodology version)

      // Material change (§17): supersede the prior row (preserve it), create a
      // new one, and — when the item was physician-approved — force re-review
      // with an audit trail identifying what changed.
      const wasApproved = it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED";
      const diff = changedFields(prior as unknown as Record<string, unknown>, a);
      const reviewerMetadata = wasApproved
        ? { invalidatedApproval: true, changedFields: diff, priorPhysicianStatus: it.physicianStatus }
        : { invalidatedApproval: false, changedFields: diff };
      const created = await prisma.clinicalReasoningAssessment.create({
        data: {
          ...toRow(a), ...lineage, caseId, firmId, recommendationId: it.id,
          status: wasApproved ? "NEEDS_REVIEW" : toRow(a).status, // never silently carry approval forward
          reviewerMetadata: j(reviewerMetadata),
        },
      });
      await prisma.clinicalReasoningAssessment.update({ where: { id: prior.id }, data: { status: "SUPERSEDED", supersededById: created.id } });
      if (wasApproved) {
        await prisma.auditLog.create({
          data: {
            firmId, caseId, userId: opts.actorUserId ?? null,
            action: "reasoning.approval_invalidated",
            targetType: "clinicalReasoningAssessment", targetId: created.id,
            meta: j({ recommendationId: it.id, service: it.service, changedFields: diff, priorAssessmentId: prior.id }),
          },
        }).catch(() => {}); // audit is best-effort; never blocks the assessment
      }
    } catch (err) {
      // Partial-failure recovery (§19): capture the error on this item's row
      // and keep assessing the rest of the case. ERROR rows are retried on the
      // next run (the cache check above skips only non-ERROR rows).
      const prior = byRec.get(it.id);
      const detail = (err as Error).message?.slice(0, 500) ?? "unknown error";
      if (prior) await prisma.clinicalReasoningAssessment.update({ where: { id: prior.id }, data: { status: "ERROR", errorDetail: detail } }).catch(() => {});
      else await prisma.clinicalReasoningAssessment.create({ data: { caseId, firmId, recommendationId: it.id, recommendationService: it.service, status: "ERROR", errorDetail: detail, ...lineage } }).catch(() => {});
    }
  }

  // Recommendations that no longer exist → supersede their assessment (only on
  // full-case runs; an incremental run cannot know what is missing).
  if (!opts.recommendationIds) {
    for (const e of existing) {
      if (!seenRec.has(e.recommendationId) && e.status !== "SUPERSEDED") {
        await prisma.clinicalReasoningAssessment.update({ where: { id: e.id }, data: { status: "SUPERSEDED" } }).catch(() => {});
      }
    }
  }

  return prisma.clinicalReasoningAssessment.findMany({ where: { caseId, status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "asc" } });
}
