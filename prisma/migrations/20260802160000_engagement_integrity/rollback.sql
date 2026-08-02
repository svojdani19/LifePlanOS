-- Rollback for 20260802160000_engagement_integrity. Deleted orphan rows are
-- not restorable (they referenced vanished parents and were unreachable).
ALTER TABLE "CaseEngagement" DROP CONSTRAINT IF EXISTS "CaseEngagement_caseId_fkey";
ALTER TABLE "CaseEngagement" DROP CONSTRAINT IF EXISTS "CaseEngagement_firmId_fkey";
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_userId_fkey";
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_firmId_fkey";
ALTER TABLE "FutureDamagesEvaluation" DROP CONSTRAINT IF EXISTS "FutureDamagesEvaluation_caseId_fkey";
ALTER TABLE "FutureDamagesEvaluation" DROP CONSTRAINT IF EXISTS "FutureDamagesEvaluation_firmId_fkey";
ALTER TABLE "FutureDamagesEvaluation" DROP COLUMN IF EXISTS "inputsHash";
