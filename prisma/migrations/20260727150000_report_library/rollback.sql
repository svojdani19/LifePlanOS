ALTER TABLE "ReportExport" DROP COLUMN IF EXISTS "reportType";
ALTER TABLE "ReportExport" DROP COLUMN IF EXISTS "config";
-- Postgres cannot drop an enum value; 'HTML' remains unused after rollback.
