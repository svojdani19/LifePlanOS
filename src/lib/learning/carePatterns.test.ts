import { describe, it, expect } from "vitest";
import { deriveCarePatterns, suggestedInterventions, patternSupportCeiling, assertPatternFactFree } from "@/lib/learning/carePatterns";
import { entersSupportedTotal } from "@/lib/engine/supportClass";

const plans = [
  { conditionKeys: ["LUMBAR_SPINE"], services: [{ service: "Lumbar epidural steroid injection" }, { service: "Physical therapy" }, { service: "Lumbar MRI w/o contrast" }] },
  { conditionKeys: ["LUMBAR_SPINE"], services: [{ service: "Lumbar transforaminal ESI" }, { service: "Physical therapy" }, { service: "Lumbar radiofrequency ablation" }] },
  { conditionKeys: ["LUMBAR_SPINE"], services: [{ service: "Epidural steroid injections, lumbar" }, { service: "Aquatic therapy" }] },
  { conditionKeys: ["CERVICAL_SPINE"], services: [{ service: "Cervical facet blocks" }] },
];

describe("what generalises is the KIND of care, never the item", () => {
  it("counts interventions per condition key across plans", () => {
    const p = deriveCarePatterns(plans);
    const esi = p.find((x) => x.intervention === "EPIDURAL_STEROID" && x.conditionKey === "LUMBAR_SPINE");
    expect(esi).toBeDefined();
    expect(esi!.observedIn).toBe(3);
    expect(esi!.outOf).toBe(3);
  });

  it("collapses three different spellings into one concept", () => {
    // "Lumbar epidural steroid injection", "Lumbar transforaminal ESI" and
    // "Epidural steroid injections, lumbar" are one pattern, not three.
    const p = deriveCarePatterns(plans);
    expect(p.filter((x) => x.intervention === "EPIDURAL_STEROID" && x.conditionKey === "LUMBAR_SPINE")).toHaveLength(1);
  });

  it("stores no service text, frequency, duration or cost", () => {
    const blob = JSON.stringify(deriveCarePatterns(plans));
    expect(blob).not.toMatch(/Lumbar epidural steroid injection|transforaminal|w\/o contrast/i);
    // Word-bounded: "RADIOFREQUENCY_ABLATION" legitimately contains "frequency".
    expect(blob).not.toMatch(/"frequencyPerYear"|"unitCost"|"presentValue"|"durationYears"|"service"/);
  });

  it("passes its own fact-free check", () => {
    expect(() => assertPatternFactFree(deriveCarePatterns(plans))).not.toThrow();
  });
});

describe("a pattern licenses consideration, never support", () => {
  it("suggests interventions seen in most plans for the case's keys", () => {
    const s = suggestedInterventions(deriveCarePatterns(plans), { conditionKeys: ["LUMBAR_SPINE"], regions: ["spine"] });
    expect(s.map((x) => x.intervention)).toContain("EPIDURAL_STEROID");
    expect(s.map((x) => x.intervention)).toContain("PHYSICAL_THERAPY");
  });

  it("does not suggest another condition's patterns", () => {
    const s = suggestedInterventions(deriveCarePatterns(plans), { conditionKeys: ["LUMBAR_SPINE"], regions: ["spine"] });
    expect(s.map((x) => x.intervention)).not.toContain("FACET_INJECTION");
  });

  it("drops a pattern seen in a minority of plans", () => {
    const s = suggestedInterventions(deriveCarePatterns(plans), { conditionKeys: ["LUMBAR_SPINE"], regions: ["spine"] });
    // RFA appeared in 1 of 3 lumbar plans.
    expect(s.map((x) => x.intervention)).not.toContain("RADIOFREQUENCY_ABLATION");
  });

  it("caps at CANDIDATE_REVIEW however strong the corpus signal", () => {
    // 3 of 3 plans is the strongest signal the corpus can give, and it still
    // cannot put an item in the supported total. Support comes from THIS
    // patient's record, never from what other planners did.
    expect(patternSupportCeiling()).toBe("CANDIDATE_REVIEW");
    expect(entersSupportedTotal(patternSupportCeiling())).toBe(false);
  });
});

describe("a corpus too small to generalise suggests nothing", () => {
  const onePlan = [{ conditionKeys: ["LUMBAR_SPINE", "CHRONIC_PAIN"], services: [{ service: "Lumbar radiofrequency ablation" }, { service: "Viscosupplementation" }] }];

  it("does not turn one plan into a pattern for every key it touched", () => {
    // With one plan every pattern is 1/1 = 100%, and each of its condition keys
    // inherits every item in it — a memory of one case, not a pattern. Left
    // unguarded this would push one patient's care list onto every case sharing
    // a diagnosis keyword.
    const patterns = deriveCarePatterns(onePlan);
    expect(patterns.every((p) => p.outOf === 1)).toBe(true);
    const s = suggestedInterventions(patterns, { conditionKeys: ["LUMBAR_SPINE"], regions: ["spine"] });
    expect(s).toEqual([]);
  });

  it("suggests once the corpus is large enough", () => {
    const three = [...onePlan, ...onePlan, ...onePlan];
    const s = suggestedInterventions(deriveCarePatterns(three), { conditionKeys: ["LUMBAR_SPINE"], regions: ["spine"] });
    expect(s.map((x) => x.intervention)).toContain("RADIOFREQUENCY_ABLATION");
  });

  it("still cannot exceed the consideration ceiling", () => {
    const three = [...onePlan, ...onePlan, ...onePlan];
    const s = suggestedInterventions(deriveCarePatterns(three), { conditionKeys: ["LUMBAR_SPINE"], regions: ["spine"] });
    expect(s.length).toBeGreaterThan(0);
    expect(entersSupportedTotal(patternSupportCeiling())).toBe(false);
  });
});

describe("only an approved artifact can reach production", () => {
  const artifact = (over: Record<string, unknown> = {}) => ({
    payload: [{ intervention: "EPIDURAL_STEROID", family: "INJECTION", conditionKey: "LUMBAR_SPINE", observedIn: 3, outOf: 3 }],
    heldOut: ["case-under-test"],
    ...over,
  });
  const db = (row: unknown) => ({ learnedArtifact: { findFirst: async () => row as never } });

  it("returns nothing when no approved artifact exists", async () => {
    const { approvedCarePatterns } = await import("@/lib/learning/carePatterns");
    expect(await approvedCarePatterns(db(null), "firm-1")).toEqual([]);
  });

  it("returns an approved artifact's patterns", async () => {
    const { approvedCarePatterns } = await import("@/lib/learning/carePatterns");
    const p = await approvedCarePatterns(db(artifact()), "firm-1");
    expect(p).toHaveLength(1);
    expect(p[0].intervention).toBe("EPIDURAL_STEROID");
  });

  it("refuses an artifact that learned from the case being scored", async () => {
    // Leave-one-out at the point of USE, not only at derivation. An artifact
    // built from this case cannot inform the run being evaluated on it.
    const { approvedCarePatterns } = await import("@/lib/learning/carePatterns");
    expect(await approvedCarePatterns(db(artifact({ heldOut: [] })), "firm-1", "case-under-test")).toEqual([]);
    expect(await approvedCarePatterns(db(artifact()), "firm-1", "case-under-test")).toHaveLength(1);
  });

  it("survives a client that predates the model", async () => {
    const { approvedCarePatterns } = await import("@/lib/learning/carePatterns");
    expect(await approvedCarePatterns({}, "firm-1")).toEqual([]);
  });
});
