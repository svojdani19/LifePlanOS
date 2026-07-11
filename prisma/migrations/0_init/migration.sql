-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('SOLO', 'SMALL_FIRM', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'PLANNER', 'PHYSICIAN_REVIEWER', 'ATTORNEY_REVIEWER', 'PARALEGAL', 'BILLING_USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('PERSONAL_INJURY', 'MED_MAL', 'WORKERS_COMP', 'PRODUCT_LIABILITY', 'CATASTROPHIC');

-- CreateEnum
CREATE TYPE "CaseSide" AS ENUM ('PLAINTIFF', 'DEFENSE', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('INTAKE', 'RECORDS', 'CHRONOLOGY', 'CAUSATION', 'FUTURE_CARE', 'PRICING', 'DRAFTING', 'PHYSICIAN_REVIEW', 'FINAL', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('CASE_CREATED', 'RECORD_PAGE_OCR', 'AI_GENERATION', 'REPORT_EXPORT', 'SEAT_ACTIVE');

-- CreateEnum
CREATE TYPE "InjurySpecialty" AS ENUM ('GENERAL', 'ORTHOPEDIC_TRAUMA', 'HIP_ARTHROPLASTY', 'KNEE_ARTHROPLASTY', 'SPINE', 'AMPUTATION', 'TBI', 'SPINAL_CORD_INJURY', 'CHRONIC_PAIN', 'CRPS', 'BURNS', 'BIRTH_INJURY', 'NEUROLOGIC', 'PSYCHIATRIC', 'POLYTRAUMA');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('POLICE_REPORT', 'EMS_REPORT', 'ER_RECORD', 'HOSPITAL_RECORD', 'NURSING_NOTE', 'DISCHARGE_SUMMARY', 'OPERATIVE_NOTE', 'ANESTHESIA_RECORD', 'PATHOLOGY_REPORT', 'IMPLANT_RECORDS', 'MEDICAL_RECORD', 'ORTHOPEDIC_CLINIC', 'PRIMARY_CARE', 'NEUROLOGY_RECORD', 'NEUROSURGERY_RECORD', 'PAIN_MANAGEMENT', 'PHYSICAL_MEDICINE', 'PSYCHIATRY_RECORD', 'PSYCHOLOGY_RECORD', 'CARDIOLOGY_RECORD', 'PULMONOLOGY_RECORD', 'INFECTIOUS_DISEASE', 'INTERNAL_MEDICINE', 'ONCOLOGY_RECORD', 'WOUND_CARE', 'PT_OT_RECORD', 'SPEECH_THERAPY', 'CHIROPRACTIC_RECORD', 'ACUPUNCTURE_RECORD', 'IMAGING_REPORT', 'LAB_REPORT', 'EMG_NCS_REPORT', 'NEUROPSYCHOLOGICAL_EVALUATION', 'LIFE_CARE_PLAN', 'VOCATIONAL_ASSESSMENT', 'FUNCTIONAL_CAPACITY_EVALUATION', 'REHABILITATION_PLAN', 'COST_PROJECTION', 'BILLING_RECORD', 'PHARMACY_RECORD', 'WAGE_LOSS_DOCUMENTATION', 'TAX_RECORDS', 'EMPLOYMENT_RECORDS', 'INSURANCE_RECORDS', 'IME_REPORT', 'EXPERT_REPORT', 'PEER_REVIEW', 'PRIOR_RECORDS', 'DEPOSITION', 'LEGAL_PLEADING', 'DEMAND_LETTER', 'SETTLEMENT_AGREEMENT', 'COURT_ORDER', 'CORRESPONDENCE', 'ACCIDENT_RECONSTRUCTION', 'PHOTOGRAPHS', 'SURVEILLANCE_VIDEO', 'INCIDENT_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'OCR_PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "Relatedness" AS ENUM ('RELATED', 'AGGRAVATION', 'PREEXISTING_UNRELATED', 'SUBSEQUENT_UNRELATED', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "Probability" AS ENUM ('PROBABLE', 'POSSIBLE', 'SPECULATIVE', 'NOT_SUPPORTED');

-- CreateEnum
CREATE TYPE "Vulnerability" AS ENUM ('LOW', 'MODERATE', 'HIGH');

-- CreateEnum
CREATE TYPE "PhysicianStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'MODIFIED');

-- CreateEnum
CREATE TYPE "CareCategory" AS ENUM ('PHYSICIAN_VISIT', 'SPECIALIST_VISIT', 'PRIMARY_CARE', 'ORTHOPEDIC_SURGERY', 'NEUROSURGERY', 'NEUROLOGY', 'PMR', 'PAIN_MANAGEMENT', 'PSYCH', 'PHYSICAL_THERAPY', 'OCCUPATIONAL_THERAPY', 'SPEECH_THERAPY', 'COGNITIVE_THERAPY', 'MEDICATION', 'INJECTION', 'IMAGING', 'LABS', 'DME', 'ORTHOTICS_PROSTHETICS', 'MOBILITY_AID', 'HOME_MODIFICATION', 'VEHICLE_MODIFICATION', 'ATTENDANT_CARE', 'SKILLED_NURSING', 'CASE_MANAGEMENT', 'VOCATIONAL_REHAB', 'FUTURE_SURGERY', 'REVISION_SURGERY', 'COMPLICATION_MANAGEMENT', 'ASSISTIVE_TECH', 'SUPPLIES', 'TRANSPORTATION', 'MISC');

-- CreateEnum
CREATE TYPE "ReviewKind" AS ENUM ('DEFENSE', 'COMPLETENESS');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('DOCX', 'PDF', 'XLSX', 'CSV', 'MEMO');

-- CreateTable
CREATE TABLE "Firm" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT DEFAULT '#0891b2',
    "letterhead" TEXT,

    CONSTRAINT "Firm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrecedentPlan" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "clientRef" TEXT,
    "diagnosis" TEXT,
    "icd10Code" TEXT,
    "injurySpecialty" TEXT,
    "jurisdiction" TEXT,
    "mechanism" TEXT,
    "age" INTEGER,
    "sex" TEXT,
    "lifeExpectancyYears" DOUBLE PRECISION,
    "lifetimeCost" DOUBLE PRECISION,
    "presentValue" DOUBLE PRECISION,
    "careCategories" JSONB,
    "outcome" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "filename" TEXT,
    "storageKey" TEXT,
    "extractedText" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrecedentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "tier" "PlanTier" NOT NULL DEFAULT 'SOLO',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "seats" INTEGER,
    "caseLimitOverride" INTEGER,
    "seatLimitOverride" INTEGER,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'PLANNER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "inviteToken" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "ip" TEXT,
    "email" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "sex" "Sex" NOT NULL DEFAULT 'UNKNOWN',
    "caseType" "CaseType" NOT NULL DEFAULT 'PERSONAL_INJURY',
    "side" "CaseSide" NOT NULL DEFAULT 'PLAINTIFF',
    "jurisdiction" TEXT,
    "dateOfInjury" TIMESTAMP(3),
    "mechanism" TEXT,
    "diagnosis" TEXT,
    "icd10Code" TEXT,
    "additionalDiagnoses" JSONB,
    "lifeExpectancyYears" DOUBLE PRECISION,
    "discountRate" DOUBLE PRECISION NOT NULL DEFAULT 0.03,
    "medicalInflation" DOUBLE PRECISION NOT NULL DEFAULT 0.032,
    "geographicFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "preExistingConditions" TEXT,
    "preExistingReviewed" BOOLEAN NOT NULL DEFAULT false,
    "currentWorkStatus" TEXT,
    "disabilityReason" TEXT,
    "functionalLimitations" TEXT,
    "injurySpecialty" "InjurySpecialty" NOT NULL DEFAULT 'GENERAL',
    "specialty" TEXT,
    "additionalSpecialties" JSONB,
    "status" "CaseStatus" NOT NULL DEFAULT 'INTAKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "userId" TEXT,
    "metric" "UsageMetric" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "period" TEXT NOT NULL,
    "caseId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "caseId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "ocrConfidence" DOUBLE PRECISION,
    "storageKey" TEXT,
    "extractedText" TEXT,
    "provider" TEXT,
    "serviceDate" TIMESTAMP(3),
    "serviceDateEnd" TIMESTAMP(3),
    "datePages" JSONB,
    "authorName" TEXT,
    "authorCredentials" TEXT,
    "authorRole" TEXT,
    "facility" TEXT,
    "providers" JSONB,
    "locations" JSONB,
    "flags" TEXT,
    "classifiedBy" TEXT,
    "classifyScore" DOUBLE PRECISION,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChronologyEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "eventType" TEXT,
    "provider" TEXT,
    "specialty" TEXT,
    "recordType" TEXT,
    "summary" TEXT NOT NULL,
    "objectiveFindings" TEXT,
    "diagnosis" TEXT,
    "treatment" TEXT,
    "imagingFindings" TEXT,
    "medications" TEXT,
    "restrictions" TEXT,
    "workStatus" TEXT,
    "functionalStatus" TEXT,
    "sourceDocumentId" TEXT,
    "sourcePage" INTEGER,
    "sourceQuote" TEXT,
    "dateInferred" BOOLEAN NOT NULL DEFAULT false,
    "relevanceScore" INTEGER NOT NULL DEFAULT 50,
    "relatedness" "Relatedness" NOT NULL DEFAULT 'UNCLEAR',
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChronologyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relatedness" "Relatedness" NOT NULL DEFAULT 'UNCLEAR',
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "supportingRecords" TEXT,
    "opposingRecords" TEXT,
    "objectiveEvidence" TEXT,
    "missingInfo" TEXT,
    "reasoning" TEXT,
    "physicianConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FutureCareItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "conditionId" TEXT,
    "category" "CareCategory" NOT NULL,
    "service" TEXT NOT NULL,
    "rationale" TEXT,
    "specialty" TEXT,
    "cptCode" TEXT,
    "probability" "Probability" NOT NULL DEFAULT 'POSSIBLE',
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "frequencyPerYear" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "startTrigger" TEXT,
    "durationYears" DOUBLE PRECISION,
    "isLifetime" BOOLEAN NOT NULL DEFAULT false,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "annualCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lifetimeCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "presentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lowCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "highCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pricingSource" TEXT,
    "evidenceStrength" TEXT,
    "literatureSupport" TEXT,
    "lowerCostAlternative" TEXT,
    "plaintiffValue" TEXT,
    "defenseVulnerability" "Vulnerability" NOT NULL DEFAULT 'LOW',
    "missingSupport" TEXT,
    "physicianStatus" "PhysicianStatus" NOT NULL DEFAULT 'PENDING',
    "physicianNote" TEXT,
    "physicianSummary" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FutureCareItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "ReviewKind" NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "vulnerability" "Vulnerability" NOT NULL DEFAULT 'MODERATE',
    "relatedItemId" TEXT,
    "side" TEXT,
    "sourceRef" TEXT,
    "counterArgument" TEXT,
    "counterSource" TEXT,
    "counterCitation" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportExport" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "template" "CaseSide" NOT NULL DEFAULT 'PLAINTIFF',
    "version" INTEGER NOT NULL DEFAULT 1,
    "storageKey" TEXT,
    "generatedById" TEXT,
    "totalLifetimeCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPresentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Firm_slug_key" ON "Firm"("slug");

-- CreateIndex
CREATE INDEX "Firm_slug_idx" ON "Firm"("slug");

-- CreateIndex
CREATE INDEX "PrecedentPlan_firmId_createdAt_idx" ON "PrecedentPlan"("firmId", "createdAt");

-- CreateIndex
CREATE INDEX "PrecedentPlan_firmId_injurySpecialty_idx" ON "PrecedentPlan"("firmId", "injurySpecialty");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_firmId_key" ON "Subscription"("firmId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_inviteToken_key" ON "User"("inviteToken");

-- CreateIndex
CREATE INDEX "User_firmId_idx" ON "User"("firmId");

-- CreateIndex
CREATE INDEX "User_inviteToken_idx" ON "User"("inviteToken");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_tokenHash_idx" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "Case_firmId_idx" ON "Case"("firmId");

-- CreateIndex
CREATE INDEX "Case_firmId_status_idx" ON "Case"("firmId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Case_firmId_caseNumber_key" ON "Case"("firmId", "caseNumber");

-- CreateIndex
CREATE INDEX "UsageRecord_firmId_period_idx" ON "UsageRecord"("firmId", "period");

-- CreateIndex
CREATE INDEX "UsageRecord_firmId_metric_period_idx" ON "UsageRecord"("firmId", "metric", "period");

-- CreateIndex
CREATE INDEX "AuditLog_firmId_createdAt_idx" ON "AuditLog"("firmId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_firmId_action_idx" ON "AuditLog"("firmId", "action");

-- CreateIndex
CREATE INDEX "Document_caseId_idx" ON "Document"("caseId");

-- CreateIndex
CREATE INDEX "Document_firmId_idx" ON "Document"("firmId");

-- CreateIndex
CREATE INDEX "ChronologyEvent_caseId_eventDate_idx" ON "ChronologyEvent"("caseId", "eventDate");

-- CreateIndex
CREATE INDEX "Condition_caseId_idx" ON "Condition"("caseId");

-- CreateIndex
CREATE INDEX "FutureCareItem_caseId_idx" ON "FutureCareItem"("caseId");

-- CreateIndex
CREATE INDEX "ReviewFinding_caseId_kind_idx" ON "ReviewFinding"("caseId", "kind");

-- CreateIndex
CREATE INDEX "ReportExport_caseId_idx" ON "ReportExport"("caseId");

-- CreateIndex
CREATE INDEX "ReportExport_firmId_idx" ON "ReportExport"("firmId");

-- AddForeignKey
ALTER TABLE "PrecedentPlan" ADD CONSTRAINT "PrecedentPlan_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChronologyEvent" ADD CONSTRAINT "ChronologyEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FutureCareItem" ADD CONSTRAINT "FutureCareItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FutureCareItem" ADD CONSTRAINT "FutureCareItem_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "Condition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

