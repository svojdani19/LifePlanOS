-- Economic scenario calculation history (additive).
-- A recompute creates a NEW EconomicScenario row and points the prior current
-- row of the same name at its successor via supersededById — prior calculation
-- results are preserved, never overwritten in place. computedById records the
-- responsible expert for the calculation run. NULL on legacy rows.
ALTER TABLE "EconomicScenario" ADD COLUMN IF NOT EXISTS "supersededById" TEXT;
ALTER TABLE "EconomicScenario" ADD COLUMN IF NOT EXISTS "computedById" TEXT;
