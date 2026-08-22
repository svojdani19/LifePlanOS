-- Make the recorded basis materially complete.
--
-- ClaimBasis recorded the KIND of each quantity's support and none of the
-- values, so the hash carried "frequency is an assumption" and not "four visits
-- a year". Four visits to six, or $300 to $500, left every kind unchanged and
-- the basis reported CURRENT — while the reasoning engine's materialHash DID
-- move. Split brain over exactly the numbers a defence expert attacks, with the
-- export gate reading the half that could not see them.
--
-- `contradictions` and `literature` are recorded so the exported report renders
-- them from the record rather than re-deriving them at export time.
--
-- Existing rows get NULL. They are not backfilled with invented values: a basis
-- that cannot be reconstructed faithfully must fail its own freshness check and
-- be regenerated, which is what BASIS_STALE is for.
--
-- Additive and reversible:
--   ALTER TABLE "RecommendationBasis"
--     DROP COLUMN "projectionBasis", DROP COLUMN "contradictions", DROP COLUMN "literature";
ALTER TABLE "RecommendationBasis"
  ADD COLUMN IF NOT EXISTS "projectionBasis" JSONB,
  ADD COLUMN IF NOT EXISTS "contradictions"  JSONB,
  ADD COLUMN IF NOT EXISTS "literature"      JSONB;
