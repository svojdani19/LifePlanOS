-- Projection-input provenance: which of a future-care line's inputs the records
-- state, and which are planning assumptions. Additive and nullable: existing
-- rows report no provenance, which the report renders as "not recorded" rather
-- than as a claim that the records supplied the numbers.
ALTER TABLE "FutureCareItem" ADD COLUMN "inputProvenance" JSONB;
