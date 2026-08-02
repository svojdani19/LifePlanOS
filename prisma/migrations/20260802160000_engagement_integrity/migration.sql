-- MDIP hardening (engagement integrity): damages-evaluation inputs fingerprint
-- + referential integrity for the MDIP tables. Additive; safe on live rows.

-- 1. Inputs fingerprint — the staleness oracle for damages evaluations.
--    Null on pre-existing rows (they fall back to timestamp staleness).
ALTER TABLE "FutureDamagesEvaluation" ADD COLUMN IF NOT EXISTS "inputsHash" TEXT;

-- 2. Preflight BEFORE validating the FKs. Never silently delete production
--    rows in a schema migration: fail with an actionable error so an operator
--    can investigate and remediate the exact orphan deliberately.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CaseEngagement" ce LEFT JOIN "Case" c ON c."id" = ce."caseId" WHERE c."id" IS NULL)
    OR EXISTS (SELECT 1 FROM "CaseEngagement" ce LEFT JOIN "Firm" f ON f."id" = ce."firmId" WHERE f."id" IS NULL)
    OR EXISTS (SELECT 1 FROM "Notification" n LEFT JOIN "User" u ON u."id" = n."userId" WHERE u."id" IS NULL)
    OR EXISTS (SELECT 1 FROM "Notification" n LEFT JOIN "Firm" f ON f."id" = n."firmId" WHERE f."id" IS NULL)
    OR EXISTS (SELECT 1 FROM "FutureDamagesEvaluation" e LEFT JOIN "Case" c ON c."id" = e."caseId" WHERE c."id" IS NULL)
    OR EXISTS (SELECT 1 FROM "FutureDamagesEvaluation" e LEFT JOIN "Firm" f ON f."id" = e."firmId" WHERE f."id" IS NULL)
  THEN
    RAISE EXCEPTION 'MDIP integrity preflight found orphan rows. Inspect CaseEngagement, Notification, and FutureDamagesEvaluation before retrying.';
  END IF;
END $$;

-- 3. Foreign keys with ON DELETE CASCADE. Added NOT VALID (no full-table lock
--    while live), then validated after the non-destructive preflight. Raw SQL because the Prisma
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
