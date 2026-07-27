import { describe, it, expect } from "vitest";
import {
  type EconInputs,
  growthSeries,
  presentValue,
  pvOfSeries,
  pastLostEarnings,
  futureLostEarningCapacity,
  householdServicesLoss,
  computeEconomicLoss,
  scenarioCompare,
  sensitivityTable,
  canonicalJson,
  hashEconInputs,
  roundCurrency,
  validateEconInputs,
} from "./economics";

// Minimal valid required inputs; tests spread overrides on top.
const BASE: EconInputs = {
  baselineAnnualEarnings: 100_000,
  earningsGrowthRate: 0.03,
  discountRate: 0.05,
  worklifeYearsRemaining: 10,
  lossStartYearsAgo: 2,
};

describe("growthSeries", () => {
  it("produces exact year-by-year amounts (first year un-grown)", () => {
    const s = growthSeries(100, 0.1, 3);
    expect(s).toHaveLength(3);
    expect(s[0]).toBeCloseTo(100, 10);
    expect(s[1]).toBeCloseTo(110, 10);
    expect(s[2]).toBeCloseTo(121, 10);
  });

  it("is flat at zero growth and empty at zero years", () => {
    expect(growthSeries(500, 0, 4)).toEqual([500, 500, 500, 500]);
    expect(growthSeries(500, 0.05, 0)).toEqual([]);
  });

  it("prorates a fractional final year", () => {
    // 2.5 years of a flat 100 → [100, 100, 50]
    const s = growthSeries(100, 0, 2.5);
    expect(s).toEqual([100, 100, 50]);
  });
});

describe("presentValue", () => {
  it("matches the hand-computed spec example: 100k in 1yr @5% = 95238.10", () => {
    expect(presentValue(100_000, 0.05, 1)).toBeCloseTo(95_238.1, 2);
  });

  it("is the identity at zero discount", () => {
    expect(presentValue(123_456.78, 0, 7)).toBe(123_456.78);
  });

  it("compounds end-of-year: 100k in 2yr @5% = 90702.95", () => {
    // 100000 / 1.05^2 = 90702.9478...
    expect(presentValue(100_000, 0.05, 2)).toBeCloseTo(90_702.95, 2);
  });
});

describe("pvOfSeries", () => {
  it("equals the nominal sum at zero discount", () => {
    const series = [100, 200, 300];
    expect(pvOfSeries(series, 0)).toBeCloseTo(600, 10);
  });

  it("discounts element i at the end of year i+1", () => {
    const series = [1000, 1000];
    const expected = presentValue(1000, 0.05, 1) + presentValue(1000, 0.05, 2);
    expect(pvOfSeries(series, 0.05)).toBeCloseTo(expected, 10);
    // Hand check: 952.380952… + 907.029478… = 1859.410431…
    expect(pvOfSeries(series, 0.05)).toBeCloseTo(1859.41, 2);
  });
});

describe("pastLostEarnings", () => {
  it("sums flat historical years with no growth and applies benefits", () => {
    const r = pastLostEarnings({
      ...BASE,
      earningsGrowthRate: 0,
      lossStartYearsAgo: 2,
      baselineAnnualEarnings: 50_000,
      benefitsRate: 0.1,
    });
    expect(r.nominal).toBeCloseTo(100_000, 6);
    expect(r.withBenefits).toBeCloseTo(110_000, 6);
  });

  it("grows forward from the historical base year", () => {
    // 100000 + 100000·1.05 = 205000
    const r = pastLostEarnings({ ...BASE, earningsGrowthRate: 0.05, lossStartYearsAgo: 2 });
    expect(r.nominal).toBeCloseTo(205_000, 6);
  });

  it("nets mitigation before growth", () => {
    // (100000−20000) + 80000·1.05 = 164000
    const r = pastLostEarnings({
      ...BASE,
      earningsGrowthRate: 0.05,
      lossStartYearsAgo: 2,
      mitigationAnnualEarnings: 20_000,
    });
    expect(r.nominal).toBeCloseTo(164_000, 6);
  });

  it("is never discounted (independent of discountRate)", () => {
    const lo = pastLostEarnings({ ...BASE, discountRate: 0.01 });
    const hi = pastLostEarnings({ ...BASE, discountRate: 0.09 });
    expect(lo.nominal).toBe(hi.nominal);
    expect(lo.withBenefits).toBe(hi.withBenefits);
  });

  it("returns zero for a zero-length past period", () => {
    const r = pastLostEarnings({ ...BASE, lossStartYearsAgo: 0 });
    expect(r).toEqual({ nominal: 0, withBenefits: 0 });
  });
});

describe("futureLostEarningCapacity", () => {
  it("matches a hand-computed single year with benefits", () => {
    // Flat 100k for 1 year @5%: PV = 95238.0952…; ×1.18 = 112380.95
    const r = futureLostEarningCapacity({
      ...BASE,
      earningsGrowthRate: 0,
      worklifeYearsRemaining: 1,
      benefitsRate: 0.18,
    });
    expect(r.nominal).toBeCloseTo(100_000, 6);
    expect(r.presentValue).toBeCloseTo(95_238.1, 2);
    expect(r.withBenefitsPV).toBeCloseTo(112_380.95, 2);
  });

  it("PV equals nominal under zero growth and zero discount", () => {
    const r = futureLostEarningCapacity({
      ...BASE,
      earningsGrowthRate: 0,
      discountRate: 0,
      worklifeYearsRemaining: 10,
    });
    expect(r.nominal).toBeCloseTo(1_000_000, 6);
    expect(r.presentValue).toBeCloseTo(r.nominal, 6);
  });

  it("mitigation reduces the future loss", () => {
    const gross = futureLostEarningCapacity(BASE);
    const mitigated = futureLostEarningCapacity({ ...BASE, mitigationAnnualEarnings: 30_000 });
    expect(mitigated.presentValue).toBeLessThan(gross.presentValue);
    expect(mitigated.nominal).toBeLessThan(gross.nominal);
  });

  it("floors the annual net loss at zero when mitigation exceeds baseline", () => {
    const r = futureLostEarningCapacity({ ...BASE, mitigationAnnualEarnings: 150_000 });
    expect(r.nominal).toBe(0);
    expect(r.presentValue).toBe(0);
    expect(r.withBenefitsPV).toBe(0);
  });
});

describe("householdServicesLoss", () => {
  it("is excluded (all zeros) when any household field is absent", () => {
    expect(householdServicesLoss(BASE)).toEqual({ nominal: 0, presentValue: 0 });
    expect(
      householdServicesLoss({ ...BASE, householdServicesAnnualHours: 100, householdServicesHourlyRate: 20 }),
    ).toEqual({ nominal: 0, presentValue: 0 });
  });

  it("computes hours × rate × years with no growth/discount", () => {
    // 10h/yr × $20 × 5yr flat = 1000
    const r = householdServicesLoss({
      ...BASE,
      earningsGrowthRate: 0,
      discountRate: 0,
      householdServicesAnnualHours: 10,
      householdServicesHourlyRate: 20,
      householdServicesYears: 5,
    });
    expect(r.nominal).toBeCloseTo(1000, 6);
    expect(r.presentValue).toBeCloseTo(1000, 6);
  });

  it("grows at inflationRate when provided, not at the earnings growth rate", () => {
    const common = {
      ...BASE,
      discountRate: 0,
      earningsGrowthRate: 0.5, // deliberately extreme; must NOT be used
      householdServicesAnnualHours: 10,
      householdServicesHourlyRate: 100,
      householdServicesYears: 2,
    };
    const r = householdServicesLoss({ ...common, inflationRate: 0.1 });
    // 1000 + 1100 = 2100 (inflation), not 1000 + 1500 (earnings growth)
    expect(r.nominal).toBeCloseTo(2100, 6);
  });
});

describe("computeEconomicLoss", () => {
  const FULL: EconInputs = {
    baselineAnnualEarnings: 100_000,
    earningsGrowthRate: 0,
    discountRate: 0.05,
    benefitsRate: 0.18,
    worklifeYearsRemaining: 1,
    lossStartYearsAgo: 1,
    householdServicesAnnualHours: 10,
    householdServicesHourlyRate: 20,
    householdServicesYears: 1,
    medicalCostPresentValue: 250_000,
  };

  it("assembles a hand-checked grand total", () => {
    // past: 100000 ×1.18 = 118000 (nominal, undiscounted)
    // future: PV 95238.0952 ×1.18 = 112380.9524
    // household: 200/1.05 = 190.4762
    // medical pass-through: 250000
    // total = 480571.43
    const r = computeEconomicLoss(FULL);
    expect(r.pastLoss.withBenefits).toBeCloseTo(118_000, 2);
    expect(r.futureLoss.withBenefitsPV).toBeCloseTo(112_380.95, 2);
    expect(r.householdServices.presentValue).toBeCloseTo(190.48, 2);
    expect(r.householdServices.included).toBe(true);
    expect(r.medicalCostPresentValue).toBe(250_000);
    expect(r.totalPresentValue).toBeCloseTo(480_571.43, 2);
  });

  it("isolates the benefits component and applies it to earnings only", () => {
    const r = computeEconomicLoss(FULL);
    expect(r.benefits.rate).toBe(0.18);
    expect(r.benefits.pastNominal).toBeCloseTo(18_000, 2);
    expect(r.benefits.futurePresentValue).toBeCloseTo(0.18 * r.futureLoss.presentValue, 6);
    // Household services and medical carry no benefits loading.
    const withoutBenefits = computeEconomicLoss({ ...FULL, benefitsRate: undefined });
    expect(r.householdServices.presentValue).toBeCloseTo(withoutBenefits.householdServices.presentValue, 10);
    expect(r.medicalCostPresentValue).toBe(withoutBenefits.medicalCostPresentValue);
  });

  it("passes medicalCostPresentValue through verbatim and defaults absence to 0", () => {
    const withMedical = computeEconomicLoss({ ...BASE, medicalCostPresentValue: 123_456.78 });
    const withoutMedical = computeEconomicLoss(BASE);
    expect(withMedical.medicalCostPresentValue).toBe(123_456.78);
    expect(withoutMedical.medicalCostPresentValue).toBe(0);
    expect(withMedical.totalPresentValue - withoutMedical.totalPresentValue).toBeCloseTo(123_456.78, 6);
  });

  it("is deterministic: two identical calls produce deep-equal results", () => {
    expect(computeEconomicLoss(FULL)).toEqual(computeEconomicLoss(FULL));
  });

  it("marks household services excluded when inputs are absent", () => {
    const r = computeEconomicLoss(BASE);
    expect(r.householdServices).toEqual({ nominal: 0, presentValue: 0, included: false });
  });
});

describe("inputsHash / canonicalJson", () => {
  it("is stable across key insertion order", () => {
    const a: EconInputs = {
      baselineAnnualEarnings: 100_000,
      earningsGrowthRate: 0.03,
      discountRate: 0.05,
      worklifeYearsRemaining: 10,
      lossStartYearsAgo: 2,
    };
    const b: EconInputs = {
      lossStartYearsAgo: 2,
      worklifeYearsRemaining: 10,
      discountRate: 0.05,
      earningsGrowthRate: 0.03,
      baselineAnnualEarnings: 100_000,
    };
    expect(hashEconInputs(a)).toBe(hashEconInputs(b));
    expect(computeEconomicLoss(a).inputsHash).toBe(computeEconomicLoss(b).inputsHash);
  });

  it("treats explicitly-undefined optionals the same as absent ones", () => {
    expect(hashEconInputs({ ...BASE, benefitsRate: undefined })).toBe(hashEconInputs(BASE));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("changes when any input changes", () => {
    const base = hashEconInputs(BASE);
    expect(hashEconInputs({ ...BASE, discountRate: 0.0500001 })).not.toBe(base);
    expect(hashEconInputs({ ...BASE, benefitsRate: 0.18 })).not.toBe(base);
    expect(hashEconInputs({ ...BASE, worklifeYearsRemaining: 11 })).not.toBe(base);
  });
});

describe("scenarioCompare", () => {
  it("applies each override independently on top of the base", () => {
    const r = scenarioCompare(BASE, {
      low: { discountRate: 0.07 },
      high: { discountRate: 0.03, benefitsRate: 0.18 },
    });
    // "low" must not inherit high's benefitsRate; "high" must not inherit low's rate.
    expect(r.low.inputs.discountRate).toBe(0.07);
    expect(r.low.inputs.benefitsRate).toBeUndefined();
    expect(r.high.inputs.discountRate).toBe(0.03);
    expect(r.high.inputs.benefitsRate).toBe(0.18);
    expect(r.high.totalPresentValue).toBeGreaterThan(r.low.totalPresentValue);
  });

  it("ignores undefined override values instead of clobbering the base", () => {
    const r = scenarioCompare(BASE, { same: { discountRate: undefined } });
    expect(r.same.inputs.discountRate).toBe(BASE.discountRate);
    expect(r.same.totalPresentValue).toBe(computeEconomicLoss(BASE).totalPresentValue);
  });
});

describe("sensitivityTable", () => {
  it("is monotonically decreasing in discountRate", () => {
    const rows = sensitivityTable(BASE, "discountRate", [0.01, 0.03, 0.05, 0.07]);
    expect(rows).toHaveLength(4);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].totalPresentValue).toBeLessThan(rows[i - 1].totalPresentValue);
    }
    // Row identity: each row equals a direct computation with that value.
    expect(rows[2].value).toBe(0.05);
    expect(rows[2].totalPresentValue).toBe(computeEconomicLoss(BASE).totalPresentValue);
  });
});

describe("validation", () => {
  it("throws on non-finite required inputs, naming the field", () => {
    expect(() => computeEconomicLoss({ ...BASE, baselineAnnualEarnings: NaN })).toThrow(/baselineAnnualEarnings/);
    expect(() => computeEconomicLoss({ ...BASE, discountRate: Infinity })).toThrow(/discountRate/);
  });

  it("throws on negative worklife and negative past period", () => {
    expect(() => computeEconomicLoss({ ...BASE, worklifeYearsRemaining: -1 })).toThrow(/worklifeYearsRemaining/);
    expect(() => computeEconomicLoss({ ...BASE, lossStartYearsAgo: -0.5 })).toThrow(/lossStartYearsAgo/);
  });

  it("throws on discountRate <= -1 and growth rate < -1", () => {
    expect(() => computeEconomicLoss({ ...BASE, discountRate: -1 })).toThrow(/discountRate/);
    expect(() => computeEconomicLoss({ ...BASE, earningsGrowthRate: -1.5 })).toThrow(/earningsGrowthRate/);
    expect(() => validateEconInputs({ ...BASE, inflationRate: -2 })).toThrow(/inflationRate/);
  });

  it("throws on negative optional amounts rather than silently absorbing them", () => {
    expect(() => computeEconomicLoss({ ...BASE, mitigationAnnualEarnings: -5 })).toThrow(/mitigationAnnualEarnings/);
    expect(() => computeEconomicLoss({ ...BASE, medicalCostPresentValue: -1 })).toThrow(/medicalCostPresentValue/);
  });
});

describe("roundCurrency", () => {
  it("rounds to cents for display only", () => {
    expect(roundCurrency(95_238.095238)).toBe(95_238.1);
    expect(roundCurrency(1.005)).toBeCloseTo(1.0, 2); // FP: 1.005 stores as 1.00499…
    expect(roundCurrency(-2.555)).toBeCloseTo(-2.56, 2); // FP: -2.555 stores as -2.55500…02
  });
});
