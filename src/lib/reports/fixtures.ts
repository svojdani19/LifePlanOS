import { computeIntegrity } from "./data";
import type { RDCase, RDCondition, RDFutureCareItem, ReportData } from "./data";
import type { RDValidationFinding } from "./sections";

// ─────────────────────────────────────────────────────────────────────────────
// Shared test fixture — a realistic knee case built entirely in memory (no DB).
// Three recommendations with distinct origins and review statuses (one
// MODIFIED/included, one REJECTED, one contingency), two conditions with
// paged evidence sources, a structured transition ledger, an attestation,
// imaging/surgery/therapy chronology, and validation findings including one
// export-blocking row. Integrity is computed with the same shared helper the
// production loader uses.
// ─────────────────────────────────────────────────────────────────────────────

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

export function buildConditions(): RDCondition[] {
  return [
    {
      id: "cond-knee",
      name: "Right knee post-traumatic osteoarthritis",
      relatedness: "RELATED",
      confidence: 85,
      supportingRecords: "MRI and operative findings of chondral injury following the index meniscectomy.",
      objectiveEvidence: "Full-thickness chondral loss of the medial femoral condyle on MRI; Outerbridge III-IV changes at arthroscopy.",
      evidenceSources: [
        {
          documentId: "doc-1",
          filename: "MRI_Right_Knee_2023-06-15.pdf",
          page: 3,
          quote: "Complex tear of the medial meniscus with full-thickness chondral loss of the medial femoral condyle.",
        },
        {
          documentId: "doc-2",
          filename: "Operative_Report_2023-08-20.pdf",
          page: 12,
          quote: "Outerbridge grade III-IV chondromalacia of the medial compartment.",
        },
      ],
      reasoning: "Chondral injury documented within weeks of the collision in a previously asymptomatic knee.",
    },
    {
      id: "cond-back",
      name: "Chronic low back pain",
      relatedness: "AGGRAVATION",
      confidence: 60,
      supportingRecords: "Primary-care notes documenting escalation after the collision.",
      objectiveEvidence: "Paraspinal tenderness and reduced lumbar flexion on examination.",
      evidenceSources: [
        { documentId: "doc-3", filename: "PCP_Notes_2023.pdf", page: 7, quote: "Longstanding low back pain, worse since the June collision." },
      ],
      reasoning: "Pre-existing symptoms with a documented post-incident escalation in frequency and intensity.",
    },
  ];
}

export function buildItems(): RDFutureCareItem[] {
  return [
    {
      id: "item-1",
      conditionId: "cond-knee",
      category: "SPECIALIST_VISIT",
      service: "Orthopedic surgeon follow-up visits",
      rationale: "Ongoing orthopedic surveillance of post-traumatic arthritis progression.",
      specialty: "Orthopedic Surgery",
      cptCode: "99213",
      probability: "PROBABLE",
      confidence: 80,
      frequencyPerYear: 2,
      durationYears: null,
      isLifetime: true,
      unitCost: 165,
      annualCost: 330,
      lifetimeCost: 9900,
      presentValue: 7200,
      lowCost: 6100,
      highCost: 8600,
      pricingSource: "FAIR Health, CPT 99213, Atlanta region",
      origin: "TEMPLATE_CONDITION",
      templateRuleId: "knee-oa-followup",
      physicianStatus: "MODIFIED",
      physicianNote: "Concur with ongoing orthopedic surveillance; semiannual frequency is sufficient.",
    },
    {
      id: "item-2",
      conditionId: "cond-knee",
      category: "PHYSICAL_THERAPY",
      service: "Aquatic therapy program",
      rationale: "Low-impact conditioning.",
      specialty: "Physical Therapy",
      cptCode: "97110",
      probability: "POSSIBLE",
      confidence: 55,
      frequencyPerYear: 24,
      durationYears: 2,
      isLifetime: false,
      unitCost: 95,
      annualCost: 2280,
      lifetimeCost: 4560,
      presentValue: 4300,
      pricingSource: "FAIR Health, CPT 97110",
      origin: "GOLD_IMPORT",
      physicianStatus: "REJECTED",
      physicianNote: "Duplicative of the land-based physical therapy program.",
    },
    {
      id: "item-3",
      conditionId: "cond-knee",
      category: "REVISION_SURGERY",
      service: "Revision total knee arthroplasty",
      rationale: "Anticipated revision if the primary implant wears or loosens.",
      specialty: "Orthopedic Surgery",
      cptCode: "27487",
      probability: "POSSIBLE",
      confidence: 60,
      frequencyPerYear: 0,
      durationYears: 0,
      isLifetime: false,
      startTrigger: "Failure or wear of the primary implant",
      prerequisite: "Primary total knee arthroplasty",
      earliestTiming: "~15 years after the primary arthroplasty (implant survivorship)",
      contingencyOnly: true,
      unitCost: 52000,
      annualCost: 0,
      lifetimeCost: 52000,
      presentValue: 42000,
      pricingSource: "FAIR Health, CPT 27487",
      lowerCostAlternative: "Unicompartmental revision if wear is isolated to one compartment.",
      origin: "PHYSICIAN_ADDED",
      physicianStatus: "PENDING",
    },
  ];
}

export function buildFixture(): ReportData {
  const conditions = buildConditions();
  const items = buildItems();

  const c: RDCase = {
    id: "case-1",
    caseNumber: "LCP-2026-0007",
    clientName: "James Holloway",
    dateOfBirth: D("1975-04-12"),
    sex: "MALE",
    caseType: "PERSONAL_INJURY",
    jurisdiction: "Fulton County, Georgia",
    dateOfInjury: D("2023-06-01"),
    mechanism: "motor vehicle collision",
    diagnosis: "Right knee post-traumatic osteoarthritis",
    icd10Code: "M17.31",
    additionalDiagnoses: [{ diagnosis: "Chronic low back pain", icd10Code: "M54.50" }],
    lifeExpectancyYears: 32.4,
    discountRate: 0.03,
    medicalInflation: 0.032,
    preExistingConditions: "Hypertension, Chronic low back pain",
    currentWorkStatus: "Employed",
    functionalLimitations: "Difficulty with stairs and prolonged standing; antalgic gait after long walks.",
    firm: { name: "Georgia Life Care Planning" },
    createdBy: { name: "Case Planner" },
    preparingPhysician: { name: "Dr. Elena Park", credentialSummary: "Board-certified orthopedic surgeon." },
    documents: [
      { id: "doc-1", filename: "MRI_Right_Knee_2023-06-15.pdf", pageCount: 4 },
      { id: "doc-2", filename: "Operative_Report_2023-08-20.pdf", pageCount: 15 },
      { id: "doc-3", filename: "PCP_Notes_2023.pdf", pageCount: 22 },
    ],
    chronologyEvents: [
      {
        id: "evt-1",
        eventDate: D("2023-06-15"),
        eventType: "IMAGING",
        provider: "Radiology Associates",
        specialty: "Radiology",
        recordType: "Imaging report",
        summary: "MRI of the right knee.",
        imagingFindings: "Complex tear of the medial meniscus with full-thickness chondral loss of the medial femoral condyle.",
        clinicalSignificance: "Establishes the structural injury driving the future knee care.",
        sourceDocumentId: "doc-1",
        sourcePage: 3,
        sourceQuote: "Complex tear of the medial meniscus.",
      },
      {
        id: "evt-2",
        eventDate: D("2023-08-20"),
        eventType: "SURGERY",
        provider: "Dr. Elena Park",
        specialty: "Orthopedic Surgery",
        facility: "Atlanta Surgical Center",
        recordType: "Operative report",
        summary: "Right knee arthroscopy.",
        procedure: "Right knee arthroscopic partial medial meniscectomy with chondroplasty.",
        clinicalSignificance: "Operative confirmation of the chondral injury.",
        sourceDocumentId: "doc-2",
        sourcePage: 12,
      },
      {
        id: "evt-3",
        eventDate: D("2023-10-05"),
        eventType: "THERAPY",
        provider: "Peak Physical Therapy",
        specialty: "Physical Therapy",
        recordType: "Therapy notes",
        summary: "Post-operative physical therapy course.",
        treatment: "Physical therapy, 12 sessions, quadriceps strengthening and gait training.",
        functionalStatus: "Antalgic gait; difficulty with stairs.",
        restrictions: "No lifting over 20 pounds.",
        sourceDocumentId: "doc-3",
        sourcePage: 14,
      },
    ],
    conditions,
    futureCareItems: items,
    treatingProviders: [
      {
        id: "tp-1",
        name: "Dr. Elena Park",
        credentials: "MD",
        specialty: "Orthopedic Surgery",
        facility: "Atlanta Surgical Center",
        status: "CONFIRMED",
      },
    ],
    interviewFindings: [
      {
        id: "if-1",
        subject: "PROVIDER",
        providerId: "tp-1",
        category: "Recommendation",
        text: "Recommends continued orthopedic follow-up every six months with weight-bearing radiographs.",
        quote: "I expect to see him twice a year indefinitely.",
        interviewDate: D("2024-05-01"),
        futureCareItemId: "item-1",
      },
      {
        id: "if-2",
        subject: "PATIENT",
        category: "Functional limitations",
        text: "Reports difficulty descending stairs and standing more than 30 minutes.",
        quote: "Stairs are the worst part of my day.",
        interviewDate: D("2024-05-01"),
      },
    ],
    attestations: [
      {
        id: "att-1",
        physicianName: "Dr. Elena Park",
        physicianRole: "PHYSICIAN",
        statementText:
          "I have reviewed each recommendation in this plan and attest that the care I have approved is medically necessary to a reasonable degree of medical probability.",
        physicianNote: null,
        itemCount: 1,
        totalPresentValue: 7200,
        contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        signedAt: D("2024-06-01"),
        status: "ACTIVE",
        scope: [{ itemId: "item-1", service: "Orthopedic surgeon follow-up visits" }],
      },
    ],
  };

  const { integrity, includedIds } = computeIntegrity(items, conditions);

  return {
    case: c,
    assessments: [
      {
        id: "a-1",
        recommendationId: "item-1",
        recommendationService: "Orthopedic surgeon follow-up visits",
        status: "REASONED",
        medicalNecessityRationale:
          "Ongoing orthopedic surveillance is required to monitor progression of post-traumatic arthritis and future arthroplasty candidacy.",
        probabilityClassification: "MEDICALLY_PROBABLE",
        inclusionRationale: "Record-supported and physician-modified; included in totals.",
        weakeningEvidence: [{ text: "A February 2024 note records improved pain control on conservative management", source: "PCP_Notes_2023.pdf, p. 9" }],
        unknowns: ["Current radiographic staging is more than 12 months old"],
        evidenceSufficiency: { score: 78, verdict: "Sufficient", missing: ["Updated weight-bearing radiographs"] },
        supportingLiteratureAssessments: [
          { title: "Long-term outcomes after partial meniscectomy", pmid: "12345678", supports: "progression to symptomatic osteoarthritis" },
        ],
        rejectedLiterature: [{ title: "Pediatric meniscal repair outcomes", pmid: "87654321", reason: "pediatric population, not applicable" }],
        residualUncertainty: "The rate of radiographic progression remains uncertain.",
        evidenceStrength: "MODERATE",
        recommendationConfidence: "HIGH",
      },
      {
        id: "a-3",
        recommendationId: "item-3",
        recommendationService: "Revision total knee arthroplasty",
        status: "REASONED",
        medicalNecessityRationale: "Disclosed as a contingency contingent on primary implant wear; not entered into the totals.",
        probabilityClassification: "POSSIBLE",
        unknowns: ["Implant survivorship depends on activity level and body mass"],
        alternativesConsidered: [{ alternative: "Unicompartmental revision", rationale: "less morbid if wear is isolated to one compartment" }],
      },
    ],
    transitions: [
      {
        id: "t-1",
        lineageId: "lin-1",
        itemId: "item-1",
        role: "system",
        priorStatus: "AI_DRAFT",
        newStatus: "SENT_FOR_PHYSICIAN_REVIEW",
        createdAt: D("2024-05-20"),
      },
      {
        id: "t-2",
        lineageId: "lin-1",
        itemId: "item-1",
        role: "PHYSICIAN",
        priorStatus: "SENT_FOR_PHYSICIAN_REVIEW",
        newStatus: "PHYSICIAN_MODIFIED",
        reasonCode: "FREQUENCY_EXCESSIVE",
        comment: "Reduced from quarterly to semiannual visits.",
        modifiedFields: [{ field: "frequencyPerYear", from: 4, to: 2 }],
        materialChange: true,
        createdAt: D("2024-06-01"),
      },
      {
        id: "t-3",
        lineageId: "lin-2",
        itemId: "item-2",
        role: "PHYSICIAN",
        priorStatus: "SENT_FOR_PHYSICIAN_REVIEW",
        newStatus: "PHYSICIAN_REJECTED",
        reasonCode: "NOT_MEDICALLY_NECESSARY",
        comment: "Duplicative of the land-based physical therapy program.",
        createdAt: D("2024-06-01"),
      },
    ],
    integrity,
    includedIds,
  };
}

/** Persisted-style validation findings: one blocking, one advisory. */
export function buildFindings(): RDValidationFinding[] {
  return [
    {
      service: "Aquatic therapy program",
      result: "Insufficient support",
      issue: "Rejected on physician review; retained for disclosure only.",
      severity: "Moderate",
      suggestion: "Remove or obtain physician endorsement.",
      exportBlocking: false,
    },
    {
      service: "Revision total knee arthroplasty",
      result: "Diagnosis mismatch",
      issue: "A staged surgical item requires an explicit supporting diagnosis confirmation before final export.",
      severity: "Critical",
      suggestion: "Confirm the supporting diagnosis mapping.",
      exportBlocking: true,
    },
  ];
}
