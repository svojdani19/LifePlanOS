-- Clinical Reasoning Engine (Phase A): persisted per-recommendation reasoning.
CREATE TYPE "ReasoningStatus" AS ENUM ('NEEDS_REASONING_REVIEW', 'ASSESSED', 'SUPERSEDED');
CREATE TYPE "ProbabilityClassification" AS ENUM ('PROBABLE_INCLUDED', 'CONDITIONAL_STAGED', 'POSSIBLE_CONTINGENCY_NOT_INCLUDED', 'INSUFFICIENTLY_SUPPORTED', 'NOT_RECOMMENDED', 'REJECTED_BY_REVIEWER');
CREATE TYPE "EvidenceStrength" AS ENUM ('STRONG', 'MODERATE', 'LIMITED', 'EXPERT_CONSENSUS', 'INSUFFICIENT');
CREATE TYPE "RecommendationConfidence" AS ENUM ('HIGH', 'MODERATE', 'LOW', 'INDETERMINATE');
CREATE TABLE "ClinicalReasoningAssessment" (
  "id" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "recommendationId" TEXT NOT NULL,
  "recommendationService" TEXT NOT NULL,
  "status" "ReasoningStatus" NOT NULL DEFAULT 'NEEDS_REASONING_REVIEW',
  "supportingDiagnosisIds" JSONB,
  "bodyRegion" TEXT,
  "responsibleSpecialty" TEXT,
  "conditionTrajectory" TEXT,
  "causalRelationshipStatus" TEXT,
  "clinicalPurpose" TEXT,
  "objectiveEvidenceSummary" TEXT,
  "subjectiveEvidenceSummary" TEXT,
  "functionalBasisSummary" TEXT,
  "priorTreatmentSummary" TEXT,
  "treatmentResponseSummary" TEXT,
  "treatingRecordSupportSummary" TEXT,
  "medicalNecessityRationale" TEXT,
  "noTreatmentRisk" TEXT,
  "probabilityClassification" "ProbabilityClassification" NOT NULL DEFAULT 'INSUFFICIENTLY_SUPPORTED',
  "clinicalPathwayStage" TEXT,
  "frequencyRationale" TEXT,
  "frequencySupported" BOOLEAN NOT NULL DEFAULT false,
  "durationClass" TEXT,
  "durationRationale" TEXT,
  "weakeningEvidence" JSONB,
  "unknowns" JSONB,
  "missingEvidenceRequests" JSONB,
  "supportingGuidelineAssessments" JSONB,
  "supportingLiteratureAssessments" JSONB,
  "evidenceStrength" "EvidenceStrength" NOT NULL DEFAULT 'INSUFFICIENT',
  "recommendationConfidence" "RecommendationConfidence" NOT NULL DEFAULT 'INDETERMINATE',
  "confidenceExplanation" TEXT,
  "costEligibilityStatus" TEXT,
  "inclusionInTotalsStatus" TEXT,
  "physicianReviewStatus" TEXT,
  "validationStatus" TEXT,
  "materialHash" TEXT,
  "generatedByModel" TEXT,
  "supersededById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClinicalReasoningAssessment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClinicalReasoningAssessment_caseId_idx" ON "ClinicalReasoningAssessment"("caseId");
CREATE INDEX "ClinicalReasoningAssessment_firmId_idx" ON "ClinicalReasoningAssessment"("firmId");
CREATE INDEX "ClinicalReasoningAssessment_caseId_recommendationId_idx" ON "ClinicalReasoningAssessment"("caseId", "recommendationId");
ALTER TABLE "ClinicalReasoningAssessment" ADD CONSTRAINT "ClinicalReasoningAssessment_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClinicalReasoningAssessment" ADD CONSTRAINT "ClinicalReasoningAssessment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
