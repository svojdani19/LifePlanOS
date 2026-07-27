-- Per-firm data retention window (Enterprise): days after last activity that a
-- CLOSED/ARCHIVED case's stored PHI (record files, extracted text) is purged.
ALTER TABLE "Firm" ADD COLUMN "dataRetentionDays" INTEGER;
