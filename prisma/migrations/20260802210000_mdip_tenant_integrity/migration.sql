-- Complete MDIP referential and tenant-boundary integrity. This migration is
-- deliberately non-destructive: existing bad rows stop deployment and must be
-- investigated; nothing is repaired or deleted automatically.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CaseEngagement" e
    LEFT JOIN "Case" c ON c."id" = e."caseId"
    LEFT JOIN "User" requester ON requester."id" = e."requestedById"
    WHERE c."id" IS NULL OR requester."id" IS NULL
       OR c."firmId" <> e."firmId" OR requester."firmId" <> e."firmId"
  ) OR EXISTS (
    SELECT 1 FROM "FutureDamagesEvaluation" e
    LEFT JOIN "Case" c ON c."id" = e."caseId"
    LEFT JOIN "User" evaluator ON evaluator."id" = e."evaluatedById"
    WHERE c."id" IS NULL OR evaluator."id" IS NULL
       OR c."firmId" <> e."firmId" OR evaluator."firmId" <> e."firmId"
  ) OR EXISTS (
    SELECT 1 FROM "Notification" n
    LEFT JOIN "User" u ON u."id" = n."userId"
    LEFT JOIN "Case" c ON c."id" = n."caseId"
    WHERE u."id" IS NULL OR u."firmId" <> n."firmId"
       OR (n."caseId" IS NOT NULL AND (c."id" IS NULL OR c."firmId" <> n."firmId"))
  ) THEN
    RAISE EXCEPTION 'MDIP tenant-integrity preflight failed. Inspect cross-tenant or orphan engagement, evaluation, or notification rows.';
  END IF;

  IF EXISTS (
    SELECT "firmId", "caseId" FROM "FutureDamagesEvaluation"
    WHERE "isStale" = false
    GROUP BY "firmId", "caseId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple current FutureDamagesEvaluation rows exist for a case. Resolve them before retrying.';
  END IF;
END $$;

ALTER TABLE "FutureDamagesEvaluation"
  ADD CONSTRAINT "FutureDamagesEvaluation_evaluatedById_fkey"
  FOREIGN KEY ("evaluatedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "CaseEngagement"
  ADD CONSTRAINT "CaseEngagement_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CaseEngagement_authorizedById_fkey"
  FOREIGN KEY ("authorizedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CaseEngagement_assignedPlannerId_fkey"
  FOREIGN KEY ("assignedPlannerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CaseEngagement_assignedPhysicianId_fkey"
  FOREIGN KEY ("assignedPhysicianId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CaseEngagement_assignedVocationalExpertId_fkey"
  FOREIGN KEY ("assignedVocationalExpertId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CaseEngagement_assignedEconomistId_fkey"
  FOREIGN KEY ("assignedEconomistId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "CaseEngagement_assignedQaReviewerId_fkey"
  FOREIGN KEY ("assignedQaReviewerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "FutureDamagesEvaluation" VALIDATE CONSTRAINT "FutureDamagesEvaluation_evaluatedById_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_requestedById_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_authorizedById_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_assignedPlannerId_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_assignedPhysicianId_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_assignedVocationalExpertId_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_assignedEconomistId_fkey";
ALTER TABLE "CaseEngagement" VALIDATE CONSTRAINT "CaseEngagement_assignedQaReviewerId_fkey";
ALTER TABLE "Notification" VALIDATE CONSTRAINT "Notification_caseId_fkey";

CREATE UNIQUE INDEX "FutureDamagesEvaluation_one_current_per_case"
  ON "FutureDamagesEvaluation"("firmId", "caseId")
  WHERE "isStale" = false;

CREATE OR REPLACE FUNCTION lifeplanos_check_mdip_tenant_boundary()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked_firm TEXT;
  linked_user TEXT;
  candidate TEXT;
BEGIN
  IF TG_TABLE_NAME IN ('CaseEngagement', 'FutureDamagesEvaluation') THEN
    SELECT "firmId" INTO linked_firm FROM "Case" WHERE "id" = NEW."caseId";
    IF linked_firm IS DISTINCT FROM NEW."firmId" THEN
      RAISE EXCEPTION 'Tenant mismatch: %.caseId is not owned by firmId', TG_TABLE_NAME;
    END IF;
  ELSIF TG_TABLE_NAME = 'Notification' AND NEW."caseId" IS NOT NULL THEN
    SELECT "firmId" INTO linked_firm FROM "Case" WHERE "id" = NEW."caseId";
    IF linked_firm IS DISTINCT FROM NEW."firmId" THEN
      RAISE EXCEPTION 'Tenant mismatch: Notification.caseId is not owned by firmId';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'FutureDamagesEvaluation' THEN
    SELECT "firmId" INTO linked_user FROM "User" WHERE "id" = NEW."evaluatedById";
    IF linked_user IS DISTINCT FROM NEW."firmId" THEN
      RAISE EXCEPTION 'Tenant mismatch: FutureDamagesEvaluation.evaluatedById is not owned by firmId';
    END IF;
  ELSIF TG_TABLE_NAME = 'Notification' THEN
    SELECT "firmId" INTO linked_user FROM "User" WHERE "id" = NEW."userId";
    IF linked_user IS DISTINCT FROM NEW."firmId" THEN
      RAISE EXCEPTION 'Tenant mismatch: Notification.userId is not owned by firmId';
    END IF;
  ELSIF TG_TABLE_NAME = 'CaseEngagement' THEN
    FOREACH candidate IN ARRAY ARRAY[
      NEW."requestedById", NEW."authorizedById", NEW."assignedPlannerId",
      NEW."assignedPhysicianId", NEW."assignedVocationalExpertId",
      NEW."assignedEconomistId", NEW."assignedQaReviewerId"
    ] LOOP
      IF candidate IS NOT NULL THEN
        SELECT "firmId" INTO linked_user FROM "User" WHERE "id" = candidate;
        IF linked_user IS DISTINCT FROM NEW."firmId" THEN
          RAISE EXCEPTION 'Tenant mismatch: CaseEngagement user is not owned by firmId';
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CaseEngagement_tenant_boundary"
  BEFORE INSERT OR UPDATE ON "CaseEngagement"
  FOR EACH ROW EXECUTE FUNCTION lifeplanos_check_mdip_tenant_boundary();
CREATE TRIGGER "FutureDamagesEvaluation_tenant_boundary"
  BEFORE INSERT OR UPDATE ON "FutureDamagesEvaluation"
  FOR EACH ROW EXECUTE FUNCTION lifeplanos_check_mdip_tenant_boundary();
CREATE TRIGGER "Notification_tenant_boundary"
  BEFORE INSERT OR UPDATE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION lifeplanos_check_mdip_tenant_boundary();
