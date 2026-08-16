-- Finding-lifecycle safety.
--
-- Two pieces of evidence a deterministic re-audit needs and did not have:
--
--   1. RecordExtraction.failedSections — the count of chunks that could not be
--      processed. It existed only as a local variable during the run, so a
--      later re-audit read zero and could resolve a SECTION_NOT_PROCESSED
--      finding it had no ability to reproduce.
--
--   2. RecordFinding.dispositionSourceFingerprint / dispositionHistory — a
--      human dismissal covers the content it was given over. Without the
--      fingerprint the dismissal was carried forward across source changes as
--      if it still applied; without the history, reopening one would have
--      destroyed the human decision instead of preserving it.
--
-- Additive and reversible:
--   ALTER TABLE "RecordExtraction" DROP COLUMN "failedSections";
--   ALTER TABLE "RecordFinding" DROP COLUMN "dispositionSourceFingerprint";
--   ALTER TABLE "RecordFinding" DROP COLUMN "dispositionHistory";
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "failedSections" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordFinding" ADD COLUMN IF NOT EXISTS "dispositionSourceFingerprint" TEXT;
ALTER TABLE "RecordFinding" ADD COLUMN IF NOT EXISTS "dispositionHistory" JSONB;
