DROP TABLE IF EXISTS "GoldCase";
DROP TABLE IF EXISTS "LearnedPrior";
DROP TABLE IF EXISTS "ValidationRun";
ALTER TABLE "RecommendationTransition" DROP COLUMN IF EXISTS "reasonCode";
ALTER TABLE "FutureCareItem" DROP COLUMN IF EXISTS "origin", DROP COLUMN IF EXISTS "templateRuleId", DROP COLUMN IF EXISTS "conditionKey";
DROP TYPE IF EXISTS "RecommendationOrigin";
