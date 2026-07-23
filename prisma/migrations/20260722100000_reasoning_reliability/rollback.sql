ALTER TABLE "ClinicalReasoningAssessment"
  DROP COLUMN IF EXISTS "reasoningChain",
  DROP COLUMN IF EXISTS "evidenceSufficiency",
  DROP COLUMN IF EXISTS "selfCritique",
  DROP COLUMN IF EXISTS "confidenceVector",
  DROP COLUMN IF EXISTS "alternativeExplanations";
