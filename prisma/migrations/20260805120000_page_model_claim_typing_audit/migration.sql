-- Page-level source model, claim typing, and adversarial-audit lineage.
-- Additive and reversible: new table + new nullable/defaulted columns only.
-- No existing row loses data; no existing content is marked verified.

CREATE TABLE IF NOT EXISTS "SourcePage" (
  "id" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "pageNumber" INTEGER NOT NULL,
  "text" TEXT NOT NULL DEFAULT '',
  "offsetStart" INTEGER NOT NULL DEFAULT 0,
  "offsetEnd" INTEGER NOT NULL DEFAULT 0,
  "ocrMethod" TEXT NOT NULL DEFAULT 'NONE',
  "ocrConfidence" DOUBLE PRECISION,
  "contentHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READABLE',
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourcePage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SourcePage_sourceDocumentId_pageNumber_key" ON "SourcePage"("sourceDocumentId", "pageNumber");
CREATE INDEX IF NOT EXISTS "SourcePage_caseId_sourceDocumentId_idx" ON "SourcePage"("caseId", "sourceDocumentId");
CREATE INDEX IF NOT EXISTS "SourcePage_firmId_idx" ON "SourcePage"("firmId");
CREATE INDEX IF NOT EXISTS "SourcePage_caseId_status_idx" ON "SourcePage"("caseId", "status");

-- Encounter: verbatim date text, audit outcome, sentence->claim map, and the
-- hash of exactly what a human verified.
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "dateSourceText" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "auditResult" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "auditFindings" JSONB;
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "auditedAt" TIMESTAMP(3);
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "sentenceClaimMap" JSONB;
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "verifiedContentHash" TEXT;

-- Extraction run: multi-pass provenance and page accounting.
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "criticFindings" JSONB;
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "disputedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "adjudicatedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "pagesTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "pagesReadable" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "auditResult" TEXT;

-- NOTE: no backfill marks anything verified or audit-passed. Existing rows
-- keep status AI_DRAFT / HUMAN_EDITED as before; auditResult stays NULL, which
-- the export gate treats as "not audited" and therefore not final-eligible.
