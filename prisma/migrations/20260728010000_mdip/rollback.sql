DROP TABLE IF EXISTS "Notification";
DROP TABLE IF EXISTS "CaseEngagement";
DROP TABLE IF EXISTS "FutureDamagesEvaluation";
ALTER TABLE "User" DROP COLUMN IF EXISTS "preferredWorkspace";
ALTER TABLE "Firm" DROP COLUMN IF EXISTS "isDemo";
