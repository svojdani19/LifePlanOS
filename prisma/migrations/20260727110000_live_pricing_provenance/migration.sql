-- Live-pricing provenance (pricingProvider seam) + venue ZIP for geozip pricing.
ALTER TABLE "Case" ADD COLUMN "zipCode" TEXT;
ALTER TABLE "FutureCareItem" ADD COLUMN "pricedAt" TIMESTAMP(3);
ALTER TABLE "FutureCareItem" ADD COLUMN "pricingDetail" JSONB;
