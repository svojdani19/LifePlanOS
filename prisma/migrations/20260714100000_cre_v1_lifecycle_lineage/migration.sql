-- CRE v1 — assessment lifecycle statuses, lineage/version awareness, condition
-- detail, itemized evidence, literature rejection ledger, reviewer metadata,
-- error capture, and draft exports. Purely additive.
ALTER TYPE "ReasoningStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "ReasoningStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "ReasoningStatus" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';
ALTER TYPE "ReasoningStatus" ADD VALUE IF NOT EXISTS 'VALIDATED';
ALTER TYPE "ReasoningStatus" ADD VALUE IF NOT EXISTS 'INVALID';
ALTER TYPE "ReasoningStatus" ADD VALUE IF NOT EXISTS 'ERROR';
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "recommendationLineageId" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "recommendationVersion" INTEGER;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "caseVersion" INTEGER;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "laterality" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "conditionSeverity" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "conditionChronicity" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "currentClinicalStatus" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "evidenceItems" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "leastIntensiveRationale" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "timingRationale" TEXT;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "rejectedLiterature" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "reviewerMetadata" JSONB;
ALTER TABLE "ClinicalReasoningAssessment" ADD COLUMN "errorDetail" TEXT;
ALTER TABLE "ReportExport" ADD COLUMN "draft" BOOLEAN NOT NULL DEFAULT false;
