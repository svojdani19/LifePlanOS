/**
 * One way to assemble a recommendation basis, and one way to read it back.
 *
 * Three call sites build a basis: generation records it, and validation and the
 * report each rebuild one as a staleness witness. Every field they derive has
 * to be derived identically or the hashes disagree and every item reports
 * STALE forever. Leaving that to three copies of the same call was how the
 * basis came to be compared against subtly different rebuilds.
 *
 * This module owns the derivation. It sits above `recommendationBasis` (which
 * may not import the reasoning engine) and above `clinicalReasoning` (which
 * imports the basis type), so it is the one place both can be combined.
 */

import {
  buildBasis,
  type BasisRecord,
  type MaterialAssessment,
} from "@/lib/engine/recommendationBasis";
import {
  deriveWitnessAssessment,
  type ReasoningAssessment,
  type ReasoningItem,
  type SetContext,
} from "@/lib/engine/clinicalReasoning";
import type { CondInput } from "@/lib/engine/integrity";
import type { EvidenceRowIdentity } from "@/lib/engine/evidenceSet";
import type {
  RecommendationDossier,
  DossierItem,
  DossierCondition,
  DossierChronoEvent,
  DossierCase,
  DossierInterview,
} from "@/lib/engine/medicalNecessity";

/**
 * The material conclusions of an assessment, for recording.
 *
 * Only the fields that are CONCLUSIONS. Live workflow state — conflict flags,
 * physician review position, validation and lifecycle status — is deliberately
 * excluded: freezing those would make the panel show a stale workflow, and
 * their divergence is already caught by the specification basis.
 */
export function materialFrom(a: ReasoningAssessment, dossier: RecommendationDossier): MaterialAssessment {
  return {
    probabilityClassification: a.probabilityClassification,
    inclusionRationale: a.inclusionRationale,
    inclusionInTotalsStatus: a.inclusionInTotalsStatus,
    costEligibilityStatus: a.costEligibilityStatus,
    frequencyRationale: a.frequencyRationale,
    frequencySupported: a.frequencySupported,
    durationClass: a.durationClass,
    durationRationale: a.durationRationale,
    durationSupported: a.durationSupport.clinicallySupported,
    durationBasisLabel: a.durationSupport.bases[0]?.kind ?? null,
    evidenceStrength: a.evidenceStrength,
    recommendationConfidence: a.recommendationConfidence,
    confidenceExplanation: a.confidenceExplanation,
    residualUncertainty: a.residualUncertainty,
    medicalNecessityRationale: a.medicalNecessityRationale,
    noTreatmentRisk: a.noTreatmentRisk,
    leastIntensiveRationale: a.leastIntensiveRationale,
    timingRationale: a.timingRationale,
    clinicalPurpose: a.clinicalPurpose,
    responsibleSpecialty: a.responsibleSpecialty,
    bodyRegion: a.bodyRegion,
    laterality: a.laterality,
    conditionSeverity: a.conditionSeverity,
    conditionChronicity: a.conditionChronicity,
    currentClinicalStatus: a.currentClinicalStatus,
    conditionTrajectory: a.conditionTrajectory,
    causalRelationshipStatus: a.causalRelationshipStatus,
    clinicalPathway: a.clinicalPathway,
    clinicalPathwayStage: a.clinicalPathwayStage,
    objectiveEvidenceSummary: a.objectiveEvidenceSummary,
    subjectiveEvidenceSummary: a.subjectiveEvidenceSummary,
    functionalBasisSummary: a.functionalBasisSummary,
    priorTreatmentSummary: a.priorTreatmentSummary,
    treatmentResponseSummary: a.treatmentResponseSummary,
    treatingRecordSupportSummary: a.treatingRecordSupportSummary,
    literatureSynthesis: a.literatureSynthesis,
    alternativesConsidered: a.alternativesConsidered.map((x) => ({ alternative: x.alternative, rationale: x.rationale })),
    supportingGuidelineAssessments: a.supportingGuidelineAssessments.map((g) => ({
      title: g.title,
      claim: g.claim,
      // Provenance travels with the entry and is hashed with it, so guidance
      // cannot be promoted to verified without staling the basis.
      provenance: g.provenance,
      verifiedBy: g.verifiedBy ?? null,
      verifiedAt: g.verifiedAt ?? null,
    })),
    missingEvidenceRequests: [...a.missingEvidenceRequests],
    potentialChallenges: [...dossier.potentialChallenges],
    functionalBasis: dossier.functionalLink
      ? {
          domain: dossier.functionalLink.domain,
          limitation: dossier.functionalLink.limitation,
          source: dossier.functionalLink.source ?? null,
          quantified: !!dossier.functionalLink.quantified,
          relationship: dossier.functionalLink.relationship,
        }
      : null,
    confidenceLevel: dossier.confidence.level,
    confidenceLevelExplanation: dossier.confidence.explanation,
  };
}

export interface AssembleInput {
  item: DossierItem & { id?: string | null; lineageId?: string | null; supportClass?: string | null; supportReason?: string | null; pricedAt?: Date | string | null };
  dossier: RecommendationDossier;
  conditions: (CondInput & DossierCondition & { id: string })[];
  chronology: DossierChronoEvent[];
  kase: DossierCase;
  interviews?: DossierInterview[];
  setContext?: SetContext;
  handEnteredEvidence?: readonly EvidenceRowIdentity[];
  assumptions?: {
    lifeExpectancyYears?: number | null;
    discountRate?: number | null;
    medicalInflation?: number | null;
    geographicFactor?: number | null;
    pricedAt?: string | null;
    conditionName?: string | null;
  } | null;
}

/**
 * Derive a complete basis for one item from the CURRENT record.
 *
 * At generation this is the record being made. At validation and export it is
 * the witness — the same derivation, so a hash mismatch means the case changed
 * and never means the two callers computed it differently.
 */
export function assembleBasis(input: AssembleInput): BasisRecord {
  const witness = deriveWitnessAssessment(
    input.item as unknown as ReasoningItem,
    input.conditions,
    input.chronology,
    input.kase,
    {
      interviews: input.interviews,
      setContext: input.setContext,
      handEnteredEvidence: input.handEnteredEvidence,
    },
  );
  return buildBasis(input.item, input.dossier, input.assumptions, materialFrom(witness, input.dossier));
}
