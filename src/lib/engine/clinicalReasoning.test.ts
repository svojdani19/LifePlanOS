import { describe, it, expect } from "vitest";
import { buildReasoningAssessment, type ReasoningItem } from "./clinicalReasoning";
import type { DossierCase, DossierChronoEvent, DossierCondition } from "./medicalNecessity";
import type { CondInput } from "./integrity";

const kase: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };

// A well-documented knee diagnosis: objective imaging, treating records, guideline.
const kneeStrong: CondInput & DossierCondition & { id: string } = {
  id: "cond-knee",
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  supportingRecords: "ORIF operative note; PT gait assessment",
  objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
  evidenceSources: [
    { filename: "mri.pdf", page: 4, quote: "high-grade chondral loss, medial femoral condyle" },
    { filename: "xray.pdf", page: 2, quote: "tricompartmental narrowing" },
  ],
  missingInfo: null,
  reasoning: "Attributed to the tibial plateau fracture.",
  physicianConfirmed: false,
  socAnalysis: { guidelines: [{ title: "AAOS knee osteoarthritis guideline", year: "2023", quote: "Arthroplasty is recommended for end-stage disease.", relevance: { evidenceLevel: 1, evidenceLabel: "Clinical practice guideline", whyRelevant: "guideline; addresses the diagnosis and intervention" } }] },
};

// A knee diagnosis with NO patient-specific support (no records, no objective).
const kneeBare: CondInput & DossierCondition & { id: string } = {
  id: "cond-knee-bare",
  name: "Osteoarthritis of the right knee",
  relatedness: "RELATED",
  supportingRecords: null,
  objectiveEvidence: null,
  evidenceSources: [],
  missingInfo: "No imaging or examination on file.",
  reasoning: "Asserted.",
  physicianConfirmed: false,
};

const chronology: DossierChronoEvent[] = [
  { eventDate: "2024-06-12", provider: "Dr. Brandt", procedure: "Open reduction internal fixation of the tibial plateau", diagnosis: "tibial plateau fracture", sourcePage: 2 },
  { eventDate: "2024-07-15", provider: "PT", functionalStatus: "Antalgic gait; stair negotiation limited to a single flight with rail", diagnosis: "knee", sourcePage: 5 },
  { eventDate: "2024-08-01", imagingFindings: "MRI: high-grade chondral loss of the medial knee compartment", sourcePage: 4 },
];

const strongLiterature = [
  { title: "Total knee arthroplasty survivorship after tibial plateau fracture: a systematic review", year: "2022", pmid: "111", relevance: { evidenceLevel: 3, evidenceLabel: "Systematic review", supports: "the necessity of knee arthroplasty for post-traumatic arthritis", whyRelevant: "systematic review; addresses the diagnosis and intervention", limitations: null } },
];

function tka(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    service: "Total knee arthroplasty",
    category: "ORTHOPEDIC_SURGERY",
    rationale: "end-stage post-traumatic arthritis of the knee",
    cptCode: "27447",
    probability: "PROBABLE",
    frequencyPerYear: 1,
    durationYears: null,
    isLifetime: false,
    unitCost: 42000,
    presentValue: 38000,
    physicianStatus: "PENDING",
    ...overrides,
  };
}

describe("buildReasoningAssessment — probability classification (§7)", () => {
  it("classifies a well-supported, non-staged recommendation as PROBABLE_INCLUDED", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.probabilityClassification).toBe("PROBABLE_INCLUDED");
    expect(a.inclusionInTotalsStatus).toBe("included");
    expect(a.supportingDiagnosisIds).toContain("cond-knee");
  });

  it("classifies a triggered recommendation as CONDITIONAL_STAGED and excludes it from totals", () => {
    const a = buildReasoningAssessment(tka({ startTrigger: "progression to end-stage collapse" }), [kneeStrong], chronology, kase);
    expect(a.probabilityClassification).toBe("CONDITIONAL_STAGED");
    expect(a.inclusionInTotalsStatus).toBe("contingency");
    expect(a.durationClass).toBe("UNTIL_SURGERY");
  });

  it("marks a physician-rejected recommendation REJECTED_BY_REVIEWER", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "REJECTED" }), [kneeStrong], chronology, kase);
    expect(a.probabilityClassification).toBe("REJECTED_BY_REVIEWER");
  });
});

describe("buildReasoningAssessment — frequency support (§10, test #6)", () => {
  it("does NOT treat a frequency as supported when there is no cadence, guideline, or physician review", () => {
    const injections: ReasoningItem = { service: "Genicular nerve block injections", category: "INJECTION", frequencyPerYear: 4, durationYears: 5, isLifetime: false, probability: "POSSIBLE", physicianStatus: "PENDING", cptCode: "64454" };
    const a = buildReasoningAssessment(injections, [kneeBare], [], kase);
    expect(a.frequencySupported).toBe(false);
    expect(a.frequencyRationale).toMatch(/pending review|not yet grounded/i);
  });

  it("treats frequency as supported once a physician has approved it", () => {
    const a = buildReasoningAssessment(tka({ frequencyPerYear: 1, physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.frequencySupported).toBe(true);
    expect(a.frequencyRationale).toMatch(/physician review/i);
  });
});

describe("buildReasoningAssessment — lifetime duration (§11, test #7)", () => {
  it("flags a lifetime duration that rests on limited support", () => {
    const a = buildReasoningAssessment(tka({ service: "Attendant care", category: "ATTENDANT_CARE", isLifetime: true, physicianStatus: "PENDING" }), [kneeBare], [], kase);
    expect(a.durationClass).toBe("LIFETIME");
    expect(a.durationRationale).toMatch(/limited support|needed|defensible/i);
  });

  it("accepts a lifetime duration backed by objective evidence and a guideline", () => {
    const a = buildReasoningAssessment(tka({ service: "Home-based maintenance therapy", category: "PHYSICAL_THERAPY", isLifetime: true, physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.durationClass).toBe("LIFETIME");
    expect(a.durationRationale).toMatch(/supported|chronic|progressive/i);
  });
});

describe("buildReasoningAssessment — evidence strength vs. recommendation confidence (§8, tests #11–#12)", () => {
  it("#11 strong patient-specific evidence yields HIGH confidence even when literature is limited", () => {
    // Records + objective + physician + guideline, but no cited literature study.
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.recommendationConfidence).toBe("HIGH");
    // Literature was NOT the basis — evidence strength rests on expert consensus/guideline, not STRONG literature.
    expect(a.evidenceStrength).not.toBe("STRONG");
    expect(a.supportingLiteratureAssessments.length).toBe(0);
  });

  it("#12 strong literature cannot rescue confidence when there is no patient-specific support", () => {
    // Level-1 literature attached, but the diagnosis has no records/objective/physician support.
    const a = buildReasoningAssessment(tka({ physicianStatus: "PENDING", citation: strongLiterature }), [kneeBare], [], kase);
    expect(a.evidenceStrength).toBe("STRONG"); // the literature itself is strong
    expect(["LOW", "INDETERMINATE"]).toContain(a.recommendationConfidence); // but confidence is not
  });

  it("keeps evidence strength (about the literature) distinct from confidence (about this patient)", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED", citation: strongLiterature }), [kneeStrong], chronology, kase);
    expect(a.evidenceStrength).toBe("STRONG");
    expect(a.recommendationConfidence).toBe("HIGH");
    expect(a.materialHash).toMatch(/^[0-9a-f]+$/);
  });
});
