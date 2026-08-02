-- Attorney-supplied provider context (additive): deposition summary + notes.
ALTER TABLE "TreatingProvider" ADD COLUMN IF NOT EXISTS "depositionSummary" TEXT;
ALTER TABLE "TreatingProvider" ADD COLUMN IF NOT EXISTS "attorneyNotes" TEXT;
