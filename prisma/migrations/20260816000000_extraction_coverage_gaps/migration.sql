-- Under-extraction of a document, recorded on its run so the case-level
-- completion gate can see it without every row carrying it as its own defect.
ALTER TABLE "RecordExtraction" ADD COLUMN IF NOT EXISTS "coverageGaps" INTEGER NOT NULL DEFAULT 0;
