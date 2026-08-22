-- Record what actually happened on each best-effort enrichment pass.
--
-- generateStandardOfCare() and enrichCitations() were called as
-- `.catch(() => {})` and each returned 0 in three unrelated situations: the
-- network probe said offline so nothing was queried, the search ran and the
-- literature had nothing, and the attempt threw. Afterwards the three were
-- indistinguishable, and the report renders the same sentence for all of them
-- — "no guideline located" — which is a claim about the medicine that only the
-- middle case supports.
--
-- One row per (case, producer), holding the LATEST attempt. History is not kept
-- here on purpose: the question this table answers is "is what the plan says
-- about absence true right now", and a superseded attempt cannot answer it.
--
-- Additive and reversible:
--   DROP TABLE "RetrievalAttempt";
CREATE TABLE IF NOT EXISTS "RetrievalAttempt" (
  "id"              TEXT         NOT NULL,
  "caseId"          TEXT         NOT NULL,
  "firmId"          TEXT         NOT NULL,
  "producer"        TEXT         NOT NULL,
  "producerVersion" TEXT         NOT NULL,
  "status"          TEXT         NOT NULL,
  "failure"         TEXT,
  "detail"          TEXT         NOT NULL,
  "produced"        INTEGER      NOT NULL DEFAULT 0,
  "considered"      INTEGER      NOT NULL DEFAULT 0,
  "sources"         TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attemptedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "durationMs"      INTEGER,

  CONSTRAINT "RetrievalAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RetrievalAttempt_caseId_producer_key" ON "RetrievalAttempt"("caseId", "producer");
CREATE INDEX IF NOT EXISTS "RetrievalAttempt_caseId_attemptedAt_idx" ON "RetrievalAttempt"("caseId", "attemptedAt");
CREATE INDEX IF NOT EXISTS "RetrievalAttempt_firmId_idx" ON "RetrievalAttempt"("firmId");

ALTER TABLE "RetrievalAttempt"
  ADD CONSTRAINT "RetrievalAttempt_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
