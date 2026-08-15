-- Machine corroboration: an independent blind re-read of the row's source
-- span reproduced (or failed to reproduce) its facts. Additive; a quality
-- tier, never a verification.
ALTER TABLE "ExtractedEncounter" ADD COLUMN IF NOT EXISTS "corroboration" JSONB;
