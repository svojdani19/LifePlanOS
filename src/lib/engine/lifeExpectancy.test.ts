import { describe, it, expect } from "vitest";
import {
  baselineLifeExpectancy,
  composeBasis,
  physicianBasis,
  parseBasis,
  basisNarrative,
  lifeExpectancyFindings,
  LE_BLOCKING_PV,
  SSA_PERIOD_LIFE_TABLE,
} from "./lifeExpectancy";

describe("baselineLifeExpectancy", () => {
  it("returns the exact table value at a pivot age", () => {
    const b = baselineLifeExpectancy(45, "MALE");
    expect(b.years).toBe(31.9);
    expect(b.label).toContain("age 45");
    expect(b.label).toContain("male");
    expect(b.edition).toBe(SSA_PERIOD_LIFE_TABLE.edition);
  });

  it("linearly interpolates between pivots", () => {
    // Male: 40 → 36.3, 45 → 31.9; midpoint 42.5 → 34.1
    const b = baselineLifeExpectancy(42.5, "MALE");
    expect(b.years).toBeCloseTo(34.1, 1);
  });

  it("averages male and female for undocumented sex, and says so", () => {
    const b = baselineLifeExpectancy(45, "UNKNOWN");
    expect(b.years).toBeCloseTo((31.9 + 36.5) / 2, 1);
    expect(b.label).toContain("sex-averaged");
  });

  it("clamps ages outside the table range instead of extrapolating", () => {
    expect(baselineLifeExpectancy(-2, "FEMALE").years).toBe(79.3);
    expect(baselineLifeExpectancy(120, "FEMALE").years).toBe(2.2);
  });
});

describe("composeBasis", () => {
  it("is ACTUARIAL_BASELINE with no adjustments and ADJUSTED with them", () => {
    const base = baselineLifeExpectancy(45, "MALE");
    expect(composeBasis(base).method).toBe("ACTUARIAL_BASELINE");
    const adj = composeBasis(base, [{ deltaYears: -6, reason: "SCI-related reduction", source: "Rated-age report, Dr. K." }]);
    expect(adj.method).toBe("ADJUSTED");
    expect(adj.determinedYears).toBeCloseTo(31.9 - 6, 1);
  });

  it("recomputes the determined figure from baseline + deltas and never goes below 0.5", () => {
    const base = baselineLifeExpectancy(95, "MALE"); // 2.9
    const b = composeBasis(base, [{ deltaYears: -10, reason: "r", source: "s" }]);
    expect(b.determinedYears).toBe(0.5);
  });
});

describe("physicianBasis / parseBasis", () => {
  it("carries the physician figure and retains the actuarial comparison", () => {
    const base = baselineLifeExpectancy(45, "MALE");
    const b = physicianBasis(25, "IME of Dr. Osei, 3/2026", "post-injury cardiovascular risk", base);
    expect(b.method).toBe("PHYSICIAN_DETERMINED");
    expect(b.determinedYears).toBe(25);
    expect(b.baselineYears).toBe(31.9);
  });

  it("round-trips through parseBasis and rejects malformed payloads", () => {
    const base = baselineLifeExpectancy(45, "MALE");
    const b = composeBasis(base, [{ deltaYears: -2, reason: "r", source: "s" }]);
    const parsed = parseBasis(JSON.parse(JSON.stringify(b)));
    expect(parsed?.determinedYears).toBe(b.determinedYears);
    expect(parsed?.adjustments).toHaveLength(1);
    expect(parseBasis(null)).toBeNull();
    expect(parseBasis({ method: "ADJUSTED" })).toBeNull(); // no determinedYears
    expect(parseBasis({ method: "MADE_UP", determinedYears: 10 })).toBeNull();
  });
});

describe("basisNarrative", () => {
  it("is honest when no basis is recorded — and never claims an actuarial source", () => {
    const lines = basisNarrative(null, 40);
    expect(lines.join(" ")).toContain("has not yet been recorded");
    expect(lines.join(" ")).not.toContain("Social Security");
  });

  it("cites the table, each adjustment's reason and source, and the approver", () => {
    const base = baselineLifeExpectancy(45, "MALE");
    const b = composeBasis(base, [{ deltaYears: -6, reason: "spinal cord injury survival literature", source: "Strauss et al." }]);
    b.approvedByName = "Sam Okafor, MD";
    const text = basisNarrative(b, b.determinedYears).join(" ");
    expect(text).toContain("Social Security Administration");
    expect(text).toContain("reduced by 6.0 years");
    expect(text).toContain("Strauss et al.");
    expect(text).toContain("Sam Okafor, MD");
  });
});

describe("lifeExpectancyFindings", () => {
  const baseline = baselineLifeExpectancy(45, "MALE");

  it("emits nothing when no lifetime care is totaled", () => {
    expect(
      lifeExpectancyFindings({ basis: null, yearsInUse: 40, currentBaseline: baseline, lifetimePresentValue: 500_000, lifetimeItemCount: 0 }),
    ).toHaveLength(0);
  });

  it("unstated basis is Critical + export-blocking above the PV threshold, High below it", () => {
    const big = lifeExpectancyFindings({ basis: null, yearsInUse: 40, currentBaseline: baseline, lifetimePresentValue: LE_BLOCKING_PV, lifetimeItemCount: 3 });
    expect(big).toHaveLength(1);
    expect(big[0].severity).toBe("Critical");
    expect(big[0].exportBlocking).toBe(true);

    const small = lifeExpectancyFindings({ basis: null, yearsInUse: 40, currentBaseline: baseline, lifetimePresentValue: 40_000, lifetimeItemCount: 1 });
    expect(small[0].severity).toBe("High");
    expect(small[0].exportBlocking).toBe(false);
  });

  it("a documented, consistent basis produces no findings", () => {
    const b = composeBasis(baseline, [{ deltaYears: -6, reason: "r", source: "s" }]);
    const out = lifeExpectancyFindings({ basis: b, yearsInUse: b.determinedYears, currentBaseline: baseline, lifetimePresentValue: 900_000, lifetimeItemCount: 5 });
    expect(out).toHaveLength(0);
  });

  it("a basis that disagrees with the figure in use blocks export", () => {
    const b = composeBasis(baseline);
    const out = lifeExpectancyFindings({ basis: b, yearsInUse: b.determinedYears + 8, currentBaseline: baseline, lifetimePresentValue: 10_000, lifetimeItemCount: 1 });
    expect(out.some((f) => f.result === "Life-expectancy mismatch" && f.exportBlocking)).toBe(true);
  });

  it("an adjustment without a reason or source is flagged, non-blocking", () => {
    const b = composeBasis(baseline, [{ deltaYears: -4, reason: "", source: "" }]);
    const out = lifeExpectancyFindings({ basis: b, yearsInUse: b.determinedYears, currentBaseline: baseline, lifetimePresentValue: 10_000, lifetimeItemCount: 1 });
    expect(out.some((f) => f.result === "Undocumented life-expectancy adjustment" && !f.exportBlocking)).toBe(true);
  });

  it("flags a stale baseline when the patient has aged past it", () => {
    const old = composeBasis(baselineLifeExpectancy(40, "MALE")); // 36.3
    const now = baselineLifeExpectancy(50, "MALE"); // 27.7
    const out = lifeExpectancyFindings({ basis: old, yearsInUse: old.determinedYears, currentBaseline: now, lifetimePresentValue: 10_000, lifetimeItemCount: 1 });
    expect(out.some((f) => f.result === "Life-expectancy baseline stale")).toBe(true);
  });
});
