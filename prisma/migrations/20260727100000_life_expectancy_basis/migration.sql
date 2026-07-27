-- Life-expectancy basis (engine/lifeExpectancy.ts): recorded provenance for the
-- lifetime projection horizon — actuarial baseline, documented adjustments,
-- or physician determination, plus approval metadata.
ALTER TABLE "Case" ADD COLUMN "lifeExpectancyBasis" JSONB;
