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
});
