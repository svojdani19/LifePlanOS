-- New recommendation origin: an item mined from a documented treating-provider
-- recommendation, carrying its citation in the rationale. Additive.
ALTER TYPE "RecommendationOrigin" ADD VALUE IF NOT EXISTS 'RECORD_RECOMMENDED';
