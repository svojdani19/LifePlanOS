import { describe, it, expect } from "vitest";
import { scoreFutureCareAgreement, assertBlind, type ScoredItem } from "@/lib/learning/futureCareAgreement";

const gen = (service: string, over: Partial<ScoredItem> = {}): ScoredItem => ({ service, origin: "TEMPLATE_CONDITION", physicianStatus: "PENDING", ...over });
const pub = (service: string, over: Partial<ScoredItem> = {}): ScoredItem => ({ service, ...over });

describe("the evaluation refuses to score the answer key against itself", () => {
  // The gold harness read every current FutureCareItem on the source case,
  // including the 37 imported from the published plan. It was grading its own
  // answer sheet and reporting the result as generator performance.
  it("rejects imported reference items in the candidate set", () => {
    expect(() => assertBlind([gen("Physical therapy", { origin: "GOLD_IMPORT" })])).toThrow(/Blind evaluation refused/);
  });

  it("rejects physician- and planner-added items", () => {
    expect(() => assertBlind([gen("X", { origin: "PHYSICIAN_ADDED" })])).toThrow();
    expect(() => assertBlind([gen("X", { origin: "PLANNER_ADDED" })])).toThrow();
  });

  it("rejects post-review modifications — the physician's answer, not the generator's", () => {
    expect(() => assertBlind([gen("X", { physicianStatus: "APPROVED" })])).toThrow();
    expect(() => assertBlind([gen("X", { physicianStatus: "MODIFIED" })])).toThrow();
  });

  it("accepts a pre-review generator snapshot", () => {
    expect(() => assertBlind([gen("Physical therapy"), gen("Lumbar MRI", { origin: "RECORD_RECOMMENDED" })])).not.toThrow();
  });

  it("refuses through the scorer too, not only the guard", () => {
    expect(() => scoreFutureCareAgreement([gen("X", { origin: "GOLD_IMPORT" })], [pub("X")])).toThrow();
  });
});

describe("matching is by clinical identity, not word overlap", () => {
  it("does not count a cervical injection as a lumbar one", () => {
    // Word overlap scored this pair 0.75 and called it a hit.
    const s = scoreFutureCareAgreement([gen("Lumbar epidural steroid injection")], [pub("Cervical epidural steroid injection")]);
    expect(s.matched).toHaveLength(0);
    expect(s.missed).toHaveLength(1);
    expect(s.unexpected).toHaveLength(1);
  });

  it("counts an abbreviation and its full name as one hit", () => {
    const s = scoreFutureCareAgreement([gen("TKA, right knee")], [pub("Right total knee arthroplasty")]);
    expect(s.matched).toHaveLength(1);
    expect(s.recall).toBe(1);
  });

  it("does not let one family's evidence collapse two procedures into one", () => {
    const s = scoreFutureCareAgreement([gen("Lumbar medial branch block")], [pub("Lumbar radiofrequency ablation")]);
    expect(s.matched).toHaveLength(0);
  });
});

describe("split and bundled lines are reconciled, not double-counted", () => {
  it("collapses a base line and its add-on onto one published concept", () => {
    const s = scoreFutureCareAgreement(
      [gen("Lumbar radiofrequency ablation"), gen("Lumbar RFA — each additional level")],
      [pub("Lumbar radiofrequency ablation")],
    );
    expect(s.matched).toHaveLength(1);
    expect(s.matched[0].kind).toBe("BUNDLED");
    expect(s.unexpected).toHaveLength(0); // the add-on is not a false positive
    expect(s.precision).toBe(1);
  });

  it("sums bundle frequency before comparing it", () => {
    const s = scoreFutureCareAgreement(
      [gen("Lumbar facet block", { frequencyPerYear: 2 }), gen("Lumbar facet block — each additional level", { frequencyPerYear: 2 })],
      [pub("Lumbar facet block", { frequencyPerYear: 4 })],
    );
    expect(s.matched[0].frequencyAgrees).toBe(true);
  });
});

describe("the report separates the kinds of gap", () => {
  const published = [
    pub("Lumbar discectomy", { presentValue: 84_006 }),
    pub("Lumbar epidural steroid injection", { presentValue: 16_600 }),
    pub("Physical therapy", { presentValue: 70_457, frequencyPerYear: 12, durationYears: 5 }),
  ];
  const generated = [gen("Physical therapy", { presentValue: 70_000, frequencyPerYear: 12, durationYears: 5 }), gen("TENS unit & supplies", { presentValue: 12_888 })];

  it("computes precision, recall and F1 from concepts", () => {
    const s = scoreFutureCareAgreement(generated, published);
    expect(s.matched).toHaveLength(1);
    expect(s.missed).toHaveLength(2);
    expect(s.unexpected).toHaveLength(1);
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBeCloseTo(1 / 3);
  });

  it("weights recall by the published plan's dollars", () => {
    const s = scoreFutureCareAgreement(generated, published);
    // Found $70,457 of $171,063 published.
    expect(s.dollarWeightedRecall).toBeCloseTo(70_457 / 171_063, 3);
  });

  it("reports recall per family, so the gap is locatable", () => {
    const s = scoreFutureCareAgreement(generated, published);
    const surgery = s.familyRecall.find((f) => f.family === "SURGERY");
    expect(surgery).toEqual({ family: "SURGERY", found: 0, published: 1 });
  });

  it("scores parameters only where a parameter exists to compare", () => {
    const s = scoreFutureCareAgreement([gen("Physical therapy")], [pub("Physical therapy")]);
    expect(s.matched[0].frequencyAgrees).toBeNull();
    expect(s.matched[0].durationAgrees).toBeNull();
  });
});
