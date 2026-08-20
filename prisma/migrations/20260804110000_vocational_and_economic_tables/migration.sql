-- The CREATE statements that were never written.
--
-- `VocationalEntry` and `EconomicScenario` were introduced with `prisma db
-- push`, so the dev database had them and the migration history did not. The
-- two migrations immediately after this one ALTER them, which works on any
-- database that was pushed and fails on one rebuilt from the history:
--
--   ERROR: relation "VocationalEntry" does not exist   (P3018, 42P01)
--
-- CI has been failing on exactly that line since these tables were added.
--
-- Placed BEFORE 20260804120000_vocational_verification_attribution and
-- 20260804130000_economic_scenario_versioning, and deliberately WITHOUT the
-- columns those two add — so the sequence is honest: this creates the table as
-- it then was, and each later migration still does its own work. On a database
-- that already has these tables, IF NOT EXISTS makes this a no-op.
CREATE TABLE IF NOT EXISTS "VocationalEntry" (
  "id"               TEXT PRIMARY KEY,
  "firmId"           TEXT NOT NULL,
  "caseId"           TEXT NOT NULL,
  "kind"             TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "detail"           JSONB NOT NULL,
  "startDate"        TIMESTAMP(3),
  "endDate"          TIMESTAMP(3),
  "source"           TEXT NOT NULL,
  "sourceDocumentId" TEXT,
  "enteredById"      TEXT NOT NULL,
  "verification"     TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "notes"            TEXT,
  "supersededById"   TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "VocationalEntry_caseId_kind_idx" ON "VocationalEntry"("caseId", "kind");
CREATE INDEX IF NOT EXISTS "VocationalEntry_firmId_idx" ON "VocationalEntry"("firmId");

CREATE TABLE IF NOT EXISTS "EconomicScenario" (
  "id"         TEXT PRIMARY KEY,
  "firmId"     TEXT NOT NULL,
  "caseId"     TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "overrides"  JSONB NOT NULL,
  "result"     JSONB,
  "computedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "EconomicScenario_caseId_idx" ON "EconomicScenario"("caseId");
CREATE INDEX IF NOT EXISTS "EconomicScenario_firmId_idx" ON "EconomicScenario"("firmId");
