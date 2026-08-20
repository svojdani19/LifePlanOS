-- Freeze what the generator produced, before any human touches it.
--
-- The blind evaluator read live plan rows and excluded the ones a reviewer had
-- approved or modified. That is a filter, not a freeze: an item a planner
-- EDITED keeps its generator origin and a PENDING status, so edited output was
-- scored as generator output. The origin allow-list also omitted
-- TEMPLATE_SPECIALTY, leaving an entire generator path unscored.
--
-- Additive and reversible:
--   DROP TABLE "GeneratorSnapshot";
CREATE TABLE IF NOT EXISTS "GeneratorSnapshot" (
  "id"               TEXT PRIMARY KEY,
  "firmId"           TEXT NOT NULL,
  "caseId"           TEXT NOT NULL,
  "planVersion"      INTEGER,
  "items"            JSONB NOT NULL,
  "producerVersions" JSONB,
  "takenAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratorSnapshot_caseId_fkey" FOREIGN KEY ("caseId")
    REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "GeneratorSnapshot_caseId_takenAt_idx" ON "GeneratorSnapshot"("caseId", "takenAt");
