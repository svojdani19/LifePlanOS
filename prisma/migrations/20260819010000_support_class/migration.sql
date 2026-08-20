-- Item-specific support classification, replacing hasPatientRecordSupport().
--
-- That function returned true when the matched CONDITION carried records — so a
-- lumbar diagnosis supported lumbar visits, therapy, imaging, injections and
-- braces alike ($518,879 of present value on the reference case) — or, failing
-- that, when confidence >= 60, a bar the care library clears by default at 75
-- before any case evidence exists.
--
-- Defaults to CANDIDATE_REVIEW: a row written before this column existed is
-- disclosed for review rather than silently counted in the headline total.
-- Failing closed is the whole point of the column.
--
-- Additive and reversible:
--   ALTER TABLE "FutureCareItem" DROP COLUMN "supportClass", DROP COLUMN "supportReason";
ALTER TABLE "FutureCareItem"
  ADD COLUMN IF NOT EXISTS "supportClass" TEXT NOT NULL DEFAULT 'CANDIDATE_REVIEW',
  ADD COLUMN IF NOT EXISTS "supportReason" TEXT;

CREATE INDEX IF NOT EXISTS "FutureCareItem_caseId_supportClass_idx" ON "FutureCareItem"("caseId", "supportClass");
