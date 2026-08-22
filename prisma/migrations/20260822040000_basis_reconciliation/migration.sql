-- Close a recorded-basis divergence honestly, or not at all.
--
-- validateCase writes BASIS_STALE / BASIS_MISSING when a plan and the record it
-- rests on are different objects. Those were ordinary ValidationFinding rows,
-- so the generic disposition route let any holder of report.export or case.edit
-- set them RESOLVED_AS_IS or IGNORED — and the final-export gate counts only
-- OPEN blocking findings. Two clicks turned "this report does not match its
-- record" into a clean final export with the mismatch still present and now
-- invisible.
--
-- A divergence may now close only by regenerating the plan so the hashes agree,
-- or by this row: a credentialed physician recording which basis they
-- reconciled to, who they are, the credential they held, why, and when.
--
-- This table is a record of a professional act, not a status override. The
-- export gate independently re-derives and compares, so neither a
-- reconciliation nor a malformed legacy disposition can release a report whose
-- record still disagrees with it.
--
-- Additive and reversible:
--   DROP TABLE "BasisReconciliation";
CREATE TABLE IF NOT EXISTS "BasisReconciliation" (
  "id"               TEXT         NOT NULL,
  "caseId"           TEXT         NOT NULL,
  "firmId"           TEXT         NOT NULL,
  "futureCareItemId" TEXT         NOT NULL,
  "recordedHash"     TEXT,
  "derivedHash"      TEXT         NOT NULL,
  "reconciledById"   TEXT         NOT NULL,
  "credentialLabel"  TEXT         NOT NULL,
  "reason"           TEXT         NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BasisReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BasisReconciliation_caseId_futureCareItemId_idx" ON "BasisReconciliation"("caseId", "futureCareItemId");
CREATE INDEX IF NOT EXISTS "BasisReconciliation_firmId_idx" ON "BasisReconciliation"("firmId");

ALTER TABLE "BasisReconciliation"
  ADD CONSTRAINT "BasisReconciliation_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
