-- EPIC-011: clinical interviews & reviewer credentials.

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('SUGGESTED', 'CONFIRMED', 'DISMISSED');
CREATE TYPE "InterviewSubject" AS ENUM ('PATIENT', 'PROVIDER');
CREATE TYPE "CredentialType" AS ENUM ('BOARD_CERTIFICATION', 'CV', 'LICENSE', 'OTHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "credentialSummary" TEXT;

-- CreateTable
CREATE TABLE "TreatingProvider" (
    "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "name" TEXT NOT NULL, "credentials" TEXT, "specialty" TEXT, "facility" TEXT, "contact" TEXT,
    "isTreating" BOOLEAN NOT NULL DEFAULT true,
    "status" "ProviderStatus" NOT NULL DEFAULT 'SUGGESTED',
    "nameKey" TEXT NOT NULL, "sourceDocumentIds" JSONB, "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TreatingProvider_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TreatingProvider_caseId_idx" ON "TreatingProvider"("caseId");
CREATE INDEX "TreatingProvider_firmId_idx" ON "TreatingProvider"("firmId");
CREATE INDEX "TreatingProvider_caseId_nameKey_idx" ON "TreatingProvider"("caseId", "nameKey");
ALTER TABLE "TreatingProvider" ADD CONSTRAINT "TreatingProvider_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "InterviewFinding" (
    "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "subject" "InterviewSubject" NOT NULL, "providerId" TEXT,
    "category" TEXT, "text" TEXT NOT NULL, "quote" TEXT,
    "interviewDate" TIMESTAMP(3), "interviewedById" TEXT,
    "conditionId" TEXT, "futureCareItemId" TEXT, "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InterviewFinding_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InterviewFinding_caseId_idx" ON "InterviewFinding"("caseId");
CREATE INDEX "InterviewFinding_firmId_idx" ON "InterviewFinding"("firmId");
CREATE INDEX "InterviewFinding_caseId_subject_idx" ON "InterviewFinding"("caseId", "subject");
ALTER TABLE "InterviewFinding" ADD CONSTRAINT "InterviewFinding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterviewFinding" ADD CONSTRAINT "InterviewFinding_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "TreatingProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "UserCredential" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "firmId" TEXT NOT NULL,
    "type" "CredentialType" NOT NULL, "label" TEXT, "filename" TEXT NOT NULL, "storageKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserCredential_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UserCredential_userId_idx" ON "UserCredential"("userId");
CREATE INDEX "UserCredential_firmId_idx" ON "UserCredential"("firmId");
ALTER TABLE "UserCredential" ADD CONSTRAINT "UserCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
