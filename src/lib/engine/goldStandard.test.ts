import { describe, it, expect } from "vitest";
import { scoreAgainstGold, servicesMatch, type GoldFixture, type GoldItem } from "./goldStandard";

const item = (over: Partial<GoldItem> & { service: string }): GoldItem => ({
  category: "PHYSICIAN_SERVICES",
  probability: 0.85,
  frequencyPerYear: 2,
  isLifetime: true,
  ...over,
});

const fixture = (over: Partial<GoldFixture> = {}): GoldFixture => ({
  expectedItems: [
    item({ service: "Neurology follow-up visits" }),
    item({ service: "MRI brain", category: "DIAGNOSTICS", frequencyPerYear: 0.2 }),
  ],
  expectedExclusions: ["Lumbar transforaminal epidural steroid injection"],
  totals: { presentValue: 100000, tolerancePct: 10 },
  ...over,
});

describe("scoreAgainstGold", () => {
  it("perfect match scores 1.0 across the board", () => {
    const gold = fixture();
    const s = scoreAgainstGold(gold.expectedItems.map((i) => ({ ...i })), gold, { presentValue: 100000 });
    expect(s.itemPrecision).toBe(1);
    expect(s.itemRecall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.parameterAccuracy).toBe(1);
    expect(s.missing).toEqual([]);
    expect(s.unexpected).toEqual([]);
    expect(s.excludedButPresent).toEqual([]);
    expect(s.totalsWithinTolerance).toBe(true);
  });

  it("missing expected item lowers recall and is listed", () => {
    const gold = fixture();
    const s = scoreAgainstGold([item({ service: "Neurology follow-up visits" })], gold);
    expect(s.itemRecall).toBe(0.5);
    expect(s.itemPrecision).toBe(1);
    expect(s.missing).toEqual(["MRI brain"]);
  });

  it("unexpected generated item lowers precision and is listed", () => {
    const gold = fixture();
    const s = scoreAgainstGold(
      [...gold.expectedItems.map((i) => ({ ...i })), item({ service: "Acupuncture", category: "THERAPY" })],
      gold,
    );
    expect(s.itemRecall).toBe(1);
    expect(s.itemPrecision).toBeCloseTo(2 / 3);
    expect(s.unexpected).toEqual(["Acupuncture"]);
  });

  it("flags exclusion violations via the fuzzy matcher", () => {
    const gold = fixture();
    const s = scoreAgainstGold(
      [...gold.expectedItems.map((i) => ({ ...i })), item({ service: "Transforaminal epidural steroid injection, lumbar" })],
      gold,
    );
    expect(s.excludedButPresent).toEqual(["Lumbar transforaminal epidural steroid injection"]);
  });

  it("matches services fuzzily (case, punctuation, containment, word overlap)", () => {
    expect(servicesMatch("MRI Brain", "mri brain")).toBe(true);
    expect(servicesMatch("MRI of the brain without contrast", "MRI brain")).toBe(true);
    expect(servicesMatch("Neurology follow-up visit", "Follow-up visits, neurology")).toBe(true);
    expect(servicesMatch("MRI brain", "Total knee arthroplasty")).toBe(false);
    const gold = fixture();
    const s = scoreAgainstGold(
      [item({ service: "Follow-up visits — neurology" }), item({ service: "MRI of the brain", category: "DIAGNOSTICS", frequencyPerYear: 0.2 })],
      gold,
    );
    expect(s.f1).toBe(1);
    expect(s.missing).toEqual([]);
  });

  it("counts parameter deltas outside 25% and reports accuracy", () => {
    const gold: GoldFixture = {
      expectedItems: [item({ service: "Neurology follow-up visits", frequencyPerYear: 2, probability: 0.85, isLifetime: true })],
      expectedExclusions: [],
    };
    // frequency 2 → 4 is a >25% miss; probability and isLifetime match.
    const s = scoreAgainstGold([item({ service: "Neurology follow-up visits", frequencyPerYear: 4 })], gold);
    expect(s.matched[0].deltas).toEqual([{ field: "frequencyPerYear", expected: 2, actual: 4 }]);
    expect(s.parameterAccuracy).toBeCloseTo(2 / 3); // probability + isLifetime hit, frequency missed
  });

  it("totals tolerance: pass within tolerancePct, fail outside, null when absent", () => {
    const gold = fixture({ totals: { presentValue: 100000, tolerancePct: 10 } });
    const gen = gold.expectedItems.map((i) => ({ ...i }));
    expect(scoreAgainstGold(gen, gold, { presentValue: 109000 }).totalsWithinTolerance).toBe(true);
    expect(scoreAgainstGold(gen, gold, { presentValue: 115000 }).totalsWithinTolerance).toBe(false);
    expect(scoreAgainstGold(gen, gold).totalsWithinTolerance).toBeNull();
    expect(scoreAgainstGold(gen, fixture({ totals: undefined }), { presentValue: 1 }).totalsWithinTolerance).toBeNull();
  });

  it("empty gold: recall 1, generated items are all unexpected", () => {
    const gold: GoldFixture = { expectedItems: [], expectedExclusions: [] };
    const s = scoreAgainstGold([item({ service: "Anything" })], gold);
    expect(s.itemRecall).toBe(1);
    expect(s.itemPrecision).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.unexpected).toEqual(["Anything"]);
    const empty = scoreAgainstGold([], gold);
    expect(empty.itemPrecision).toBe(1);
    expect(empty.f1).toBe(1);
    expect(empty.parameterAccuracy).toBe(1);
  });

  it("greedy matching claims each generated item once", () => {
    const gold: GoldFixture = {
      expectedItems: [item({ service: "Physical therapy" }), item({ service: "Physical therapy for flare-ups" })],
      expectedExclusions: [],
    };
    const s = scoreAgainstGold([item({ service: "Physical therapy" })], gold);
    expect(s.matched.length).toBe(1);
    expect(s.missing.length).toBe(1);
  });
});
