-- Rollback: drops substance classification only. Encounters, claims, review
-- lineage and human edits are untouched; the chronology reverts to admitting
-- every encounter (the pre-classification behaviour).
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "substanceClass";
ALTER TABLE "ExtractedEncounter" DROP COLUMN IF EXISTS "substanceReason";
