-- Additional LCP encounter data points per medical-record event.
ALTER TABLE "ChronologyEvent" ADD COLUMN "pastMedicalHistory" TEXT;
ALTER TABLE "ChronologyEvent" ADD COLUMN "impairmentRating" TEXT;
