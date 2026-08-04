-- Vocational verification attribution (additive).
-- A VERIFIED vocational entry records WHO verified it, WHEN, and a snapshot of
-- the verifying expert's credential label at the moment of the act. Set only
-- by an explicit, credential-gated verification; a material replacement never
-- carries these forward. NULL on legacy rows and on non-verified entries.
ALTER TABLE "VocationalEntry" ADD COLUMN IF NOT EXISTS "verifiedById" TEXT;
ALTER TABLE "VocationalEntry" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "VocationalEntry" ADD COLUMN IF NOT EXISTS "verifiedCredential" TEXT;
