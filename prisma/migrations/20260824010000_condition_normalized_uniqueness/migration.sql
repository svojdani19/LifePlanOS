-- Make the durable invariant match the key the cleanup actually normalized by.
--
-- `20260824000000_pipeline_run_lock` deduplicated conditions on the SEMANTIC
-- key the generator's own in-run guard uses —
--
--     const key = data.name.trim().toLowerCase();
--
-- — but then enforced the result with a plain
--
--     CREATE UNIQUE INDEX ... ON "Condition"("caseId", "name");
--
-- Those are different keys. Postgres compares text case-sensitively and counts
-- leading and trailing spaces, so the index admits exactly the rows the cleanup
-- had just declared duplicates: "Low back pain" alongside "low back pain", or
-- " Chronic pain syndrome" alongside "Chronic pain syndrome". A concurrent
-- writer that produced either variant would satisfy the constraint and put the
-- same diagnosis on the causation map twice — the defect the index exists to
-- make impossible.
--
-- Postgres supports a unique index over an expression, so the constraint can be
-- stated on the normalized key directly. Prisma's schema language cannot
-- express one, which is why this is hand-written SQL and why schema.prisma
-- carries a comment pointing here.
--
-- Case-scoped throughout, and therefore tenant-scoped: every Condition belongs
-- to exactly one Case, and Case carries firmId.

-- 1. Re-run the same normalization the previous migration applied. It is a
--    no-op on a database that migration already cleaned, and it is REQUIRED on
--    one where a case-variant duplicate slipped in through the weaker index
--    between the two migrations — without it, the index below cannot build.
CREATE TEMPORARY TABLE "_condition_survivor_norm" AS
SELECT DISTINCT ON ("caseId", lower(btrim("name")))
       "id" AS "keepId", "caseId", lower(btrim("name")) AS "normName"
FROM "Condition"
ORDER BY "caseId", lower(btrim("name")), "physicianConfirmed" DESC, "createdAt" ASC, "id" ASC;

--    Repoint care items at the survivor before anything is deleted, so the
--    FK's ON DELETE SET NULL cannot silently strip a diagnosis link.
UPDATE "FutureCareItem" f
SET "conditionId" = s."keepId"
FROM "Condition" c
JOIN "_condition_survivor_norm" s
  ON s."caseId" = c."caseId" AND s."normName" = lower(btrim(c."name"))
WHERE f."conditionId" = c."id"
  AND c."id" <> s."keepId";

DELETE FROM "Condition" c
USING "_condition_survivor_norm" s
WHERE s."caseId" = c."caseId"
  AND s."normName" = lower(btrim(c."name"))
  AND c."id" <> s."keepId";

DROP TABLE "_condition_survivor_norm";

-- 2. Existing valid data is PRESERVED, not rewritten. The stored `name` keeps
--    the capitalisation a clinician reads; only the constraint is normalized.

-- 3. Replace the case-sensitive index with the normalized one.
--    Dropped first: keeping both would reject nothing extra and would cost a
--    second index write on every condition insert.
DROP INDEX IF EXISTS "Condition_caseId_name_key";

CREATE UNIQUE INDEX "Condition_caseId_name_normalized_key"
  ON "Condition" ("caseId", lower(btrim("name")));
