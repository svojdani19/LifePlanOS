import { describe, it, expect } from "vitest";
import { buildTestimonyEntry, planLevelCrossLines, type TestimonyItemInput, type TestimonyAssessmentInput } from "./testimonyPack";

const baseItem: TestimonyItemInput = {
  id: "r1",
  service: "Pain management office visits",
  category: "PAIN_MANAGEMENT",
  presentValue: 42_000,
  physicianStatus: "PENDING",
  contingencyOnly: false,
};

describe("buildTestimonyEntry", () => {
  it("turns each defense finding into a cross line, answered ONLY by the recorded counter-argument", () => {
    const e = buildTestimonyEntry(
      baseItem,
      null,
      [
        { relatedItemId: "r1", category: "frequency", description: "Monthly visits exceed guideline cadence.", counterArgument: "Documented flare frequency supports monthly follow-up.", counterCitation: "ODG — chronic pain follow-up" },
        { relatedItemId: "r1", category: "duration", description: "Lifetime duration is unsupported.", counterArgument: null },
      ],
      true,
    );
    const withAnswer = e.crossLines.find((l) => l.attack.includes("guideline cadence"));
    expect(withAnswer?.answer).toContain("flare frequency");
    expect(withAnswer?.citation).toContain("ODG");
    const noAnswer = e.crossLines.find((l) => l.attack.includes("Lifetime duration"));
    expect(noAnswer?.answer).toBeNull();
  });

  it("never asserts physician approval that has not occurred", () => {
    const e = buildTestimonyEntry(baseItem, null, [], true);
    const physLine = e.crossLines.find((l) => l.basis === "Physician review status");
    expect(physLine).toBeTruthy();
    expect(physLine!.answer).toMatch(/^Not yet/);
    // No ANSWER may claim approval — the question may ask about it, but every
    // response for a pending item must acknowledge review has not occurred.
    for (const l of e.crossLines) expect((l.answer ?? "").toLowerCase()).not.toMatch(/(has|was|been) approved/);
    // An approved item does not get the pending-review question.
    const approved = buildTestimonyEntry({ ...baseItem, physicianStatus: "APPROVED" }, null, [], true);
    expect(approved.crossLines.find((l) => l.basis === "Physician review status")).toBeUndefined();
  });

  it("a rejected item is disclosed as rejected and excluded — not defended", () => {
    const e = buildTestimonyEntry({ ...baseItem, physicianStatus: "REJECTED" }, null, [], false);
    const line = e.crossLines.find((l) => l.basis === "Physician review status");
    expect(line?.attack).toContain("rejected");
    expect(line?.answer).toContain("not included in the plan totals");
  });

  it("material weakening evidence becomes attack lines; LOW materiality does not", () => {
    const assessment: TestimonyAssessmentInput = {
      recommendationId: "r1",
      selfCritique: { whyRecommended: "Documented refractory pain with objective correlates.", whyPossiblyWrong: [], evidenceAgainst: [], recordsThatWouldChangeConfidence: [], alternativeRecommendation: null, assumptions: [], inferredNotDocumented: [] },
      weakeningEvidence: [
        { claim: "Frequency", detail: "A 6-month gap in treatment", source: "PT notes", page: 12, materiality: "HIGH", reducesConfidence: true, changesInclusion: false, requiresReview: true },
        { claim: "Adherence", detail: "One missed appointment", source: null, page: null, materiality: "LOW", reducesConfidence: false, changesInclusion: false, requiresReview: false },
      ],
    };
    const e = buildTestimonyEntry({ ...baseItem, physicianStatus: "APPROVED" }, assessment, [], true);
    const gap = e.crossLines.find((l) => l.attack.includes("6-month gap"));
    expect(gap).toBeTruthy();
    expect(gap!.basis).toContain("high materiality");
    expect(gap!.answer).toContain("refractory pain");
    expect(e.crossLines.find((l) => l.attack.includes("missed appointment"))).toBeUndefined();
  });

  it("unknowns, assumptions, and inferences become honest concessions", () => {
    const assessment: TestimonyAssessmentInput = {
      recommendationId: "r1",
      selfCritique: { whyRecommended: "x", whyPossiblyWrong: [], evidenceAgainst: [], recordsThatWouldChangeConfidence: [], alternativeRecommendation: null, assumptions: ["Stable renal function"], inferredNotDocumented: ["Failed conservative care inferred from escalation"] },
      unknowns: [{ missing: "Current medication list", whyItMatters: "dosing drives annual cost", likelySource: "pharmacy records", severity: "HIGH", blocksInclusion: false, reducesConfidence: true, suggestedAction: "Request pharmacy printout" }],
      residualUncertainty: "Long-term opioid response remains uncertain.",
    };
    const e = buildTestimonyEntry({ ...baseItem, physicianStatus: "APPROVED" }, assessment, [], true);
    expect(e.concessions.some((c) => c.includes("Current medication list"))).toBe(true);
    expect(e.concessions.some((c) => c.includes("Assumption, not documentation: Stable renal function"))).toBe(true);
    expect(e.concessions.some((c) => c.includes("Inferred rather than documented"))).toBe(true);
    expect(e.concessions.some((c) => c.includes("opioid response"))).toBe(true);
  });

  it("an insufficient sufficiency verdict is surfaced as an attack with the exact missing evidence conceded", () => {
    const assessment: TestimonyAssessmentInput = {
      recommendationId: "r1",
      evidenceSufficiency: { objectiveFindings: 1, imagingSupport: false, examSupport: true, recordSupport: 1, providerConsensus: false, chronologyConsistency: true, conflictingEvidence: 0, score: 40, sufficient: false, threshold: 60, missing: ["Imaging correlating the pain generator"], explanation: "below threshold" },
    };
    const e = buildTestimonyEntry({ ...baseItem, physicianStatus: "APPROVED" }, assessment, [], true);
    expect(e.crossLines.some((l) => l.attack.includes("40/100"))).toBe(true);
    expect(e.concessions.some((c) => c.includes("Imaging correlating"))).toBe(true);
  });

  it("only objective documented facts become record support, with page citations", () => {
    const assessment: TestimonyAssessmentInput = {
      recommendationId: "r1",
      evidenceItems: [
        { category: "objective", text: "MRI: L4-5 disc extrusion", source: "MRI report.pdf", page: 3, date: null, provider: null, objective: true, epistemic: "documented_fact" },
        { category: "subjective", text: "Patient reports 8/10 pain", source: "clinic note", page: 1, date: null, provider: null, objective: false, epistemic: "patient_report" },
      ] as never,
    };
    const e = buildTestimonyEntry({ ...baseItem, physicianStatus: "APPROVED" }, assessment, [], true);
    expect(e.recordSupport).toHaveLength(1);
    expect(e.recordSupport[0].citation).toBe("MRI report.pdf, p. 3");
  });

  it("a contingency-only item answers the double-counting attack with its exclusion", () => {
    const e = buildTestimonyEntry({ ...baseItem, physicianStatus: "APPROVED", contingencyOnly: true }, null, [], false);
    const line = e.crossLines.find((l) => l.basis.includes("contingent"));
    expect(line?.answer).toContain("NOT entered into the totals");
  });
});

describe("planLevelCrossLines", () => {
  it("the life-expectancy question has NO answer when no basis is recorded", () => {
    const lines = planLevelCrossLines({ leBasisRecorded: false, leApprovedBy: null, lifeExpectancyYears: 38.2, discountRate: 0.03, medicalInflation: 0.032, anyLivePricing: false });
    const le = lines.find((l) => l.attack.includes("life expectancy"));
    expect(le?.answer).toBeNull();
  });

  it("cites the recorded basis and its approver when present", () => {
    const lines = planLevelCrossLines({ leBasisRecorded: true, leApprovedBy: "Sam Okafor, MD", lifeExpectancyYears: 31.9, discountRate: 0.03, medicalInflation: 0.032, anyLivePricing: true });
    const le = lines.find((l) => l.attack.includes("life expectancy"));
    expect(le?.answer).toContain("Sam Okafor, MD");
    const pricing = lines.find((l) => l.basis === "Pricing methodology");
    expect(pricing?.answer).toContain("geozip");
  });
});
