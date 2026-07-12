-- Persisted sub-documents parsed from a consolidated chart at ingest.
ALTER TABLE "Document" ADD COLUMN "segments" JSONB;
