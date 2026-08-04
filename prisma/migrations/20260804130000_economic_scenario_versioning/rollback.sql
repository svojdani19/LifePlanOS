-- Rollback: economic scenario calculation history (additive columns only).
ALTER TABLE "EconomicScenario" DROP COLUMN IF EXISTS "supersededById";
ALTER TABLE "EconomicScenario" DROP COLUMN IF EXISTS "computedById";
