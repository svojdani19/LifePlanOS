import { describe, it, expect } from "vitest";
import { project } from "./cost";

const flat = { lifeExpectancyYears: 30, discountRate: 0, medicalInflation: 0, geographicFactor: 1 };

describe("project", () => {
  it("computes a fixed-duration cost with no inflation/discount", () => {
    const p = project({ category: "PHYSICIAN_VISIT", unitCost: 200, frequencyPerYear: 2, durationYears: 3, isLifetime: false }, flat);
    expect(p.unitCost).toBe(200);
    expect(p.annualCost).toBe(400);
    expect(p.lifetimeCost).toBe(1200); // 400 × 3
    expect(p.presentValue).toBe(1200); // no discount
  });

  it("projects lifetime items across the full horizon", () => {
    const p = project({ category: "MEDICATION", unitCost: 100, frequencyPerYear: 1, durationYears: null, isLifetime: true }, { ...flat, lifeExpectancyYears: 5 });
    expect(p.lifetimeCost).toBe(500);
  });

  it("applies the geographic factor to the unit cost", () => {
    const p = project({ category: "IMAGING", unitCost: 100, frequencyPerYear: 1, durationYears: 1, isLifetime: false }, { ...flat, geographicFactor: 1.5 });
    expect(p.unitCost).toBe(150);
  });

  it("discounts future dollars to present value", () => {
    const p = project({ category: "PHYSICIAN_VISIT", unitCost: 1000, frequencyPerYear: 1, durationYears: 2, isLifetime: false }, { ...flat, discountRate: 0.1 });
    expect(p.lifetimeCost).toBe(2000); // undiscounted, no inflation
    expect(p.presentValue).toBeGreaterThan(1900);
    expect(p.presentValue).toBeLessThan(2000); // year-2 dollar discounted
  });

  it("derives low/high bands from present value", () => {
    const p = project({ category: "PHYSICIAN_VISIT", unitCost: 100, frequencyPerYear: 1, durationYears: 1, isLifetime: false }, flat);
    expect(p.lowCost).toBe(Math.round(p.presentValue * 0.85));
    expect(p.highCost).toBe(Math.round(p.presentValue * 1.25));
  });

  // ── Financial reproducibility (Priority-1 test additions) ──────────────────
  it("is deterministic: identical inputs always produce identical projections", () => {
    const input = { category: "PHYSICIAN_VISIT" as const, unitCost: 360, frequencyPerYear: 4, durationYears: null, isLifetime: true };
    const a = { lifeExpectancyYears: 35.2, discountRate: 0.03, medicalInflation: 0.032, geographicFactor: 1.0 };
    const p1 = project(input, a);
    const p2 = project(input, a);
    expect(p1).toEqual(p2);
  });

  it("applies inflation year over year and discounts each year back (hand-computed)", () => {
    // unit 100, 1×/yr, 3 years, inflation 3%, discount 3%:
    //   t=1: 100.00 → PV 100.00
    //   t=2: 103.00 → PV 103.00/1.03   = 100.00
    //   t=3: 106.09 → PV 106.09/1.0609 = 100.00
    const p = project(
      { category: "PHYSICIAN_VISIT", unitCost: 100, frequencyPerYear: 1, durationYears: 3, isLifetime: false },
      { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.03, geographicFactor: 1 },
    );
    expect(p.lifetimeCost).toBe(309); // 100 + 103 + 106.09 = 309.09 → 309
    expect(p.presentValue).toBe(300); // 3 × 100
  });

  it("handles a fractional final projection year proportionally", () => {
    // 2.5 years at 100/yr, no inflation/discount → 250.
    const p = project({ category: "MEDICATION", unitCost: 100, frequencyPerYear: 1, durationYears: 2.5, isLifetime: false }, flat);
    expect(p.lifetimeCost).toBe(250);
    expect(p.presentValue).toBe(250);
  });

  it("a one-time item (duration 0) contributes nothing beyond year zero", () => {
    const p = project({ category: "DME", unitCost: 5000, frequencyPerYear: 1, durationYears: 0, isLifetime: false }, flat);
    expect(p.lifetimeCost).toBe(0);
    expect(p.presentValue).toBe(0);
  });
});
