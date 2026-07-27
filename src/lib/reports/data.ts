import { prisma } from "@/lib/db";
import {
  runIntegrityCheck,
  hasPatientRecordSupport,
  type RecInput,
  type CondInput,
  type IntegrityReport,
} from "@/lib/engine/integrity";

// ─────────────────────────────────────────────────────────────────────────────
// Report Library — single data loader (docs/22 §2).
//
// One query mirroring the legacy buildReportDocx include, plus the persisted
// clinical-reasoning assessments and the recommendation-transition ledger.
// Everything downstream (sections.ts, registry.ts composes) is pure and reads
// exclusively from this shape — no recomputation of stored facts, no second
// query path that could disagree with the Life Care Plan.
//
// Types are structural ("loose but useful") rather than Prisma-generated so
// that section builders and tests can construct ReportData without a database.
// ─────────────────────────────────────────────────────────────────────────────

export interface RDFirm {
  name: string;
  letterhead?: string | null;
}

export interface RDPerson {
  name: string | null;
}

export interface RDDocument {
  id: string;
  filename: string;
  type?: string | null;
  pageCount?: number | null;
  serviceDate?: Date | null;
  serviceDateEnd?: Date | null;
  authorName?: string | null;
  authorRole?: string | null;
  providers?: unknown;
}

export interface RDChronoEvent {
  id: string;
  eventDate: Date;
  eventDateEnd?: Date | null;
  eventType?: string | null;
  provider?: string | null;
  specialty?: string | null;
  facility?: string | null;
  recordType?: string | null;
  summary: string;
  subjective?: string | null;
  pastMedicalHistory?: string | null;
  objectiveFindings?: string | null;
  diagnosis?: string | null;
  treatment?: string | null;
  procedure?: string | null;
  disposition?: string | null;
  imagingFindings?: string | null;
  medications?: string | null;
  restrictions?: string | null;
  workStatus?: string | null;
  functionalStatus?: string | null;
  impairmentRating?: string | null;
  clinicalSignificance?: string | null;
  sourceDocumentId?: string | null;
  sourcePage?: number | null;
  sourceQuote?: string | null;
}

/** { documentId?, filename?, page?, quote? } rows stored on Condition.evidenceSources. */
export interface RDEvidenceSource {
  documentId?: string;
  filename?: string;
  page?: number | null;
  quote?: string;
}

export interface RDCondition {
  id: string;
  name: string;
  relatedness: string;
  confidence?: number;
  supportingRecords?: string | null;
  opposingRecords?: string | null;
  objectiveEvidence?: string | null;
  evidenceSources?: unknown;
  missingInfo?: string | null;
  reasoning?: string | null;
  physicianConfirmed?: boolean;
}

export interface RDFutureCareItem {
  id: string;
  conditionId?: string | null;
  condition?: RDCondition | null;
  category: string;
  service: string;
  rationale?: string | null;
  specialty?: string | null;
  cptCode?: string | null;
  probability: string;
  confidence?: number;
  frequencyPerYear: number;
  durationYears?: number | null;
  isLifetime: boolean;
  startTrigger?: string | null;
  prerequisite?: string | null;
  earliestTiming?: string | null;
  replacesService?: string | null;
  contingencyOnly?: boolean;
  unitCost: number;
  annualCost: number;
  lifetimeCost: number;
  presentValue: number;
  lowCost?: number;
  highCost?: number;
  pricingSource?: string | null;
  evidenceStrength?: string | null;
  literatureSupport?: string | null;
  citation?: unknown;
  lowerCostAlternative?: string | null;
  missingSupport?: string | null;
  origin?: string | null;
  templateRuleId?: string | null;
  physicianStatus: string;
  physicianNote?: string | null;
}

export interface RDTreatingProvider {
  id: string;
  name: string;
  credentials?: string | null;
  specialty?: string | null;
  facility?: string | null;
  status?: string;
}

export interface RDInterviewFinding {
  id: string;
  subject: string; // PATIENT | PROVIDER
  providerId?: string | null;
  category?: string | null;
  text: string;
  quote?: string | null;
  interviewDate?: Date | null;
  conditionId?: string | null;
  futureCareItemId?: string | null;
}

export interface RDAttestation {
  id: string;
  physicianName: string;
  physicianRole?: string;
  statementText: string;
  physicianNote?: string | null;
  itemCount: number;
  totalPresentValue: number;
  contentHash: string;
  signedAt: Date;
  status?: string;
  scope?: unknown;
}

export interface RDAssessment {
  id: string;
  recommendationId: string;
  recommendationService: string;
  status?: string;
  medicalNecessityRationale?: string | null;
  noTreatmentRisk?: string | null;
  probabilityClassification?: string;
  inclusionRationale?: string | null;
  weakeningEvidence?: unknown; // string[] or { text, source }[]
  unknowns?: unknown; // string[]
  missingEvidenceRequests?: unknown;
  alternativesConsidered?: unknown; // { alternative, rationale }[]
  evidenceSufficiency?: unknown; // { score?, verdict?, missing?: string[] , ... }
  supportingLiteratureAssessments?: unknown; // thin refs: { title, pmid?, doi?, supports? }[]
  rejectedLiterature?: unknown; // { title, pmid?, reason }[]
  literatureSynthesis?: string | null;
  residualUncertainty?: string | null;
  evidenceStrength?: string;
  recommendationConfidence?: string;
  confidenceExplanation?: string | null;
  generatedByModel?: string | null;
  supersededById?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface RDTransition {
  id: string;
  lineageId: string;
  itemId: string;
  userId?: string | null;
  role?: string | null;
  priorStatus: string;
  newStatus: string;
  comment?: string | null;
  reasonCode?: string | null;
  modifiedFields?: unknown; // legacy string[] | [{ field, from, to }]
  materialChange?: boolean;
  createdAt: Date;
}

export interface RDCase {
  id: string;
  caseNumber: string;
  clientName: string;
  dateOfBirth?: Date | null;
  sex: string;
  caseType: string;
  jurisdiction?: string | null;
  dateOfInjury?: Date | null;
  mechanism?: string | null;
  diagnosis?: string | null;
  icd10Code?: string | null;
  additionalDiagnoses?: unknown;
  lifeExpectancyYears?: number | null;
  discountRate?: number;
  medicalInflation?: number;
  preExistingConditions?: string | null;
  currentWorkStatus?: string | null;
  functionalLimitations?: string | null;
  /** Last case mutation — drives the preview validation-freshness stamp. The
   *  loader's full-row query always returns it; optional for test fixtures. */
  updatedAt?: Date | null;
  firm: RDFirm;
  createdBy: RDPerson | null;
  preparingPhysician?: (RDPerson & { credentialSummary?: string | null }) | null;
  documents: RDDocument[];
  chronologyEvents: RDChronoEvent[];
  conditions: RDCondition[];
  futureCareItems: RDFutureCareItem[];
  treatingProviders: RDTreatingProvider[];
  interviewFindings: RDInterviewFinding[];
  attestations: RDAttestation[];
}

export interface ReportData {
  case: RDCase;
  /** Latest non-superseded ClinicalReasoningAssessment per recommendationId. */
  assessments: RDAssessment[];
  /** Full recommendation-transition ledger, oldest first. */
  transitions: RDTransition[];
  /** Deterministic integrity check — computed exactly as the legacy report does. */
  integrity: IntegrityReport;
  /** FutureCareItem ids the integrity check admits into the damages totals. */
  includedIds: Set<string>;
}

// ── Integrity (shared with fixtures/tests — pure) ───────────────────────────

/**
 * Run the integrity check with the SAME inputs the legacy buildReportDocx uses
 * (current recommendations + conditions + the shared record-support rule) and
 * derive the set of item ids admitted into the totals.
 */
export function computeIntegrity(
  items: RDFutureCareItem[],
  conditions: RDCondition[],
): { integrity: IntegrityReport; includedIds: Set<string> } {
  const hasRecordSupport = (rec: RecInput, matched: CondInput | null): boolean =>
    hasPatientRecordSupport(
      rec as unknown as { missingSupport?: string | null; confidence?: number },
      matched as (CondInput & { evidenceSources?: unknown }) | null,
    );
  const integrity = runIntegrityCheck({
    recommendations: items as unknown as RecInput[],
    conditions: conditions as unknown as CondInput[],
    hasRecordSupport,
  });
  const includedIds = new Set<string>();
  for (const it of items) {
    const per = integrity.perItem.get(it as unknown as RecInput);
    if (per?.includedInTotal) includedIds.add(it.id);
  }
  return { integrity, includedIds };
}

// ── Origin labels (docs/22 §5) ──────────────────────────────────────────────

const ORIGIN_LABEL: Record<string, string> = {
  TEMPLATE_CONDITION: "System generated (care library)",
  TEMPLATE_BASELINE: "System generated (baseline)",
  TEMPLATE_SPECIALTY: "System generated (specialty pack)",
  PHYSICIAN_ADDED: "Physician reviewer",
  GOLD_IMPORT: "Imported source",
};

/** Human label for a recommendation's provenance (RecommendationOrigin). */
export function originLabel(item: Pick<RDFutureCareItem, "origin">): string {
  return ORIGIN_LABEL[item.origin ?? ""] ?? "Unknown";
}

// ── Loader ──────────────────────────────────────────────────────────────────

/**
 * Load everything any registered report can need, in one case query (mirroring
 * buildReportDocx's include) plus the persisted assessments and the transition
 * ledger, then compute the integrity view exactly as the legacy report does.
 */
export async function loadReportData(caseId: string): Promise<ReportData> {
  const c = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      firm: true,
      createdBy: { select: { name: true } },
      preparingPhysician: {
        select: {
          name: true,
          role: true,
          credentialSummary: true,
          credentials: { select: { id: true, type: true, label: true, filename: true }, orderBy: { createdAt: "asc" } },
        },
      },
      chronologyEvents: { orderBy: { eventDate: "asc" } },
      conditions: { orderBy: { confidence: "desc" } },
      futureCareItems: { where: { supersededAt: null }, orderBy: { presentValue: "desc" }, include: { condition: true } },
      reviewFindings: true,
      documents: { orderBy: { createdAt: "asc" } },
      treatingProviders: { where: { status: "CONFIRMED" }, orderBy: { createdAt: "asc" } },
      interviewFindings: { orderBy: { createdAt: "asc" } },
      attestations: { where: { status: "ACTIVE" }, orderBy: { signedAt: "desc" } },
    },
  });

  // Latest live assessment per recommendation: non-superseded rows only, then
  // keep the newest per recommendationId (defensive — the persistence layer
  // already supersedes prior rows).
  const assessmentRows = await prisma.clinicalReasoningAssessment.findMany({
    where: { caseId, status: { not: "SUPERSEDED" }, supersededById: null },
    orderBy: { updatedAt: "asc" },
  });
  const latestByRec = new Map<string, (typeof assessmentRows)[number]>();
  for (const row of assessmentRows) latestByRec.set(row.recommendationId, row);

  const transitions = await prisma.recommendationTransition.findMany({
    where: { caseId },
    orderBy: { createdAt: "asc" },
  });

  const caseData = c as unknown as RDCase;
  const { integrity, includedIds } = computeIntegrity(caseData.futureCareItems, caseData.conditions);

  return {
    case: caseData,
    assessments: [...latestByRec.values()] as unknown as RDAssessment[],
    transitions: transitions as unknown as RDTransition[],
    integrity,
    includedIds,
  };
}
