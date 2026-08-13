-- Append-only audit of LLM duplicate adjudication: why two records became one.
CREATE TABLE "DuplicateAdjudication" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "aRowIds" JSONB NOT NULL,
    "bRowIds" JSONB NOT NULL,
    "aDocumentId" TEXT NOT NULL,
    "bDocumentId" TEXT NOT NULL,
    "aContentHash" TEXT NOT NULL,
    "bContentHash" TEXT NOT NULL,
    "encounterDate" TIMESTAMP(3),
    "aProvider" TEXT,
    "bProvider" TEXT,
    "attribution" TEXT NOT NULL,
    "candidacyReason" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "llmProvider" TEXT,
    "llmModel" TEXT,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "merged" BOOLEAN NOT NULL,
    "humanOutcome" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DuplicateAdjudication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DuplicateAdjudication_firmId_caseId_idx" ON "DuplicateAdjudication"("firmId", "caseId");
CREATE INDEX "DuplicateAdjudication_caseId_decidedAt_idx" ON "DuplicateAdjudication"("caseId", "decidedAt");
