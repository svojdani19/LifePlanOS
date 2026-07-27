-- Cross-case learning: per-firm deterministic aggregation of physician review
-- history, plus the advisory insight attached to each generated recommendation.
CREATE TABLE "FirmLearningProfile" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "lineagesIncluded" INTEGER NOT NULL DEFAULT 0,
    "casesIncluded" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirmLearningProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FirmLearningProfile_firmId_key" ON "FirmLearningProfile"("firmId");

ALTER TABLE "FirmLearningProfile" ADD CONSTRAINT "FirmLearningProfile_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FutureCareItem" ADD COLUMN "learnedInsight" JSONB;
