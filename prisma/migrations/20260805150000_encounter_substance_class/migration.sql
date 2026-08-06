-- Encounter substance classification (additive, reversible).
-- CLINICAL | ANCILLARY | ADMINISTRATIVE, with a reviewable reason. NULL means
-- "not yet classified", which the chronology treats as CLINICAL (doubt
-- resolves toward visibility, never toward silent exclusion).
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "substanceClass" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "substanceReason" TEXT;
