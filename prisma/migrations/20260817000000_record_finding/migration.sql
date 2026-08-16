-- Scoped, deduplicated findings about the record.
--
-- Additive and reversible: nothing is dropped, and the legacy
-- ExtractedEncounter.auditFindings array is retained for compatibility. It
-- simply stops being the source of truth for review presentation and metrics.
--
-- Rollback: DROP TABLE "RecordFinding";  (no other object depends on it)
CREATE TABLE IF NOT EXISTS "RecordFinding" (
  "id"                TEXT PRIMARY KEY,
  "firmId"            TEXT NOT NULL,
  "caseId"            TEXT NOT NULL,
  "scope"             TEXT NOT NULL,
  "type"              TEXT NOT NULL,
  "severity"          TEXT NOT NULL DEFAULT 'WARNING',
  "blocking"          BOOLEAN NOT NULL DEFAULT false,
  "source"            TEXT NOT NULL,
  "sourceDocumentId"  TEXT,
  "pageStart"         INTEGER,
  "pageEnd"           INTEGER,
  "canonicalNoteId"   TEXT,
  "encounterId"       TEXT,
  "claimIndex"        INTEGER,
  "field"             TEXT,
  "detail"            TEXT NOT NULL,
  "excerpt"           TEXT,
  "sourceFingerprint" TEXT,
  "promptVersion"     TEXT,
  "model"             TEXT,
  "producerVersion"   TEXT,
  "fingerprint"       TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'OPEN',
  "dispositionReason" TEXT,
  "reviewedById"      TEXT,
  "reviewedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per distinct problem per case: re-deriving the same finding updates
-- rather than multiplying it, which is what keeps metrics honest.
CREATE UNIQUE INDEX IF NOT EXISTS "RecordFinding_caseId_fingerprint_key" ON "RecordFinding" ("caseId", "fingerprint");
CREATE INDEX IF NOT EXISTS "RecordFinding_caseId_status_idx" ON "RecordFinding" ("caseId", "status");
CREATE INDEX IF NOT EXISTS "RecordFinding_caseId_scope_status_idx" ON "RecordFinding" ("caseId", "scope", "status");
CREATE INDEX IF NOT EXISTS "RecordFinding_sourceDocumentId_status_idx" ON "RecordFinding" ("sourceDocumentId", "status");
CREATE INDEX IF NOT EXISTS "RecordFinding_encounterId_idx" ON "RecordFinding" ("encounterId");
CREATE INDEX IF NOT EXISTS "RecordFinding_canonicalNoteId_idx" ON "RecordFinding" ("canonicalNoteId");

-- Which deterministic audit version produced a row's current result, so a
-- re-audit can find rows graded by superseded rules.
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "auditVersion" TEXT;
