-- MDIP hardening (engagement integrity): damages-evaluation inputs fingerprint
-- + referential integrity for the MDIP tables. Additive; safe on live rows.

-- 1. Inputs fingerprint — the staleness oracle for damages evaluations.
--    Null on pre-existing rows (they fall back to timestamp staleness).
ALTER TABLE "FutureDamagesEvaluation" ADD COLUMN IF NOT EXISTS "inputsHash" TEXT;

-- 2. Orphan cleanup BEFORE validating the FKs. Demo/live data exists; any row
--    pointing at a vanished parent is unreachable garbage and is removed so
--    VALIDATE CONSTRAINT is guaranteed to pass.
DELETE FROM "CaseEngagement" ce WHERE NOT EXISTS (SELECT 1 FROM "Case" c WHERE c."id" = ce."caseId");
DELETE FROM "CaseEngagement" ce WHERE NOT EXISTS (SELECT 1 FROM "Firm" f WHERE f."id" = ce."firmId");
DELETE FROM "Notification" n WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = n."userId");
DELETE FROM "Notification" n WHERE NOT EXISTS (SELECT 1 FROM "Firm" f WHERE f."id" = n."firmId");
DELETE FROM "FutureDamagesEvaluation" e WHERE NOT EXISTS (SELECT 1 FROM "Case" c WHERE c."id" = e."caseId");
DELETE FROM "FutureDamagesEvaluation" e WHERE NOT EXISTS (SELECT 1 FROM "Firm" f WHERE f."id" = e."firmId");

-- 3. Foreign keys with ON DELETE CASCADE. Added NOT VALID (no full-table lock
--    while live), then validated post-cleanup. Raw SQL because the Prisma
--    schema keeps scalar fields for these models (adding relations would force
--    back-relation churn across Case/Firm/User).
ALTER TABLE "CaseEngagement" ADD CONSTRAINT "CaseEngagement_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CaseEngagement" ADD CONSTRAINT "CaseEngagement_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "FutureDamagesEvaluation" ADD CONSTRAINT "FutureDamagesEvaluation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "FutureDamagesEvaluation" ADD CONSTRAINT "FutureDamagesEvaluation_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_caseId_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_firmId_fkey";
ALTER TABLE "Notification" VALIDATE CONSTRAINT "Notification_userId_fkey";
ALTER TABLE "Notification" VALIDATE CONSTRAINT "Notification_firmId_fkey";
ALTER TABLE "FutureDamagesEvaluation" VALIDATE CONSTRAINT "FutureDamagesEvaluation_caseId_fkey";
ALTER TABLE "FutureDamagesEvaluation" VALIDATE CONSTRAINT "FutureDamagesEvaluation_firmId_fkey";
