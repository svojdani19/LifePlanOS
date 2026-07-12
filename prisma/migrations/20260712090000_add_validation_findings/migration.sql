-- Persisted results of the deterministic LCP integrity check. Derived data:
-- recomputed and replaced on plan (re)generation and report export.
CREATE TABLE "ValidationFinding" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "exportBlocking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ValidationFinding_caseId_idx" ON "ValidationFinding"("caseId");
CREATE INDEX "ValidationFinding_firmId_idx" ON "ValidationFinding"("firmId");

ALTER TABLE "ValidationFinding" ADD CONSTRAINT "ValidationFinding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ValidationFinding" ADD CONSTRAINT "ValidationFinding_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
