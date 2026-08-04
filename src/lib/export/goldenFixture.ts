// ─────────────────────────────────────────────────────────────────────────────
// Golden-file fixture for the Life Care Plan DOCX regression test
// (goldenLcp.test.ts). A complete, deterministic, in-memory case satisfying the
// exact `include` shape of buildReportDocx's prisma.case.findUniqueOrThrow —
// firm, createdBy, preparingPhysician (with credentials), 2 conditions with
// page-cited evidence sources, 4 future-care items across review statuses
// (APPROVED / MODIFIED / PENDING contingency-only / REJECTED), 3 chronology
// events, 2 documents, 1 CONFIRMED treating provider, 2 interview findings, and
// 1 ACTIVE attestation whose scope, statement, and content hash are computed
// with the real attestation engine so the signature VERIFIES at render time.
//
// Every date is fixed. Nothing here depends on Date.now() — the test freezes
// the clock for the report's own `new Date()` calls (title-page report date,
// running header, patient age).
// ─────────────────────────────────────────────────────────────────────────────

import { buildAttestationScope, attestationStatement, attestationContentHash, type AttestableItem } from "@/lib/engine/attestation";

export const GOLDEN_CASE_ID = "case-golden-lcp-0001";

const D = (s: string) => new Date(s);
const CREATED = D("2025-01-15T12:00:00Z");

// ── Preparing physician ──────────────────────────────────────────────────────
const PHYSICIAN_NAME = "Jonathan A. Meyer, MD";
const CREDENTIAL_SUMMARY =
  "I am a board-certified orthopaedic surgeon with subspecialty training in adult reconstruction and more than twenty years of clinical practice";

// ── Future-care items (ordered by presentValue desc, as the query would) ─────
function goldenFutureCareItems() {
  const base = {
    caseId: GOLDEN_CASE_ID,
    pricedAt: null as Date | null,
    pricingDetail: null,
    lowerCostAlternative: null as string | null,
    plaintiffValue: null as string | null,
    missingSupport: null as string | null,
    replacesService: null as string | null,
    templateRuleId: null as string | null,
    conditionKey: null as string | null,
    physicianSummary: null as string | null,
    supersededById: null as string | null,
    supersededAt: null as Date | null,
    edited: false,
    createdAt: CREATED,
  };
  return [
    {
      ...base,
      id: "fci-golden-1",
      conditionId: "cond-golden-knee",
      category: "REVISION_SURGERY",
      service: "Revision total knee arthroplasty",
      rationale:
        "The index arthroplasty has a finite survivorship; given the patient's age at implantation, the implant will more likely than not require revision within her remaining lifetime.",
      specialty: "Orthopedic Surgery",
      cptCode: "27487",
      probability: "PROBABLE",
      confidence: 85,
      frequencyPerYear: 1,
      startTrigger: null as string | null,
      durationYears: null as number | null,
      isLifetime: false,
      unitCost: 118400,
      annualCost: 118400,
      lifetimeCost: 129600,
      presentValue: 104900,
      lowCost: 89165,
      highCost: 131125,
      pricingSource: "FAIR Health UCR, revision arthroplasty global (CPT 27487)",
      evidenceStrength: "Guideline-supported",
      literatureSupport: "Registry survivorship literature",
      citation: [
        {
          source: "europepmc",
          title: "Survivorship of revision total knee arthroplasty: a systematic review of registry data",
          authors: "Deere K, Whitehouse MR",
          journal: "Bone Joint J",
          year: "2021",
          pmid: "34334044",
        },
      ],
      defenseVulnerability: "MODERATE",
      prerequisite: null as string | null,
      earliestTiming: "Approximately 12-15 years after the index arthroplasty, per implant survivorship data",
      contingencyOnly: false,
      origin: "TEMPLATE_CONDITION",
      physicianStatus: "APPROVED",
      physicianNote: null as string | null,
      lineageId: "lin-golden-1",
      version: 2,
      lifecycleStatus: "PHYSICIAN_APPROVED",
    },
    {
      ...base,
      id: "fci-golden-3",
      conditionId: "cond-golden-spine",
      category: "INJECTION",
      service: "Lumbar transforaminal epidural steroid injection",
      rationale:
        "Held as a contingency for recurrent radicular pain referable to the documented L4-L5 herniation, consistent with interventional spine guidelines.",
      specialty: "Pain Management",
      cptCode: "64483",
      probability: "POSSIBLE",
      confidence: 62,
      frequencyPerYear: 2,
      startTrigger: "Recurrence of lumbar radicular pain refractory to oral medication",
      durationYears: 5,
      isLifetime: false,
      unitCost: 1850,
      annualCost: 3700,
      lifetimeCost: 19800,
      presentValue: 17600,
      lowCost: 14960,
      highCost: 22000,
      pricingSource: "FAIR Health UCR, transforaminal epidural injection (CPT 64483)",
      evidenceStrength: "Guideline-supported",
      literatureSupport: null as string | null,
      citation: null,
      defenseVulnerability: "MODERATE",
      prerequisite: "Failure of a structured course of conservative management",
      earliestTiming: "Within 2-5 years of the date of this report",
      contingencyOnly: true,
      origin: "TEMPLATE_CONDITION",
      physicianStatus: "PENDING",
      physicianNote: null as string | null,
      lineageId: "lin-golden-3",
      version: 1,
      lifecycleStatus: "SENT_FOR_PHYSICIAN_REVIEW",
    },
    {
      ...base,
      id: "fci-golden-4",
      conditionId: "cond-golden-spine",
      category: "IMAGING",
      service: "Surveillance MRI of the lumbar spine",
      rationale: "Proposed interval imaging of the documented L4-L5 herniation.",
      specialty: "Radiology",
      cptCode: "72148",
      probability: "POSSIBLE",
      confidence: 55,
      frequencyPerYear: 1,
      startTrigger: null as string | null,
      durationYears: 10,
      isLifetime: false,
      unitCost: 1350,
      annualCost: 1350,
      lifetimeCost: 15600,
      presentValue: 13900,
      lowCost: 11815,
      highCost: 17375,
      pricingSource: "FAIR Health / CMS diagnostic fee schedule (CPT 72148)",
      evidenceStrength: null as string | null,
      literatureSupport: null as string | null,
      citation: null,
      defenseVulnerability: "HIGH",
      prerequisite: null as string | null,
      earliestTiming: null as string | null,
      contingencyOnly: false,
      origin: "TEMPLATE_BASELINE",
      physicianStatus: "REJECTED",
      physicianNote: "Routine surveillance imaging is not indicated absent new neurologic findings.",
      lineageId: "lin-golden-4",
      version: 1,
      lifecycleStatus: "PHYSICIAN_REJECTED",
    },
    {
      ...base,
      id: "fci-golden-2",
      conditionId: "cond-golden-knee",
      category: "PHYSICAL_THERAPY",
      service: "Physical therapy program, knee",
      rationale:
        "Structured therapeutic exercise maintains quadriceps strength and range of motion and is the standard adjunct following knee arthroplasty.",
      specialty: "Physical Therapy",
      cptCode: "97110",
      probability: "PROBABLE",
      confidence: 78,
      frequencyPerYear: 24,
      startTrigger: null as string | null,
      durationYears: 3,
      isLifetime: false,
      unitCost: 145,
      annualCost: 3480,
      lifetimeCost: 11240,
      presentValue: 10460,
      lowCost: 8891,
      highCost: 13075,
      pricingSource: "CMS Physician Fee Schedule, therapeutic exercise (CPT 97110)",
      evidenceStrength: "Guideline-supported",
      literatureSupport: null as string | null,
      citation: null,
      defenseVulnerability: "LOW",
      prerequisite: null as string | null,
      earliestTiming: null as string | null,
      contingencyOnly: false,
      origin: "TEMPLATE_CONDITION",
      physicianStatus: "MODIFIED",
      physicianNote: "Frequency reduced from 36 to 24 visits per year.",
      lineageId: "lin-golden-2",
      version: 3,
      lifecycleStatus: "PHYSICIAN_MODIFIED",
    },
  ];
}

/** Present value the plan will total (APPROVED + MODIFIED items only). */
export const GOLDEN_TOTALS = {
  presentValue: 104900 + 10460, // 115360
  lifetime: 129600 + 11240, // 140840
};

// ── Attestation (computed with the real engine so it verifies) ───────────────
function goldenAttestation(items: ReturnType<typeof goldenFutureCareItems>) {
  const scope = buildAttestationScope(items as unknown as AttestableItem[]);
  const totalPresentValue = scope.reduce((s, e) => s + e.presentValue, 0);
  const statementText = attestationStatement({
    physicianName: PHYSICIAN_NAME,
    credentialSummary: CREDENTIAL_SUMMARY,
    clientName: "Margaret Ellison",
    caseNumber: "LCP-2025-0042",
    scope,
    totalPresentValue,
  });
  const contentHash = attestationContentHash(statementText, scope);
  return {
    id: "att-golden-1",
    firmId: "firm-golden",
    caseId: GOLDEN_CASE_ID,
    physicianId: "user-golden-md",
    physicianName: PHYSICIAN_NAME,
    physicianRole: "PHYSICIAN",
    credentialSummary: CREDENTIAL_SUMMARY,
    credentialDocs: [{ type: "BOARD_CERTIFICATION", label: "ABOS - Orthopaedic Surgery", filename: "meyer-abos-certificate.pdf" }],
    statementText,
    physicianNote: null as string | null,
    scope,
    itemCount: scope.length,
    totalPresentValue,
    caseVersion: 1,
    contentHash,
    // cfp-1 binding fields — the binding VERIFIER is mocked in the golden
    // suites (it has its own dedicated test suite); the core gate still
    // requires these to be present and scope-covering.
    clinicalFingerprint: "cfp-1:golden-fixture",
    bindingVersion: "cfp-1",
    opinionScopes: ["FUTURE_CARE_MEDICAL_NECESSITY", "FREQUENCY_AND_DURATION"],
    status: "ACTIVE",
    invalidatedAt: null as Date | null,
    invalidatedReason: null as string | null,
    supersededById: null as string | null,
    signedAt: D("2025-12-01T15:30:00Z"),
    createdAt: D("2025-12-01T15:30:00Z"),
  };
}

/** The attestation content hash printed in the report (for test assertions). */
export function goldenAttestationHash(): string {
  return goldenAttestation(goldenFutureCareItems()).contentHash;
}

// ── The full case, in the exact shape of the report's `include` ──────────────
export function goldenCase() {
  const futureCareItems = goldenFutureCareItems();
  return {
    id: GOLDEN_CASE_ID,
    firmId: "firm-golden",
    createdById: "user-golden-planner",
    preparingPhysicianId: "user-golden-md",
    caseNumber: "LCP-2025-0042",
    clientName: "Margaret Ellison",
    dateOfBirth: D("1969-04-12T00:00:00Z"),
    sex: "FEMALE",
    caseType: "PERSONAL_INJURY",
    side: "PLAINTIFF",
    jurisdiction: "State of Georgia",
    zipCode: "30327",
    dateOfInjury: D("2023-06-01T00:00:00Z"),
    mechanism: "A motor-vehicle collision in which her vehicle was struck on the driver's side",
    diagnosis: "Left knee post-traumatic osteoarthritis",
    icd10Code: "M17.31",
    additionalDiagnoses: [{ diagnosis: "Lumbar disc herniation at L4-L5 with radiculopathy", icd10Code: "M51.16" }],
    lifeExpectancyYears: 27.4,
    lifeExpectancyBasis: {
      method: "ACTUARIAL_BASELINE",
      baselineYears: 27.4,
      baselineLabel: "SSA period life table (2021), age 55, female",
      baselineCitation:
        "Social Security Administration, Actuarial Life Table (2021 period life table), ssa.gov/oact/STATS/table4c6.html",
      ageAtDetermination: 55,
      sex: "FEMALE",
      adjustments: [],
      determinedYears: 27.4,
      note: null,
      approvedByName: PHYSICIAN_NAME,
      approvedByRole: "PHYSICIAN",
      approvedById: "user-golden-md",
      approvedAt: "2025-11-20T00:00:00Z",
    },
    discountRate: 0.03,
    medicalInflation: 0.032,
    geographicFactor: 1.0,
    preExistingConditions: "Hypertension; Type 2 diabetes mellitus",
    preExistingReviewed: true,
    currentWorkStatus: "Employed",
    disabilityReason: null,
    functionalLimitations:
      "Ambulates with a single-point cane for community distances; standing tolerance limited to 30 minutes; unable to descend stairs reciprocally; lifting restricted to 10 pounds.",
    injurySpecialty: "KNEE_ARTHROPLASTY",
    specialty: "Orthopedic Surgery",
    additionalSpecialties: null,
    status: "REVIEW",
    createdAt: CREATED,
    updatedAt: CREATED,

    // ── Relations (in the report query's shapes and sort orders) ─────────────
    firm: {
      id: "firm-golden",
      name: "Meridian Life Care Planning",
      letterhead: null as string | null,
    },
    createdBy: { name: "Alexandra Pierce" },
    preparingPhysician: {
      name: PHYSICIAN_NAME,
      role: "PHYSICIAN",
      credentialSummary: CREDENTIAL_SUMMARY,
      credentials: [
        { id: "cred-golden-1", type: "BOARD_CERTIFICATION", label: "ABOS - Orthopaedic Surgery", filename: "meyer-abos-certificate.pdf" },
      ],
    },
    chronologyEvents: [
      {
        id: "evt-golden-1",
        caseId: GOLDEN_CASE_ID,
        eventDate: D("2023-06-01T00:00:00Z"),
        eventDateEnd: null as Date | null,
        eventType: "ER_VISIT",
        provider: "Daniel Okafor, MD",
        specialty: "Emergency Medicine",
        facility: "Northside Regional Medical Center",
        recordType: "ER record",
        summary: "Emergency evaluation following a motor-vehicle collision.",
        subjective: "Left knee pain and low back pain following a motor-vehicle collision earlier the same day.",
        pastMedicalHistory: "Hypertension; type 2 diabetes mellitus. No prior knee or low-back complaints documented.",
        objectiveFindings:
          "Left knee effusion with range of motion limited to 10-90 degrees; antalgic gait; lumbar paraspinal tenderness with positive straight-leg raise on the left.",
        diagnosis: "Left knee internal derangement; lumbar disc herniation with left L5 radiculopathy.",
        treatment: "Knee immobilizer, analgesia, and referral to orthopedic surgery and pain management.",
        procedure: null as string | null,
        disposition: "Discharged home in stable condition with outpatient follow-up.",
        imagingFindings:
          "Radiographs of the left knee demonstrate a lateral tibial plateau impaction injury; MRI of the lumbar spine demonstrates an L4-L5 posterolateral disc herniation abutting the traversing left L5 nerve root.",
        medications: null as string | null,
        restrictions: null as string | null,
        workStatus: null as string | null,
        functionalStatus: null as string | null,
        impairmentRating: null as string | null,
        clinicalSignificance:
          "This encounter establishes the injury mechanism and the initial objective findings in both the left knee and the lumbar spine.",
        sourceDocumentId: "doc-golden-1",
        sourcePage: 4,
        sourceQuote: null as string | null,
        dateInferred: false,
        relevanceScore: 90,
        relatedness: "RELATED",
        edited: false,
        createdAt: CREATED,
      },
      {
        id: "evt-golden-2",
        caseId: GOLDEN_CASE_ID,
        eventDate: D("2023-09-15T00:00:00Z"),
        eventDateEnd: null as Date | null,
        eventType: "SURGERY",
        provider: "Robert Chen, MD",
        specialty: "Orthopedic Surgery",
        facility: "Northside Surgery Center",
        recordType: "Operative note",
        summary: "Left total knee arthroplasty.",
        subjective: null as string | null,
        pastMedicalHistory: null as string | null,
        objectiveFindings: null as string | null,
        diagnosis: "Post-traumatic osteoarthritis, left knee.",
        treatment: null as string | null,
        procedure: "Left total knee arthroplasty (CPT 27447); intraoperative grade IV chondral loss of the medial femoral condyle.",
        disposition: "Discharged to home with outpatient physical therapy.",
        imagingFindings: null as string | null,
        medications: null as string | null,
        restrictions: null as string | null,
        workStatus: null as string | null,
        functionalStatus: null as string | null,
        impairmentRating: null as string | null,
        clinicalSignificance:
          "The index arthroplasty establishes the implant whose finite survivorship drives the projected revision arthroplasty.",
        sourceDocumentId: "doc-golden-2",
        sourcePage: 1,
        sourceQuote: null as string | null,
        dateInferred: false,
        relevanceScore: 95,
        relatedness: "RELATED",
        edited: false,
        createdAt: CREATED,
      },
      {
        id: "evt-golden-3",
        caseId: GOLDEN_CASE_ID,
        eventDate: D("2024-05-20T00:00:00Z"),
        eventDateEnd: null as Date | null,
        eventType: "CLINIC_VISIT",
        provider: "Robert Chen, MD",
        specialty: "Orthopedic Surgery",
        facility: "Peachtree Orthopedic Clinic",
        recordType: "Orthopedic clinic note",
        summary: "Postoperative orthopedic follow-up.",
        subjective: "Persistent anterior knee pain with stairs; intermittent low back pain radiating to the left calf.",
        pastMedicalHistory: null as string | null,
        objectiveFindings: "Range of motion 5-110 degrees; quadriceps strength 4/5; well-healed incision without effusion.",
        diagnosis: "Status post left total knee arthroplasty; lumbar radiculopathy, symptomatic.",
        treatment: "Continue home exercise program; formal physical therapy; pain-management referral for the lumbar spine.",
        procedure: null as string | null,
        disposition: null as string | null,
        imagingFindings: null as string | null,
        medications: null as string | null,
        restrictions: "No lifting over 10 pounds; no ladder work.",
        workStatus: "Working with restrictions",
        functionalStatus: "Ambulates with a single-point cane for community distances; standing tolerance limited to 30 minutes.",
        impairmentRating: null as string | null,
        clinicalSignificance:
          "Documents the residual functional deficits that ground the projected therapy program and the pain-management contingency.",
        sourceDocumentId: "doc-golden-1",
        sourcePage: 21,
        sourceQuote: null as string | null,
        dateInferred: false,
        relevanceScore: 85,
        relatedness: "RELATED",
        edited: false,
        createdAt: CREATED,
      },
    ],
    conditions: [
      {
        id: "cond-golden-knee",
        caseId: GOLDEN_CASE_ID,
        name: "Left knee post-traumatic osteoarthritis",
        relatedness: "RELATED",
        confidence: 88,
        supportingRecords: "Operative report and serial orthopedic clinic notes",
        opposingRecords: null as string | null,
        objectiveEvidence:
          "Weight-bearing radiographs demonstrate tricompartmental joint-space narrowing; intraoperative findings documented grade IV chondral loss of the medial femoral condyle.",
        evidenceSources: [
          { documentId: "doc-golden-2", filename: "ellison-operative-note-2023-09-15.pdf", page: 3, quote: "Grade IV chondral loss of the medial femoral condyle" },
          { documentId: "doc-golden-1", filename: "ellison-er-record-2023-06-01.pdf", page: 12, quote: "Left knee effusion with limited range of motion" },
        ],
        missingInfo: null as string | null,
        reasoning:
          "The temporal sequence, the absence of any documented prior knee complaint, and the intraoperative findings support causation.",
        socAnalysis: null,
        physicianConfirmed: true,
        createdAt: CREATED,
      },
      {
        id: "cond-golden-spine",
        caseId: GOLDEN_CASE_ID,
        name: "Lumbar disc herniation at L4-L5 with radiculopathy",
        relatedness: "RELATED",
        confidence: 74,
        supportingRecords: "Emergency-department imaging report and subsequent orthopedic documentation",
        opposingRecords: null as string | null,
        objectiveEvidence:
          "MRI of the lumbar spine demonstrates an L4-L5 posterolateral disc herniation abutting the traversing left L5 nerve root; positive straight-leg raise on the left.",
        evidenceSources: [
          { documentId: "doc-golden-1", filename: "ellison-er-record-2023-06-01.pdf", page: 18, quote: "L4-L5 posterolateral disc herniation abutting the traversing left L5 nerve root" },
        ],
        missingInfo: null as string | null,
        reasoning: "Radicular symptoms arose in the immediate post-collision period and correlate with the imaged level.",
        socAnalysis: null,
        physicianConfirmed: false,
        createdAt: CREATED,
      },
    ],
    futureCareItems,
    reviewFindings: [] as unknown[],
    documents: [
      {
        id: "doc-golden-1",
        caseId: GOLDEN_CASE_ID,
        firmId: "firm-golden",
        filename: "ellison-er-record-2023-06-01.pdf",
        type: "ER_RECORD",
        status: "PROCESSED",
        pageCount: 24,
        ocrConfidence: 0.97,
        storageKey: null as string | null,
        extractedText: null as string | null,
        provider: "Northside Regional Medical Center",
        serviceDate: D("2023-06-01T00:00:00Z"),
        serviceDateEnd: null as Date | null,
        datePages: null,
        authorName: "Daniel Okafor, MD",
        authorCredentials: "MD",
        authorRole: "Emergency Medicine",
        facility: "Northside Regional Medical Center",
        providers: null,
        locations: null,
        segments: null,
        flags: null as string | null,
        classifiedBy: "content",
        classifyScore: null as number | null,
        uploadedById: null as string | null,
        createdAt: D("2024-11-01T00:00:00Z"),
      },
      {
        id: "doc-golden-2",
        caseId: GOLDEN_CASE_ID,
        firmId: "firm-golden",
        filename: "ellison-operative-note-2023-09-15.pdf",
        type: "OPERATIVE_NOTE",
        status: "PROCESSED",
        pageCount: 8,
        ocrConfidence: 0.98,
        storageKey: null as string | null,
        extractedText: null as string | null,
        provider: "Northside Surgery Center",
        serviceDate: D("2023-09-15T00:00:00Z"),
        serviceDateEnd: null as Date | null,
        datePages: null,
        authorName: "Robert Chen, MD",
        authorCredentials: "MD",
        authorRole: "Orthopedic Surgeon",
        facility: "Northside Surgery Center",
        providers: null,
        locations: null,
        segments: null,
        flags: null as string | null,
        classifiedBy: "content",
        classifyScore: null as number | null,
        uploadedById: null as string | null,
        createdAt: D("2024-11-02T00:00:00Z"),
      },
    ],
    treatingProviders: [
      {
        id: "tp-golden-1",
        caseId: GOLDEN_CASE_ID,
        firmId: "firm-golden",
        name: "Robert Chen",
        credentials: "MD",
        specialty: "Orthopedic Surgery",
        facility: "Peachtree Orthopedic Clinic",
        contact: null as string | null,
        isTreating: true,
        status: "CONFIRMED",
        nameKey: "robert chen",
        sourceDocumentIds: [{ documentId: "doc-golden-2", filename: "ellison-operative-note-2023-09-15.pdf", pages: [1] }],
        addedById: null as string | null,
        createdAt: CREATED,
      },
    ],
    interviewFindings: [
      {
        id: "if-golden-1",
        caseId: GOLDEN_CASE_ID,
        firmId: "firm-golden",
        subject: "PATIENT",
        providerId: null as string | null,
        category: "Pain",
        text: "Reports daily anterior knee pain rated 5/10, worse with stairs and prolonged standing.",
        quote: "By the end of the day my knee is throbbing and I have to sit down",
        interviewDate: D("2025-11-04T00:00:00Z"),
        interviewedById: null as string | null,
        conditionId: "cond-golden-knee",
        futureCareItemId: null as string | null,
        createdById: null as string | null,
        createdAt: D("2025-11-04T00:00:00Z"),
      },
      {
        id: "if-golden-2",
        caseId: GOLDEN_CASE_ID,
        firmId: "firm-golden",
        subject: "PROVIDER",
        providerId: "tp-golden-1",
        category: "Prognosis",
        text: "Anticipates the patient will outlive the index implant and will require revision arthroplasty.",
        quote: null as string | null,
        interviewDate: D("2025-11-10T00:00:00Z"),
        interviewedById: null as string | null,
        conditionId: null as string | null,
        futureCareItemId: "fci-golden-1",
        createdById: null as string | null,
        createdAt: D("2025-11-10T00:00:00Z"),
      },
    ],
    attestations: [goldenAttestation(futureCareItems)],
  };
}

// ── Persisted Clinical Reasoning Engine rows for the two totaled items ───────
export function goldenAssessments() {
  const base = {
    firmId: "firm-golden",
    caseId: GOLDEN_CASE_ID,
    status: "VALIDATED",
    createdAt: CREATED,
    updatedAt: CREATED,
  };
  return [
    {
      ...base,
      id: "cra-golden-1",
      recommendationId: "fci-golden-1",
      recommendationService: "Revision total knee arthroplasty",
      recommendationLineageId: "lin-golden-1",
      recommendationVersion: 2,
      probabilityClassification: "PROBABLE_INCLUDED",
      inclusionRationale:
        "Given the patient's age at the index arthroplasty and published registry survivorship, revision is more likely than not within her remaining life expectancy; the recommendation was approved on physician review and is included in the totals.",
      evidenceStrength: "STRONG",
      recommendationConfidence: "HIGH",
      residualUncertainty:
        "The precise timing of revision depends on implant wear and activity level; the projection states the expected window rather than a fixed date.",
      alternativesConsidered: [
        {
          alternative: "Nonoperative management with bracing and activity modification",
          rationale:
            "Nonoperative management was considered but does not address aseptic loosening or polyethylene wear once established; it is retained only as an interim measure pending revision.",
        },
      ],
    },
    {
      ...base,
      id: "cra-golden-2",
      recommendationId: "fci-golden-2",
      recommendationService: "Physical therapy program, knee",
      recommendationLineageId: "lin-golden-2",
      recommendationVersion: 3,
      probabilityClassification: "PROBABLE_INCLUDED",
      inclusionRationale:
        "Structured therapeutic exercise is the guideline-standard adjunct after knee arthroplasty and addresses the documented quadriceps weakness; the physician approved the program with a reduced frequency, and it is included in the totals as modified.",
      evidenceStrength: "MODERATE",
      recommendationConfidence: "MODERATE",
      residualUncertainty:
        "The duration of formal therapy beyond the third year depends on the maintenance response to the home exercise program.",
      alternativesConsidered: [] as { alternative: string; rationale: string }[],
    },
  ];
}

/** The same fixture bundled for reuse by scripts/harnesses outside this test. */
export function goldenCaseForHarness() {
  return {
    caseId: GOLDEN_CASE_ID,
    case: goldenCase(),
    assessments: goldenAssessments(),
    validationFindings: [] as unknown[],
    totals: GOLDEN_TOTALS,
  };
}
