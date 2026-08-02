import { describe, it, expect } from "vitest";
import {
  evaluateFutureDamages,
  explainLowerCostOption,
  RANGE_LABEL,
  FDE_LOGIC_VERSION,
  type FdeInput,
  type FdeItem,
  type FdeOutcome,
} from "./damagesEvaluation";

// ── Builders ─────────────────────────────────────────────────────────────────

function item(overrides: Partial<FdeItem> = {}): FdeItem {
  return {
    service: "Physical therapy",
    category: "PHYSICAL_THERAPY",
    probability: "PROBABLE",
    physicianStatus: "PENDING",
    isLifetime: false,
    durationYears: 2,
    presentValue: 10_000,
    contingencyOnly: false,
    origin: "TEMPLATE_CONDITION",
    ...overrides,
  };
}

function input(overrides: Partial<FdeInput> = {}): FdeInput {
  return {
    conditions: [{ name: "Lumbar disc herniation", relatedness: "RELATED", evidenceSourceCount: 2 }],
    items: [item()],
    findings: [],
    documentsCount: 5,
    chronologyCount: 12,
    vocationalEntryCount: 0,
    econAssumptionCount: 0,
    interviews: false,
    missingRecordSignals: [],
    ...overrides,
  };
}

// ── Outcomes — every branch of the fde-1 rule table ──────────────────────────

describe("evaluateFutureDamages — outcomes", () => {
  it("returns ADDITIONAL_INFO_REQUIRED when no documents exist (empty case)", () => {
    const r = evaluateFutureDamages(input({ documentsCount: 0, chronologyCount: 0, items: [], conditions: [] }));
    expect(r.overallOutcome).toBe("ADDITIONAL_INFO_REQUIRED");
    expect(r.readinessState).toBe("RECORDS_INCOMPLETE");
    expect(r.missingInformation.some((m) => m.factor === "No medical records on file")).toBe(true);
    expect(r.recommendedPrimaryProduct).toBeNull();
  });

  it("returns ADDITIONAL_INFO_REQUIRED at three or more export-blocking findings", () => {
    const findings = [1, 2, 3].map((n) => ({ result: `Code mismatch ${n}`, severity: "Critical", exportBlocking: true }));
    const r = evaluateFutureDamages(input({ findings }));
    expect(r.overallOutcome).toBe("ADDITIONAL_INFO_REQUIRED");
    // Two blockers is NOT enough on its own.
    expect(evaluateFutureDamages(input({ findings: findings.slice(0, 2) })).overallOutcome).not.toBe("ADDITIONAL_INFO_REQUIRED");
  });

  it("returns ADDITIONAL_INFO_REQUIRED on any missing-record signal, and names it", () => {
    const r = evaluateFutureDamages(input({ missingRecordSignals: ["Operative report referenced but not in the record"] }));
    expect(r.overallOutcome).toBe("ADDITIONAL_INFO_REQUIRED");
    expect(r.missingInformation.some((m) => m.detail === "Operative report referenced but not in the record")).toBe(true);
  });

  it("returns NO_REPORT_INDICATED when nothing is probable/possible and nothing is lifetime", () => {
    const r = evaluateFutureDamages(input({ items: [item({ probability: "SPECULATIVE" }), item({ probability: "NOT_SUPPORTED", service: "Experimental implant" })] }));
    expect(r.overallOutcome).toBe("NO_REPORT_INDICATED");
    expect(r.readinessState).toBe("NO_ACTION_INDICATED");
  });

  it("returns NO_REPORT_INDICATED for a case with records but zero items", () => {
    expect(evaluateFutureDamages(input({ items: [] })).overallOutcome).toBe("NO_REPORT_INDICATED");
  });

  it("recommends LCP for lifetime care", () => {
    const r = evaluateFutureDamages(input({ items: [item({ isLifetime: true, durationYears: null })] }));
    expect(r.overallOutcome).toBe("LCP_RECOMMENDED");
    expect(r.recommendedPrimaryProduct).toBe("LIFE_CARE_PLAN");
    expect(r.recommendedAdditionalProducts).toEqual([]);
  });

  it("recommends LCP for attendant care even without lifetime duration", () => {
    const r = evaluateFutureDamages(input({ items: [item({ category: "ATTENDANT_CARE", service: "Home health aide" })] }));
    expect(r.overallOutcome).toBe("LCP_RECOMMENDED");
  });

  it("recommends LCP for multi-specialty breadth (>= 3 categories)", () => {
    const items = [
      item({ category: "PHYSICAL_THERAPY" }),
      item({ category: "PAIN_MANAGEMENT", service: "Pain management visits" }),
      item({ category: "MEDICATION", service: "NSAID regimen" }),
    ];
    expect(evaluateFutureDamages(input({ items })).overallOutcome).toBe("LCP_RECOMMENDED");
  });

  it("upgrades to LCP_PLUS_VOCATIONAL when vocational entries exist", () => {
    const r = evaluateFutureDamages(input({ items: [item({ isLifetime: true })], vocationalEntryCount: 4 }));
    expect(r.overallOutcome).toBe("LCP_PLUS_VOCATIONAL");
    expect(r.recommendedAdditionalProducts).toEqual(["VOCATIONAL_ASSESSMENT"]);
  });

  it("upgrades to LCP_PLUS_VOCATIONAL on a work-restriction finding alone", () => {
    const r = evaluateFutureDamages(
      input({
        items: [item({ isLifetime: true })],
        findings: [{ result: "Permanent work restriction documented", severity: "Moderate", exportBlocking: false }],
      }),
    );
    expect(r.overallOutcome).toBe("LCP_PLUS_VOCATIONAL");
  });

  it("upgrades to LCP_PLUS_VOC_ECON when economic assumptions exist", () => {
    const r = evaluateFutureDamages(input({ items: [item({ isLifetime: true })], vocationalEntryCount: 2, econAssumptionCount: 5 }));
    expect(r.overallOutcome).toBe("LCP_PLUS_VOC_ECON");
    expect(r.recommendedAdditionalProducts).toEqual(["VOCATIONAL_ASSESSMENT", "FORENSIC_ECONOMIST_REPORT"]);
  });

  it("recommends MCP for narrow care with a documented future procedure", () => {
    const items = [
      item({ category: "ORTHOPEDIC_SURGERY", service: "Total knee arthroplasty" }),
      item({ category: "PHYSICAL_THERAPY", service: "Post-op physical therapy" }),
    ];
    const r = evaluateFutureDamages(input({ items }));
    expect(r.overallOutcome).toBe("MCP_RECOMMENDED");
    expect(r.recommendedPrimaryProduct).toBe("MEDICAL_COST_PROJECTION");
  });

  it("falls to EXPERT_CONSULTATION for the ambiguous middle (narrow, no procedure)", () => {
    const r = evaluateFutureDamages(input({ items: [item({ category: "PHYSICAL_THERAPY" })] }));
    expect(r.overallOutcome).toBe("EXPERT_CONSULTATION");
    expect(r.readinessState).toBe("NEEDS_EXPERT_TRIAGE");
  });

  it("ignores contingency-only items when deciding the outcome", () => {
    // A lifetime item that is contingency-only must NOT trigger the LCP branch.
    const r = evaluateFutureDamages(input({ items: [item({ isLifetime: true, contingencyOnly: true, service: "Revision surgery contingency" })] }));
    expect(r.overallOutcome).toBe("NO_REPORT_INDICATED");
    expect(r.weakeningFactors.some((w) => w.factor === "Contingency-only items excluded")).toBe(true);
  });

  it("ignores physician-rejected items when deciding the outcome, and names them as weakening", () => {
    const r = evaluateFutureDamages(input({ items: [item({ isLifetime: true, physicianStatus: "REJECTED", service: "Lifetime attendant care" })] }));
    expect(r.overallOutcome).toBe("NO_REPORT_INDICATED");
    expect(r.weakeningFactors.some((w) => w.factor === "Physician-rejected recommendations" && w.detail.includes("Lifetime attendant care"))).toBe(true);
  });
});

// ── Determinism + factor provenance ──────────────────────────────────────────

describe("evaluateFutureDamages — determinism and provenance", () => {
  it("is deterministic: identical inputs produce deep-equal results", () => {
    const snapshot = input({ items: [item({ isLifetime: true })], vocationalEntryCount: 1, econAssumptionCount: 2, interviews: true });
    expect(evaluateFutureDamages(snapshot)).toEqual(evaluateFutureDamages(snapshot));
    expect(evaluateFutureDamages(snapshot).logicVersion).toBe(FDE_LOGIC_VERSION);
  });

  it("names every factor from the input — condition names, item services, finding texts appear verbatim", () => {
    const r = evaluateFutureDamages(
      input({
        conditions: [
          { name: "Cervical radiculopathy", relatedness: "RELATED", evidenceSourceCount: 3 },
          { name: "Prior lumbar strain", relatedness: "UNCLEAR", evidenceSourceCount: 0 },
        ],
        items: [item({ isLifetime: true, service: "Annual pain management" })],
        findings: [{ result: "Diagnosis mismatch", severity: "High", exportBlocking: true }],
      }),
    );
    expect(r.supportingFactors.find((f) => f.factor === "Causally related conditions documented")?.detail).toContain("Cervical radiculopathy");
    expect(r.supportingFactors.find((f) => f.factor === "Lifetime care recommended")?.detail).toContain("Annual pain management");
    expect(r.weakeningFactors.find((f) => f.factor === "Unresolved causation")?.detail).toContain("Prior lumbar strain");
    expect(r.weakeningFactors.find((f) => f.factor === "Export-blocking validation findings")?.detail).toContain("Diagnosis mismatch");
    expect(r.sourceFactIds).toContain("condition:Cervical radiculopathy");
    expect(r.sourceFactIds).toContain("item:Annual pain management");
    expect(r.sourceFactIds).toContain("finding:Diagnosis mismatch");
  });

  it("invents nothing: a minimal case yields no supporting factors about absent facts", () => {
    const r = evaluateFutureDamages(input({ conditions: [], items: [], interviews: false }));
    expect(r.supportingFactors).toEqual([]);
    // But the absences themselves ARE disclosed as missing information.
    expect(r.missingInformation.some((m) => m.factor === "No interview findings")).toBe(true);
  });

  it("counts every persisted finding as an unresolved validation issue", () => {
    const findings = [
      { result: "Frequency out of range", severity: "Low", exportBlocking: false },
      { result: "Code mismatch", severity: "Critical", exportBlocking: true },
    ];
    expect(evaluateFutureDamages(input({ findings })).unresolvedValidationIssues).toBe(2);
  });
});

// ── Estimated medical range ──────────────────────────────────────────────────

describe("evaluateFutureDamages — estimated medical range", () => {
  it("emits NO range when no item has been physician-decided", () => {
    const r = evaluateFutureDamages(input({ items: [item({ physicianStatus: "PENDING", presentValue: 50_000 })] }));
    expect(r.estimatedMedicalRange).toBeNull();
  });

  it("emits 0.8x / 1.0x / 1.2x of included decided PV, with the disclosure label", () => {
    const r = evaluateFutureDamages(input({ items: [item({ physicianStatus: "APPROVED", presentValue: 100_000 })] }));
    expect(r.estimatedMedicalRange).toEqual({
      lowPV: 80_000,
      basePV: 100_000,
      highPV: 120_000,
      label: RANGE_LABEL,
    });
    expect(RANGE_LABEL).toContain("not a case valuation");
  });

  it("sums only included probable/possible non-contingency approved/modified items", () => {
    const r = evaluateFutureDamages(
      input({
        items: [
          item({ physicianStatus: "APPROVED", presentValue: 60_000 }),
          item({ physicianStatus: "MODIFIED", probability: "POSSIBLE", presentValue: 40_000, service: "Injections" }),
          item({ physicianStatus: "APPROVED", contingencyOnly: true, presentValue: 500_000, service: "Contingent revision" }),
          item({ physicianStatus: "APPROVED", probability: "SPECULATIVE", presentValue: 90_000, service: "Speculative device" }),
          item({ physicianStatus: "PENDING", presentValue: 70_000, service: "Pending PT" }),
          item({ physicianStatus: "REJECTED", presentValue: 30_000, service: "Rejected brace" }),
        ],
      }),
    );
    expect(r.estimatedMedicalRange?.basePV).toBe(100_000);
  });
});

// ── Confidence dimensions ────────────────────────────────────────────────────

describe("evaluateFutureDamages — confidence dimensions", () => {
  it("scores 0 across the board for a truly empty case", () => {
    const r = evaluateFutureDamages(input({ conditions: [], items: [], documentsCount: 0, chronologyCount: 0 }));
    expect(r.confidenceDimensions).toEqual({ recordCompleteness: 0, physicianReviewCoverage: 0, evidenceSupport: 0 });
  });

  it("derives physician coverage and evidence support as simple ratios", () => {
    const r = evaluateFutureDamages(
      input({
        conditions: [
          { name: "A", relatedness: "RELATED", evidenceSourceCount: 1 },
          { name: "B", relatedness: "RELATED", evidenceSourceCount: 0 },
        ],
        items: [item({ physicianStatus: "APPROVED" }), item({ physicianStatus: "PENDING", service: "Second item" })],
      }),
    );
    expect(r.confidenceDimensions.physicianReviewCoverage).toBe(50);
    expect(r.confidenceDimensions.evidenceSupport).toBe(50);
  });

  it("keeps recordCompleteness within 0–100 and rewards interviews", () => {
    const without = evaluateFutureDamages(input({ interviews: false }));
    const withInterviews = evaluateFutureDamages(input({ interviews: true }));
    expect(withInterviews.confidenceDimensions.recordCompleteness).toBeGreaterThan(without.confidenceDimensions.recordCompleteness);
    expect(withInterviews.confidenceDimensions.recordCompleteness).toBeLessThanOrEqual(100);
  });
});

// ── explainLowerCostOption ───────────────────────────────────────────────────

describe("explainLowerCostOption", () => {
  const OUTCOMES: FdeOutcome[] = [
    "NO_REPORT_INDICATED",
    "ADDITIONAL_INFO_REQUIRED",
    "MCP_RECOMMENDED",
    "LCP_RECOMMENDED",
    "LCP_PLUS_VOCATIONAL",
    "LCP_PLUS_VOC_ECON",
    "EXPERT_CONSULTATION",
  ];

  it("returns a distinct, non-empty sentence for every outcome", () => {
    const sentences = OUTCOMES.map((o) => explainLowerCostOption(o));
    sentences.forEach((s) => expect(s.length).toBeGreaterThan(20));
    expect(new Set(sentences).size).toBe(OUTCOMES.length);
  });

  it("says the MCP suffices only when the MCP itself is the recommendation", () => {
    expect(explainLowerCostOption("MCP_RECOMMENDED")).toContain("recommended product");
    expect(explainLowerCostOption("LCP_PLUS_VOC_ECON")).toContain("would not suffice");
  });
});
