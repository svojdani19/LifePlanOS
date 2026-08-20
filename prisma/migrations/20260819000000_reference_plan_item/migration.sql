-- Preserve professionally finalized plan items as REFERENCE material.
--
-- 37 items on the reference corpus case carried origin GOLD_IMPORT: a published
-- life care plan's own conclusions, living inside the case's active plan. They
-- were in the panels, in the totals ($386,063 of present value), in the exported
-- report, and in the gold harness's input — so the harness was scoring the
-- answer key against itself.
--
-- This table preserves them losslessly BEFORE they are withdrawn from the
-- runtime plan. `payload` carries the complete original row, and
-- `sourceItemId` makes the withdrawal reversible from this table alone.
--
-- Additive and reversible:
--   DROP TABLE "ReferencePlanItem";
CREATE TABLE IF NOT EXISTS "ReferencePlanItem" (
  "id"               TEXT PRIMARY KEY,
  "firmId"           TEXT NOT NULL,
  "caseId"           TEXT NOT NULL,
  "sourceItemId"     TEXT,
  "service"          TEXT NOT NULL,
  "category"         TEXT NOT NULL,
  "specialty"        TEXT,
  "cptCode"          TEXT,
  "frequencyPerYear" DOUBLE PRECISION,
  "durationYears"    DOUBLE PRECISION,
  "isLifetime"       BOOLEAN NOT NULL DEFAULT false,
  "unitCost"         DOUBLE PRECISION,
  "lifetimeCost"     DOUBLE PRECISION,
  "presentValue"     DOUBLE PRECISION,
  "rationale"        TEXT,
  "payload"          JSONB NOT NULL,
  "sourceLabel"      TEXT,
  "preservedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferencePlanItem_caseId_fkey" FOREIGN KEY ("caseId")
    REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReferencePlanItem_sourceItemId_key" ON "ReferencePlanItem"("sourceItemId");
CREATE INDEX IF NOT EXISTS "ReferencePlanItem_firmId_caseId_idx" ON "ReferencePlanItem"("firmId", "caseId");
CREATE INDEX IF NOT EXISTS "ReferencePlanItem_caseId_idx" ON "ReferencePlanItem"("caseId");
