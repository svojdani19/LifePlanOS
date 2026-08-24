-- Plan-generation mutual exclusion, and the uniqueness of a diagnosis on a case.
--
-- Why: `generatePlan` snapshots the prior plan, clears it, then spends seconds
-- locating evidence before writing the replacement. Three call sites fire it in
-- the background when a records reviewer publishes a corrected note, and
-- nothing serialized them. Overlapping runs whose resets all landed before any
-- of their writes each wrote a full plan, leaving one case holding every
-- diagnosis and every care item three times over.

-- 1. The lock itself. A single conditional UPDATE on this row is what makes the
--    claim atomic; Postgres serializes concurrent updates to the same row.
ALTER TABLE "Case" ADD COLUMN "pipelineRunId" TEXT;
ALTER TABLE "Case" ADD COLUMN "pipelineRunAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN "pipelineRerunRequested" BOOLEAN NOT NULL DEFAULT false;

-- 2. Repair the duplicate Condition rows already written, so the unique index
--    below can be built.
--
--    Survivor per (case, normalised name): a physician-confirmed row first —
--    that is a person's assertion and it must not be the copy that disappears —
--    then the earliest, so the id downstream rows already point at is the one
--    that stays wherever possible.
CREATE TEMPORARY TABLE "_condition_survivor" AS
SELECT DISTINCT ON ("caseId", lower(btrim("name")))
       "id" AS "keepId", "caseId", lower(btrim("name")) AS "normName"
FROM "Condition"
ORDER BY "caseId", lower(btrim("name")), "physicianConfirmed" DESC, "createdAt" ASC, "id" ASC;

--    Repoint care items at the survivor before anything is deleted. Without
--    this the FK's ON DELETE SET NULL would quietly strip the diagnosis link
--    off every item that happened to reference a losing copy.
UPDATE "FutureCareItem" f
SET "conditionId" = s."keepId"
FROM "Condition" c
JOIN "_condition_survivor" s
  ON s."caseId" = c."caseId" AND s."normName" = lower(btrim(c."name"))
WHERE f."conditionId" = c."id"
  AND c."id" <> s."keepId";

DELETE FROM "Condition" c
USING "_condition_survivor" s
WHERE s."caseId" = c."caseId"
  AND s."normName" = lower(btrim(c."name"))
  AND c."id" <> s."keepId";

DROP TABLE "_condition_survivor";

-- 3. The invariant, now enforceable.
CREATE UNIQUE INDEX "Condition_caseId_name_key" ON "Condition"("caseId", "name");
