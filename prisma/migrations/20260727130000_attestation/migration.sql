-- EPIC-005 electronic attestation: immutable signed physician attestations
-- with credential snapshot, pinned recommendation scope, and content hash.
CREATE TYPE "AttestationStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'INVALIDATED');

CREATE TABLE "Attestation" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "physicianId" TEXT NOT NULL,
    "physicianName" TEXT NOT NULL,
    "physicianRole" TEXT NOT NULL,
    "credentialSummary" TEXT,
    "credentialDocs" JSONB,
    "statementText" TEXT NOT NULL,
    "physicianNote" TEXT,
    "scope" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "totalPresentValue" DOUBLE PRECISION NOT NULL,
    "caseVersion" INTEGER,
    "contentHash" TEXT NOT NULL,
    "status" "AttestationStatus" NOT NULL DEFAULT 'ACTIVE',
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,
    "supersededById" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attestation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Attestation_caseId_idx" ON "Attestation"("caseId");
CREATE INDEX "Attestation_firmId_idx" ON "Attestation"("firmId");
CREATE INDEX "Attestation_caseId_status_idx" ON "Attestation"("caseId", "status");

ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_physicianId_fkey" FOREIGN KEY ("physicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
