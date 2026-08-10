-- Controlled learning loop: failure lifecycle and candidate lineage.
-- Additive only. No existing table is altered and no data is moved.

CREATE TABLE "LearningCandidate" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "mechanism" TEXT NOT NULL,
    "failureCode" TEXT NOT NULL,
    "guidance" TEXT NOT NULL,
    "payload" JSONB,
    "documentClass" TEXT,
    "sectionType" TEXT,
    "scope" TEXT NOT NULL,
    "supportCount" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "evaluation" JSONB,
    "safetyClean" BOOLEAN,
    "adoptedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "applicationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearningCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningFinding" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "caseId" TEXT,
    "documentId" TEXT,
    "encounterId" TEXT,
    "chronologyEventId" TEXT,
    "futureCareItemId" TEXT,
    "stage" TEXT NOT NULL,
    "failureCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detectionSource" TEXT NOT NULL,
    "validatorKind" TEXT,
    "validatorResult" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DETECTED',
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "schemaVersion" TEXT,
    "criticVersion" TEXT,
    "writerVersion" TEXT,
    "engineVersion" TEXT,
    "sourceFingerprint" TEXT,
    "originalClaimIds" JSONB,
    "addedClaimIds" JSONB,
    "removedClaimIds" JSONB,
    "selectedClaimIds" JSONB,
    "rejectedClaimIds" JSONB,
    "correctionDelta" JSONB,
    "changedMeaning" BOOLEAN,
    "reviewerId" TEXT,
    "reviewerRole" TEXT,
    "correctionReason" TEXT,
    "reusableScope" TEXT,
    "documentClass" TEXT,
    "sectionType" TEXT,
    "repairAttempts" INTEGER NOT NULL DEFAULT 0,
    "repairedAt" TIMESTAMP(3),
    "candidateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearningFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearningCandidate_firmId_status_idx" ON "LearningCandidate"("firmId", "status");
CREATE INDEX "LearningCandidate_firmId_mechanism_documentClass_idx" ON "LearningCandidate"("firmId", "mechanism", "documentClass");
CREATE INDEX "LearningCandidate_supersedesId_idx" ON "LearningCandidate"("supersedesId");

CREATE INDEX "LearningFinding_firmId_state_idx" ON "LearningFinding"("firmId", "state");
CREATE INDEX "LearningFinding_firmId_failureCode_createdAt_idx" ON "LearningFinding"("firmId", "failureCode", "createdAt");
CREATE INDEX "LearningFinding_caseId_idx" ON "LearningFinding"("caseId");
CREATE INDEX "LearningFinding_candidateId_idx" ON "LearningFinding"("candidateId");

ALTER TABLE "LearningFinding" ADD CONSTRAINT "LearningFinding_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "LearningCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
