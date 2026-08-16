-- Entry-level dispute state, persisted so a deterministic re-audit reproduces
-- the same verdict. Without these, a re-audit cannot see an unresolved
-- disagreement or a confirmed contradiction and would silently clear it.
--
-- Additive and reversible:
--   ALTER TABLE "ExtractedEncounter" DROP COLUMN "unresolvedDisputes";
--   ALTER TABLE "ExtractedEncounter" DROP COLUMN "contradictedFields";
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "unresolvedDisputes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "contradictedFields" JSONB;
