-- Extraction run lifecycle: a run row exists from the moment work starts, one
-- unfinished run per document, and enough durable state to resume a paused run.
-- Additive only: every column is nullable or defaulted, so existing rows keep
-- their meaning (a historical row simply has no lifecycle timestamps).

ALTER TABLE "RecordExtraction" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "RecordExtraction" ADD COLUMN "finishedAt" TIMESTAMP(3);
ALTER TABLE "RecordExtraction" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "RecordExtraction" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "RecordExtraction" ADD COLUMN "chunksTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordExtraction" ADD COLUMN "chunksDone" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RecordExtraction" ADD COLUMN "resumeState" JSONB;
ALTER TABLE "RecordExtraction" ADD COLUMN "telemetry" JSONB;
ALTER TABLE "RecordExtraction" ADD COLUMN "lockKey" TEXT;

-- Conservative backfill: rows that already reached a terminal state are
-- finished, and their creation time is the only start time on record. Nothing
-- is invented for rows in any other state.
UPDATE "RecordExtraction"
   SET "startedAt" = "createdAt",
       "finishedAt" = "createdAt"
 WHERE "status" IN ('COMPLETE', 'EXTRACTION_FAILED', 'BLOCKED_OCR');

-- One unfinished run per document. lockKey is NULL on every finished run and
-- Postgres treats NULLs as distinct, so this constrains only live runs.
CREATE UNIQUE INDEX "RecordExtraction_sourceDocumentId_lockKey_key"
    ON "RecordExtraction"("sourceDocumentId", "lockKey");

CREATE INDEX "RecordExtraction_status_heartbeatAt_idx"
    ON "RecordExtraction"("status", "heartbeatAt");
