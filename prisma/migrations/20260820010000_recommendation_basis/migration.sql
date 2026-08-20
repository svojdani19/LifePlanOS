-- One authoritative basis per recommendation.
--
-- `buildRecommendationDossier()` is called independently by the panel, the
-- report, validation, clinical reasoning and the generator. They agree today
-- only because their inputs were forced to agree; nothing structural stops two
-- consumers reconstructing different bases from different queries, which is
-- exactly how the panel and the persisted ledger came to argue about different
-- injuries.
--
-- Computed once at generation, hashed, and compared by every reader against
-- what it would derive now — so a divergence is disclosed, not silently
-- resolved in whichever direction that consumer computed.
--
-- Additive and reversible:
--   DROP TABLE "RecommendationBasis";
CREATE TABLE IF NOT EXISTS "RecommendationBasis" (
  "id"                 TEXT PRIMARY KEY,
  "firmId"             TEXT NOT NULL,
  "caseId"             TEXT NOT NULL,
  "futureCareItemId"   TEXT NOT NULL,
  "lineageId"          TEXT,
  "interventionId"     TEXT NOT NULL,
  "serviceFamily"      TEXT NOT NULL,
  "conditionId"        TEXT,
  "bodyRegion"         TEXT,
  "spinalLevels"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "laterality"         TEXT,
  "supportClass"       TEXT NOT NULL,
  "supportReason"      TEXT,
  "acceptedEvidence"   JSONB NOT NULL,
  "prerequisites"      JSONB,
  "claimBasis"         JSONB,
  "missingPremises"    JSONB,
  "necessityNarrative" TEXT,
  "producerVersion"    TEXT NOT NULL,
  "basisHash"          TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecommendationBasis_caseId_fkey" FOREIGN KEY ("caseId")
    REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "RecommendationBasis_futureCareItemId_key" ON "RecommendationBasis"("futureCareItemId");
CREATE INDEX IF NOT EXISTS "RecommendationBasis_caseId_idx" ON "RecommendationBasis"("caseId");
CREATE INDEX IF NOT EXISTS "RecommendationBasis_firmId_caseId_idx" ON "RecommendationBasis"("firmId", "caseId");
