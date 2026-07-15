-- Rollback for CRE v1 migration. The migration is purely additive; rolling back
-- drops only the new columns (enum values are harmless if left in place —
-- PostgreSQL cannot drop enum values without a type rebuild, and no code path
-- writes them after rollback).
ALTER TABLE "ClinicalReasoningAssessment"
  DROP COLUMN IF EXISTS "recommendationLineageId",
  DROP COLUMN IF EXISTS "recommendationVersion",
  DROP COLUMN IF EXISTS "caseVersion",
  DROP COLUMN IF EXISTS "laterality",
  DROP COLUMN IF EXISTS "conditionSeverity",
  DROP COLUMN IF EXISTS "conditionChronicity",
  DROP COLUMN IF EXISTS "currentClinicalStatus",
  DROP COLUMN IF EXISTS "evidenceItems",
  DROP COLUMN IF EXISTS "leastIntensiveRationale",
  DROP COLUMN IF EXISTS "timingRationale",
  DROP COLUMN IF EXISTS "rejectedLiterature",
  DROP COLUMN IF EXISTS "reviewerMetadata",
  DROP COLUMN IF EXISTS "errorDetail";
ALTER TABLE "ReportExport" DROP COLUMN IF EXISTS "draft";
