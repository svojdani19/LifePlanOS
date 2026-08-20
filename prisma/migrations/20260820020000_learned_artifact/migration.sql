-- Versioned, attributable learning artifacts derived from reference plans.
--
-- Fact-free by construction: the style profile's free-text surface is closed to
-- declared vocabularies, and a care pattern has nowhere in its type to put a
-- service name, frequency or cost.
--
-- Stored rather than recomputed so a plan can name the artifact version that
-- shaped it, and so promotion is an auditable act rather than a side effect of
-- running a script. `approvedById` is null until a qualified person adopts it;
-- nothing here auto-adopts.
--
-- Additive and reversible:
--   DROP TABLE "LearnedArtifact";
CREATE TABLE IF NOT EXISTS "LearnedArtifact" (
  "id"             TEXT PRIMARY KEY,
  "firmId"         TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "version"        TEXT NOT NULL,
  "payload"        JSONB NOT NULL,
  "sampleSize"     INTEGER NOT NULL,
  "heldOut"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approvedById"   TEXT,
  "approvedAt"     TIMESTAMP(3),
  "supersededById" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "LearnedArtifact_firmId_kind_createdAt_idx" ON "LearnedArtifact"("firmId", "kind", "createdAt");
