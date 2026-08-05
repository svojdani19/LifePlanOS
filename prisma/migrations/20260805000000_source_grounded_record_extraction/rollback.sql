-- Rollback: source-grounded record extraction (additive objects only).
-- Note: rolling back discards extraction runs, validated encounters, review
-- lineage on chronology events, and correction exemplars. Human EDITS to
-- chronology events themselves are NOT lost (the legacy `edited` flag and the
-- edited field values live on the base row and are untouched).
DROP TABLE IF EXISTS "CorrectionExemplar";
DROP TABLE IF EXISTS "ExtractedEncounter";
DROP TABLE IF EXISTS "RecordExtraction";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "reviewStatus";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "reviewedById";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "reviewedAt";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "verifiedById";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "verifiedAt";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "supersededById";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "staleReason";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "sourceFingerprint";
ALTER TABLE "ChronologyEvent" DROP COLUMN IF EXISTS "extractionId";
