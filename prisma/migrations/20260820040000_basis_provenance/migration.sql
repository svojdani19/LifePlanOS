-- Persist the provenance the basis hash already covers.
--
-- The hash included every accepted row's document, encounter, page, field,
-- stance and source fingerprint, and none of it was stored. So a basis could
-- report STALE with no way to see WHICH citation had moved — a divergence
-- signal with no diagnosis attached.
--
-- Additive and reversible:
--   ALTER TABLE "RecommendationBasis" DROP COLUMN "evidenceProvenance";
ALTER TABLE "RecommendationBasis" ADD COLUMN IF NOT EXISTS "evidenceProvenance" JSONB;
