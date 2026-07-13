-- Case Review Assistant: attention items (lifecycle-tracked projections of findings).
CREATE TYPE "AttentionSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'INFORMATIONAL');
CREATE TYPE "AttentionStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'DEFERRED', 'RESOLVED', 'DISMISSED', 'SUPERSEDED');
CREATE TABLE "AttentionItem" (
  "id" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "caseVersionId" TEXT,
  "category" TEXT NOT NULL,
  "severity" "AttentionSeverity" NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "whyItMatters" TEXT NOT NULL,
  "suggestedAction" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "sourceDocumentId" TEXT,
  "sourcePage" INTEGER,
  "validationRuleId" TEXT NOT NULL,
  "exportBlocking" BOOLEAN NOT NULL DEFAULT false,
  "status" "AttentionStatus" NOT NULL DEFAULT 'OPEN',
  "assignedUserId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  CONSTRAINT "AttentionItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AttentionItem_caseId_idx" ON "AttentionItem"("caseId");
CREATE INDEX "AttentionItem_firmId_idx" ON "AttentionItem"("firmId");
CREATE INDEX "AttentionItem_caseId_status_idx" ON "AttentionItem"("caseId", "status");
CREATE INDEX "AttentionItem_caseId_validationRuleId_idx" ON "AttentionItem"("caseId", "validationRuleId");
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
