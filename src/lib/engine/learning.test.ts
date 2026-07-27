import { describe, it, expect } from "vitest";
import { aggregatePriors, applyPriors, median, priorProvenanceNote, scopeKeyOf, MIN_SAMPLE } from "./learning";

describe("learning — deterministic physician-correction priors", () => {
  it("aggregates corrections into a median prior with sample size", () => {
    const priors = aggregatePriors(
      [
        { scopeKey: "knee::pt", field: "frequencyPerYear", to: 12 },
        { scopeKey: "knee::pt", field: "frequencyPerYear", to: 24 },
        { scopeKey: "knee::pt", field: "frequencyPerYear", to: 12 },
      ],
      [],
    );
    expect(priors).toEqual([
      { scopeKey: "knee::pt", field: "frequencyPerYear", learnedValue: 12, sampleSize: 3, support: { corrections: [12, 24, 12] } },
    ]);
  });

  it("computes rejection-rate priors from tallies", () => {
    const priors = aggregatePriors([], [{ scopeKey: "knee::revision", rejected: 3, total: 4 }]);
    expect(priors[0]).toMatchObject({ field: "rejectionRate", learnedValue: 0.75, sampleSize: 4 });
  });

  it("applies a numeric prior only at MIN_SAMPLE, replacing the template default", () => {
    const below = applyPriors({ frequencyPerYear: 4 }, [{ field: "frequencyPerYear", learnedValue: 12, sampleSize: MIN_SAMPLE - 1 }]);
    expect(below.frequencyPerYear).toBeUndefined();
    const at = applyPriors({ frequencyPerYear: 4 }, [{ field: "frequencyPerYear", learnedValue: 12, sampleSize: MIN_SAMPLE }]);
    expect(at.frequencyPerYear).toBe(12);
    expect(at.applied[0]).toMatchObject({ templateValue: 4, learnedValue: 12 });
  });

  it("a high rejection rate attaches a caution note but removes nothing", () => {
    const res = applyPriors({ frequencyPerYear: 1 }, [{ field: "rejectionRate", learnedValue: 0.8, sampleSize: 5 }]);
    expect(res.cautionNote).toMatch(/rejected this service in 80% of 5 prior reviews/);
    expect(res.frequencyPerYear).toBeUndefined();
  });

  it("provenance note discloses every adjustment; none → null", () => {
    expect(priorProvenanceNote([])).toBeNull();
    expect(priorProvenanceNote([{ field: "frequencyPerYear", templateValue: 4, learnedValue: 12, sampleSize: 3 }])).toMatch(
      /frequencyPerYear 4→12 \(median of 3 physician corrections\)/,
    );
  });

  it("median handles even-length lists; scopeKey normalizes", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(scopeKeyOf(null, "  Physical Therapy ")).toBe("-::physical therapy");
  });
});
