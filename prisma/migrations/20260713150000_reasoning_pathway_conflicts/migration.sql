-- Phase B — cross-recommendation coherence, pathway, and alternatives.
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "clinicalPathway" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "conflictFlags" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "alternativesConsidered" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "inclusionRationale" TEXT;
