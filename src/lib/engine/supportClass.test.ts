import { describe, it, expect } from "vitest";
import { classifySupport, computePlanTotals, entersSupportedTotal, SUPPORT_CLASSES, type SupportInputs } from "@/lib/engine/supportClass";

const base: SupportInputs = {
  providerRecommendation: false,
  professionalAdoption: false,
  professionalRejection: false,
  indicationChainComplete: false,
  contradicted: false,
  conditional: false,
  clinicallyRelevant: true,
};

describe("a default value can never buy support", () => {
  it("has no way to receive confidence, probability, origin or region", () => {
    // The structural guarantee: these are not fields of SupportInputs, so the
    // 75-by-default confidence that admitted a zero-record condition into the
    // totals has no path to this function at all.
    const keys = Object.keys(base);
    for (const forbidden of ["confidence", "probability", "origin", "region", "bodyRegion", "conditionHasRecords"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it("classifies a relevant template with no evidence as a candidate, not as supported", () => {
    const v = classifySupport(base);
    expect(v.supportClass).toBe("CANDIDATE_REVIEW");
    expect(entersSupportedTotal(v.supportClass)).toBe(false);
  });

  it("keeps an irrelevant template out entirely", () => {
    expect(classifySupport({ ...base, clinicallyRelevant: false }).supportClass).toBe("UNSUPPORTED");
  });
});

describe("the classes rank the way a deposition would", () => {
  it("lets a treating-provider recommendation into the total", () => {
    const v = classifySupport({ ...base, providerRecommendation: true });
    expect(v.supportClass).toBe("RECORD_RECOMMENDED");
    expect(entersSupportedTotal(v.supportClass)).toBe(true);
  });

  it("lets a complete indication chain into the total", () => {
    expect(classifySupport({ ...base, indicationChainComplete: true }).supportClass).toBe("PATIENT_SPECIFIC");
  });

  it("labels professional adoption as judgement, never as treating-record evidence", () => {
    const v = classifySupport({ ...base, professionalAdoption: true });
    expect(v.supportClass).toBe("PROFESSIONALLY_ADOPTED");
    expect(v.reason).toMatch(/qualified professional/);
    expect(v.reason).not.toMatch(/treating provider recommended/);
  });

  it("lets a rejection outrank everything, including a provider recommendation", () => {
    expect(classifySupport({ ...base, providerRecommendation: true, professionalRejection: true }).supportClass).toBe("UNSUPPORTED");
  });

  it("treats contradiction as different from absence", () => {
    expect(classifySupport({ ...base, contradicted: true }).supportClass).toBe("UNSUPPORTED");
    expect(classifySupport({ ...base }).supportClass).toBe("CANDIDATE_REVIEW");
  });

  it("keeps a conditional pathway out of the supported total even when relevant", () => {
    const v = classifySupport({ ...base, conditional: true, indicationChainComplete: true });
    expect(v.supportClass).toBe("CONDITIONAL");
    expect(entersSupportedTotal(v.supportClass)).toBe(false);
  });

  it("gives every class a deterministic reason", () => {
    for (const c of SUPPORT_CLASSES) {
      const v = classifySupport(
        c === "RECORD_RECOMMENDED" ? { ...base, providerRecommendation: true }
        : c === "PATIENT_SPECIFIC" ? { ...base, indicationChainComplete: true }
        : c === "PROFESSIONALLY_ADOPTED" ? { ...base, professionalAdoption: true }
        : c === "CONDITIONAL" ? { ...base, conditional: true }
        : c === "UNSUPPORTED" ? { ...base, contradicted: true }
        : base,
      );
      expect(v.reason.length, c).toBeGreaterThan(20);
    }
  });
});

describe("two totals, and candidates cannot leak into the supported one", () => {
  const items = [
    { supportClass: "RECORD_RECOMMENDED", presentValue: 100, lifetimeCost: 120 },
    { supportClass: "PATIENT_SPECIFIC", presentValue: 200, lifetimeCost: 240 },
    { supportClass: "PROFESSIONALLY_ADOPTED", presentValue: 50, lifetimeCost: 60 },
    { supportClass: "CANDIDATE_REVIEW", presentValue: 400, lifetimeCost: 480 },
    { supportClass: "CONDITIONAL", presentValue: 800, lifetimeCost: 960 },
    { supportClass: "UNSUPPORTED", presentValue: 1600, lifetimeCost: 1920 },
  ];

  it("totals only the supported classes in the headline", () => {
    const t = computePlanTotals(items);
    expect(t.supported.items).toBe(3);
    expect(t.supported.presentValue).toBe(350);
  });

  it("discloses candidates and contingencies in the scenario total, supported included", () => {
    const t = computePlanTotals(items);
    expect(t.scenario.items).toBe(5);
    expect(t.scenario.presentValue).toBe(1550); // 100+200+50+400+800
  });

  it("never totals an unsupported item in either view", () => {
    const t = computePlanTotals(items);
    expect(t.scenario.presentValue).toBeLessThan(items.reduce((a, i) => a + i.presentValue, 0));
  });

  it("treats an unclassified legacy row as a candidate, not as supported", () => {
    // Fail closed: a row written before this column existed must not be
    // silently counted in the headline.
    const t = computePlanTotals([{ supportClass: null, presentValue: 999, lifetimeCost: 999 }]);
    expect(t.supported.presentValue).toBe(0);
    expect(t.scenario.presentValue).toBe(999);
  });
});
