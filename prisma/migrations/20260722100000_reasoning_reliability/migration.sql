-- Reasoning Reliability sprint — explainability payload (additive).
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "reasoningChain" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "evidenceSufficiency" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "selfCritique" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "confidenceVector" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "alternativeExplanations" JSONB;
