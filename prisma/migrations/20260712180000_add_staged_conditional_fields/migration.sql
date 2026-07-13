-- Staged / conditional recommendation metadata (§10 Report Quality Sprint).
ALTER TABLE "FutureCareItem" ADD COLUMN "prerequisite" TEXT;
ALTER TABLE "FutureCareItem" ADD COLUMN "earliestTiming" TEXT;
ALTER TABLE "FutureCareItem" ADD COLUMN "replacesService" TEXT;
ALTER TABLE "FutureCareItem" ADD COLUMN "contingencyOnly" BOOLEAN NOT NULL DEFAULT false;
