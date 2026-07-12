-- P2/P3: recommendation versioning (P2.R1), transition ledger, evidence graph,
-- assumption-change ledger, case snapshots.

-- CreateEnum
CREATE TYPE "RecStatus" AS ENUM ('AI_DRAFT', 'PLANNER_PROPOSED', 'PLANNER_APPROVED', 'RECORD_SUPPORTED', 'SENT_FOR_PHYSICIAN_REVIEW', 'PHYSICIAN_CLARIFICATION', 'PHYSICIAN_APPROVED', 'PHYSICIAN_MODIFIED', 'PHYSICIAN_REJECTED', 'ATTORNEY_REVIEWED', 'LOCKED_FOR_EXPORT', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "FutureCareItem" ADD COLUMN "lineageId" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "supersededById" TEXT,
ADD COLUMN "supersededAt" TIMESTAMP(3),
ADD COLUMN "lifecycleStatus" "RecStatus" NOT NULL DEFAULT 'AI_DRAFT';

-- CreateIndex
CREATE INDEX "FutureCareItem_caseId_supersededAt_idx" ON "FutureCareItem"("caseId", "supersededAt");
CREATE INDEX "FutureCareItem_lineageId_idx" ON "FutureCareItem"("lineageId");

-- CreateTable
CREATE TABLE "RecommendationTransition" (
    "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "lineageId" TEXT NOT NULL, "itemId" TEXT NOT NULL,
    "userId" TEXT, "role" TEXT,
    "priorStatus" TEXT NOT NULL, "newStatus" TEXT NOT NULL,
    "comment" TEXT, "modifiedFields" JSONB,
    "materialChange" BOOLEAN NOT NULL DEFAULT false, "caseVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationTransition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecommendationTransition_caseId_idx" ON "RecommendationTransition"("caseId");
CREATE INDEX "RecommendationTransition_lineageId_idx" ON "RecommendationTransition"("lineageId");
ALTER TABLE "RecommendationTransition" ADD CONSTRAINT "RecommendationTransition_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EvidenceLink" (
    "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "kind" TEXT NOT NULL, "fromType" TEXT NOT NULL, "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL, "toId" TEXT,
    "documentId" TEXT, "page" INTEGER, "quote" TEXT, "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EvidenceLink_caseId_idx" ON "EvidenceLink"("caseId");
CREATE INDEX "EvidenceLink_caseId_fromType_fromId_idx" ON "EvidenceLink"("caseId", "fromType", "fromId");
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AssumptionChange" (
    "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "field" TEXT NOT NULL, "originalValue" DOUBLE PRECISION, "revisedValue" DOUBLE PRECISION,
    "reason" TEXT, "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssumptionChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssumptionChange_caseId_idx" ON "AssumptionChange"("caseId");
ALTER TABLE "AssumptionChange" ADD CONSTRAINT "AssumptionChange_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "CaseSnapshot" (
    "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "version" INTEGER NOT NULL, "reportExportId" TEXT, "payload" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CaseSnapshot_caseId_version_key" ON "CaseSnapshot"("caseId", "version");
CREATE INDEX "CaseSnapshot_caseId_idx" ON "CaseSnapshot"("caseId");
ALTER TABLE "CaseSnapshot" ADD CONSTRAINT "CaseSnapshot_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
