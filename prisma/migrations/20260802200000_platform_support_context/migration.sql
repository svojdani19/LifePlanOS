-- An audited, read-only target-tenant context for platform support sessions.
-- The selection lives in the server-side session row; no client cookie can
-- manufacture cross-tenant access. Deleting a tenant clears the selection.
ALTER TABLE "Session" ADD COLUMN "supportFirmId" TEXT;

CREATE INDEX "Session_supportFirmId_idx" ON "Session"("supportFirmId");

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_supportFirmId_fkey"
  FOREIGN KEY ("supportFirmId") REFERENCES "Firm"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
