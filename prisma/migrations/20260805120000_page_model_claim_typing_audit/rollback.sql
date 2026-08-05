-- Rollback: page model, claim typing, and audit lineage.
--
-- Rolling back DISCARDS: per-page source records (SourcePage), adversarial
-- audit outcomes, sentence->claim maps, verified content hashes, and
-- multi-pass run provenance.
--
-- Rolling back does NOT lose: documents, extracted encounters and their
-- claims, chronology events, human edits, review/verification status, reports,
-- exports, or audit events — all of which live in columns this migration did
-- not touch.
--
-- After rollback the export gate loses its audit and hash checks; a
-- corresponding application rollback is required, or final exports will fall
-- back to the previous (weaker) factual-review gate.

DROP TABLE IF EXISTS "SourcePage";

ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "dateSourceText";
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "auditResult";
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "auditFindings";
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "auditedAt";
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "sentenceClaimMap";
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "verifiedContentHash";

ALTER TABLE "RecordExtraction" DROP COLUMN IF EXISTS "criticFindings";
ALTER TABLE "RecordExtraction" DROP COLUMN IF EXISTS "disputedCount";
ALTER TABLE "RecordExtraction" DROP COLUMN IF EXISTS "adjudicatedCount";
ALTER TABLE "RecordExtraction" DROP COLUMN IF EXISTS "pagesTotal";
ALTER TABLE "RecordExtraction" DROP COLUMN IF EXISTS "pagesReadable";
ALTER TABLE "RecordExtraction" DROP COLUMN IF EXISTS "auditResult";
