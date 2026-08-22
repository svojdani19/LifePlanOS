-- Name the sources that did not answer.
--
-- outcomeFromAttempts reported SUCCEEDED whenever anything was produced, even
-- when half the sources had failed, and retrievalFinding says nothing at all
-- about a SUCCEEDED run. So a case where the literature could only be partly
-- searched read as clean, and the sole trace was a prose detail string that
-- neither the panel nor the report displayed.
--
-- Partial runs are now their own status, and the sources that failed travel as
-- structured data rather than inside a sentence.
--
-- Additive and reversible:
--   ALTER TABLE "RetrievalAttempt" DROP COLUMN "failedSources";
ALTER TABLE "RetrievalAttempt"
  ADD COLUMN IF NOT EXISTS "failedSources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
