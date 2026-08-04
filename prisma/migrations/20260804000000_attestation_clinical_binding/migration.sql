-- Attestation ↔ clinical-evidence binding (additive).
-- clinicalFingerprint: versioned aggregate (cfp-1:<sha256>) over the covered
-- items' per-recommendation clinical fingerprints computed at signing.
-- bindingVersion: fingerprint algorithm version ("cfp-1"); NULL = legacy row.
-- opinionScopes: string[] of opinion-scope codes the signed statement covers.
ALTER TABLE "Attestation" ADD COLUMN IF NOT EXISTS "clinicalFingerprint" TEXT;
ALTER TABLE "Attestation" ADD COLUMN IF NOT EXISTS "bindingVersion" TEXT;
ALTER TABLE "Attestation" ADD COLUMN IF NOT EXISTS "opinionScopes" JSONB;
