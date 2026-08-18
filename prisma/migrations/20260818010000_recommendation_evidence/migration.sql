-- Item-level evidence ledger.
--
-- Evidence for a future-care recommendation was selected per DIAGNOSIS: a
-- chronology event matched by body region or by any word of the diagnosis
-- name. Five services for one lumbar diagnosis therefore drew the same pool,
-- and findings that establish the condition were displayed as though they
-- established the necessity of each intervention.
--
-- Each row ties one source to one recommendation, one claim about it, and a
-- direction. Machine rows are rebuilt on every generation; rows carrying an
-- `addedById` are a clinician's own citation and survive untouched.
--
-- Additive and reversible:
--   DROP TABLE "RecommendationEvidence";
CREATE TABLE IF NOT EXISTS "RecommendationEvidence" (
  "id"                TEXT PRIMARY KEY,
  "firmId"            TEXT NOT NULL,
  "caseId"            TEXT NOT NULL,
  "futureCareItemId"  TEXT NOT NULL,
  "conditionId"       TEXT,
  "claim"             TEXT NOT NULL,
  "stance"            TEXT NOT NULL,
  "strength"          TEXT NOT NULL,
  "sourceKind"        TEXT NOT NULL,
  "sourceDocumentId"  TEXT,
  "encounterId"       TEXT,
  "chronologyEventId" TEXT,
  "page"              INTEGER,
  "field"             TEXT,
  "quote"             TEXT NOT NULL,
  "recordedOn"        TIMESTAMP(3),
  "citationTitle"     TEXT,
  "citationJournal"   TEXT,
  "citationYear"      TEXT,
  "citationDoi"       TEXT,
  "citationPmid"      TEXT,
  "citationUrl"       TEXT,
  "sourceFingerprint" TEXT,
  "producerVersion"   TEXT,
  "addedById"         TEXT,
  "addedAt"           TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The citation columns are added separately so this migration is correct on a
-- database where an earlier draft of the table already exists: CREATE TABLE
-- IF NOT EXISTS skips silently, and the new columns would never arrive.
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "citationTitle"   TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "citationJournal" TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "citationYear"    TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "citationDoi"     TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "citationPmid"    TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "citationUrl"     TEXT;

CREATE INDEX IF NOT EXISTS "RecommendationEvidence_caseId_futureCareItemId_idx"
  ON "RecommendationEvidence" ("caseId", "futureCareItemId");
CREATE INDEX IF NOT EXISTS "RecommendationEvidence_futureCareItemId_claim_idx"
  ON "RecommendationEvidence" ("futureCareItemId", "claim");
CREATE INDEX IF NOT EXISTS "RecommendationEvidence_caseId_addedById_idx"
  ON "RecommendationEvidence" ("caseId", "addedById");

-- Re-linking and attribution.
--
-- A citation keyed only to `futureCareItemId` is orphaned by regeneration: 22
-- of 59 items on the reference case are recreated with fresh ids each run, so
-- the row was preserved and then pointed at a dead item — invisible in the
-- panel, unreachable by the delete route. Lineage (and the service name as a
-- fallback) survives that.
--
-- The contributor columns exist because a bare user id cannot support the
-- claim "Physician-selected evidence".
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "lineageId"         TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "serviceKey"        TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "addedByRole"       TEXT;
ALTER TABLE "RecommendationEvidence" ADD COLUMN IF NOT EXISTS "addedByCredential" TEXT;

CREATE INDEX IF NOT EXISTS "RecommendationEvidence_caseId_lineageId_idx"
  ON "RecommendationEvidence" ("caseId", "lineageId");
