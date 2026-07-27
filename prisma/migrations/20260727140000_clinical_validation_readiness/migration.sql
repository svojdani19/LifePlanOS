-- CreateEnum
CREATE TYPE "RecommendationOrigin" AS ENUM ('TEMPLATE_CONDITION', 'TEMPLATE_BASELINE', 'TEMPLATE_SPECIALTY', 'PHYSICIAN_ADDED', 'GOLD_IMPORT');

-- AlterTable
ALTER TABLE "FutureCareItem" ADD COLUMN     "conditionKey" TEXT,
ADD COLUMN     "origin" "RecommendationOrigin" NOT NULL DEFAULT 'TEMPLATE_CONDITION',
ADD COLUMN     "templateRuleId" TEXT;

-- AlterTable
ALTER TABLE "RecommendationTransition" ADD COLUMN     "reasonCode" TEXT;

-- CreateTable
CREATE TABLE "ValidationRun" (
    "id" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnedPrior" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "templateValue" DOUBLE PRECISION,
    "learnedValue" DOUBLE PRECISION,
    "sampleSize" INTEGER NOT NULL,
    "support" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnedPrior_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldCase" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceCaseId" TEXT,
    "fixture" JSONB NOT NULL,
    "notes" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValidationRun_engineVersion_createdAt_idx" ON "ValidationRun"("engineVersion", "createdAt");

-- CreateIndex
CREATE INDEX "LearnedPrior_firmId_idx" ON "LearnedPrior"("firmId");

-- CreateIndex
CREATE UNIQUE INDEX "LearnedPrior_firmId_scopeKey_field_key" ON "LearnedPrior"("firmId", "scopeKey", "field");

-- CreateIndex
CREATE UNIQUE INDEX "GoldCase_name_key" ON "GoldCase"("name");

-- CreateIndex
CREATE INDEX "GoldCase_firmId_idx" ON "GoldCase"("firmId");

