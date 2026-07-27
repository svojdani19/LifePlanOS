-- Report Library: additive, reversible.
ALTER TYPE "ExportFormat" ADD VALUE IF NOT EXISTS 'HTML';
ALTER TABLE "ReportExport" ADD COLUMN "reportType" TEXT;
ALTER TABLE "ReportExport" ADD COLUMN "config" JSONB;
