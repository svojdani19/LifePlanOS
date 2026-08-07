-- Document-kind provenance on each extracted row.
--
-- Additive and nullable throughout, so every legacy row remains readable. The
-- backfill is deliberately conservative: a row is given a class ONLY where its
-- source document's own type states one unambiguously. Rows whose document is
-- typed OTHER — the schema default, i.e. "nobody chose" — are left NULL and
-- read as UNKNOWN. Backfilling unknown legacy content as clinical is exactly
-- the error this whole change exists to correct.

ALTER TABLE "ExtractedEncounter" ADD COLUMN "analysisClass" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN "segmentKey" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN "classificationMethod" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN "classificationConfidence" DOUBLE PRECISION;
ALTER TABLE "ExtractedEncounter" ADD COLUMN "attributionName" TEXT;
ALTER TABLE "ExtractedEncounter" ADD COLUMN "attributionRole" TEXT;

UPDATE "ExtractedEncounter" e
   SET "analysisClass" = CASE d."type"
         WHEN 'DEPOSITION' THEN 'TESTIMONY'
         WHEN 'OPERATIVE_NOTE' THEN 'OPERATIVE'
         WHEN 'ANESTHESIA_RECORD' THEN 'ANESTHESIA'
         WHEN 'PATHOLOGY_REPORT' THEN 'PATHOLOGY_DIAGNOSTIC'
         WHEN 'IMPLANT_RECORDS' THEN 'DEVICE_OR_IMPLANT'
         WHEN 'IMAGING_REPORT' THEN 'DIAGNOSTIC_STUDY'
         WHEN 'LAB_REPORT' THEN 'DIAGNOSTIC_STUDY'
         WHEN 'EMG_NCS_REPORT' THEN 'DIAGNOSTIC_STUDY'
         WHEN 'BILLING_RECORD' THEN 'FINANCIAL'
         WHEN 'PHARMACY_RECORD' THEN 'FINANCIAL'
         WHEN 'INSURANCE_RECORDS' THEN 'INSURANCE_ADMINISTRATIVE'
         WHEN 'WAGE_LOSS_DOCUMENTATION' THEN 'EMPLOYMENT_ECONOMIC'
         WHEN 'TAX_RECORDS' THEN 'EMPLOYMENT_ECONOMIC'
         WHEN 'EMPLOYMENT_RECORDS' THEN 'EMPLOYMENT_ECONOMIC'
         WHEN 'POLICE_REPORT' THEN 'INCIDENT'
         WHEN 'EMS_REPORT' THEN 'INCIDENT'
         WHEN 'INCIDENT_REPORT' THEN 'INCIDENT'
         WHEN 'ACCIDENT_RECONSTRUCTION' THEN 'INCIDENT'
         WHEN 'IME_REPORT' THEN 'EXPERT_OPINION'
         WHEN 'EXPERT_REPORT' THEN 'EXPERT_OPINION'
         WHEN 'PEER_REVIEW' THEN 'EXPERT_OPINION'
         WHEN 'NEUROPSYCHOLOGICAL_EVALUATION' THEN 'EXPERT_OPINION'
         WHEN 'FUNCTIONAL_CAPACITY_EVALUATION' THEN 'EXPERT_OPINION'
         WHEN 'LIFE_CARE_PLAN' THEN 'EXPERT_OPINION'
         WHEN 'VOCATIONAL_ASSESSMENT' THEN 'EXPERT_OPINION'
         WHEN 'PT_OT_RECORD' THEN 'THERAPY_COURSE'
         WHEN 'SPEECH_THERAPY' THEN 'THERAPY_COURSE'
         WHEN 'CHIROPRACTIC_RECORD' THEN 'THERAPY_COURSE'
         WHEN 'ACUPUNCTURE_RECORD' THEN 'THERAPY_COURSE'
         WHEN 'LEGAL_PLEADING' THEN 'LEGAL'
         WHEN 'DEMAND_LETTER' THEN 'LEGAL'
         WHEN 'SETTLEMENT_AGREEMENT' THEN 'LEGAL'
         WHEN 'COURT_ORDER' THEN 'LEGAL'
         WHEN 'CORRESPONDENCE' THEN 'CORRESPONDENCE_OR_GENERIC_EVIDENCE'
         ELSE NULL
       END,
       "classificationMethod" = 'DOCUMENT_TYPE'
  FROM "Document" d
 WHERE d."id" = e."sourceDocumentId"
   AND d."type" <> 'OTHER';

-- A clinical class carries the treating provider forward as its attribution;
-- nothing else is invented.
UPDATE "ExtractedEncounter"
   SET "attributionName" = "provider",
       "attributionRole" = 'treating provider'
 WHERE "provider" IS NOT NULL
   AND "analysisClass" IN ('CLINICAL_ENCOUNTER', 'THERAPY_COURSE');

CREATE INDEX "ExtractedEncounter_caseId_analysisClass_idx" ON "ExtractedEncounter"("caseId", "analysisClass");
