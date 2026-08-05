-- Source-grounded record extraction (additive, reversible).
-- New tables: RecordExtraction (per-document extraction runs with provenance),
-- ExtractedEncounter (validated, claim-cited encounters with review lineage),
-- CorrectionExemplar (firm-scoped verified-correction learning).
-- ChronologyEvent gains review-lineage columns; existing rows keep their data
-- and default to AI_DRAFT (legacy human edits stay marked via `edited` and are
-- backfilled to HUMAN_EDITED — never auto-verified).

CREATE TABLE IF NOT EXISTS "RecordExtraction" (
  "id" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "provider" TEXT,
  "model" TEXT,
  "promptVersion" TEXT,
  "schemaVersion" TEXT,
  "sourceFingerprint" TEXT,
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "acceptedCount" INTEGER NOT NULL DEFAULT 0,
  "rejectedCount" INTEGER NOT NULL DEFAULT 0,
  "warnings" JSONB,
  "error" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecordExtraction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RecordExtraction_caseId_sourceDocumentId_idx" ON "RecordExtraction"("caseId", "sourceDocumentId");
CREATE INDEX IF NOT EXISTS "RecordExtraction_firmId_idx" ON "RecordExtraction"("firmId");

CREATE TABLE IF NOT EXISTS "ExtractedEncounter" (
  "id" TEXT NOT NULL,
  "extractionId" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "page" INTEGER,
  "pageEnd" INTEGER,
  "dateStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "encounterDate" TIMESTAMP(3),
  "encounterDateEnd" TIMESTAMP(3),
  "provider" TEXT,
  "providerCredentials" TEXT,
  "facility" TEXT,
  "encounterType" TEXT,
  "factualSummary" TEXT NOT NULL,
  "synthesis" TEXT,
  "claims" JSONB NOT NULL,
  "ocrConfidence" DOUBLE PRECISION,
  "warnings" JSONB,
  "status" TEXT NOT NULL DEFAULT 'AI_DRAFT',
  "editedFields" JSONB,
  "reviewNote" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "supersededById" TEXT,
  "staleReason" TEXT,
  "sourceFingerprint" TEXT,
  "promptVersion" TEXT,
  "schemaVersion" TEXT,
  "model" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExtractedEncounter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ExtractedEncounter_caseId_sourceDocumentId_idx" ON "ExtractedEncounter"("caseId", "sourceDocumentId");
CREATE INDEX IF NOT EXISTS "ExtractedEncounter_caseId_status_idx" ON "ExtractedEncounter"("caseId", "status");
CREATE INDEX IF NOT EXISTS "ExtractedEncounter_firmId_idx" ON "ExtractedEncounter"("firmId");

CREATE TABLE IF NOT EXISTS "CorrectionExemplar" (
  "id" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "encounterId" TEXT NOT NULL,
  "documentType" TEXT,
  "category" TEXT NOT NULL,
  "guidance" TEXT NOT NULL,
  "fieldDiffs" JSONB NOT NULL,
  "draftSnapshot" JSONB NOT NULL,
  "correctedSnapshot" JSONB NOT NULL,
  "claimRefs" JSONB,
  "reviewerId" TEXT NOT NULL,
  "promptVersion" TEXT,
  "schemaVersion" TEXT,
  "model" TEXT,
  "promoted" BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CorrectionExemplar_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CorrectionExemplar_firmId_documentType_idx" ON "CorrectionExemplar"("firmId", "documentType");
CREATE INDEX IF NOT EXISTS "CorrectionExemplar_caseId_idx" ON "CorrectionExemplar"("caseId");

ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT NOT NULL DEFAULT 'AI_DRAFT';
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "reviewedById" TEXT;
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "verifiedById" TEXT;
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "supersededById" TEXT;
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "staleReason" TEXT;
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "sourceFingerprint" TEXT;
ALTER TABLE "ChronologyEvent" ADD COLUMN IF NOT EXISTS "extractionId" TEXT;

-- Conservative backfill: a legacy human-edited event is HUMAN_EDITED, never
-- auto-verified. Untouched legacy rows remain AI_DRAFT.
UPDATE "ChronologyEvent" SET "reviewStatus" = 'HUMAN_EDITED' WHERE "edited" = true AND "reviewStatus" = 'AI_DRAFT';
