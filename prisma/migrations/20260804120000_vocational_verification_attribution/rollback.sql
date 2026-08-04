-- Rollback: vocational verification attribution (additive columns only).
ALTER TABLE "VocationalEntry" DROP COLUMN IF EXISTS "verifiedById";
ALTER TABLE "VocationalEntry" DROP COLUMN IF EXISTS "verifiedAt";
ALTER TABLE "VocationalEntry" DROP COLUMN IF EXISTS "verifiedCredential";
