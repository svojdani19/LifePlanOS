import { describe, it, expect } from "vitest";
import { analyzeConsistency, type ConsistencyRec } from "./recommendationConsistency";

const rec = (o: Partial<ConsistencyRec> & { id: string; service: string }): ConsistencyRec => ({
  probability: "PROBABLE",
  confidence: 70,
  presentValue: 10000,
  includedInTotal: true,
  ...o,
});

// helpers
const relTypes = (r: ReturnType<typeof analyzeConsistency>) => r.relations.map((x) => x.type);
const blocking = (r: ReturnType<typeof analyzeConsistency>) => r.findings.filter((f) => f.exportBlocking);

describe("recommendationConsistency", () => {
  it("1. conservative spine care vs immediate fusion — mutually exclusive; both totaled blocks export", () => {
    const r = analyzeConsistency([
      rec({ id: "cons", service: "Lifetime conservative lumbar care", category: "PAIN_MANAGEMENT", conditionId: "c1", isLifetime: true }),
      rec({ id: "fus", service: "Lumbar spinal fusion", category: "NEUROSURGERY", conditionId: "c1" }),
    ]);
    expect(relTypes(r)).toContain("mutually_exclusive");
    expect(blocking(r).length).toBeGreaterThan(0);
  });

  it("2. repeated injections vs definitive surgery — sequential when surgery is triggered by failure", () => {
    const r = analyzeConsistency([
      rec({ id: "inj", service: "Lumbar epidural steroid injections", category: "INJECTION", conditionId: "c1" }),
      rec({ id: "surg", service: "Lumbar decompression surgery", category: "NEUROSURGERY", conditionId: "c1", startTrigger: "if injections fail to control symptoms" }),
    ]);
    expect(relTypes(r)).toContain("sequential");
    expect(blocking(r)).toHaveLength(0); // sequential care may both be planned
  });

  it("3. primary arthroplasty followed by later revision — sequential, not both concurrent", () => {
    const r = analyzeConsistency([
      rec({ id: "tka", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", conditionId: "knee" }),
      rec({ id: "rev", service: "Revision knee arthroplasty", category: "REVISION_SURGERY", conditionId: "knee", startTrigger: "on implant survivorship failure ~15 years" }),
    ]);
    expect(relTypes(r)).toContain("sequential");
    // Revision carries a survivorship trigger, so no "missing trigger" finding.
    expect(r.findings.some((f) => /lacks a documented trigger/i.test(f.result))).toBe(false);
  });

  it("3b. revision counted with no trigger raises a (non-blocking) finding", () => {
    const r = analyzeConsistency([
      rec({ id: "tka", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", conditionId: "knee" }),
      rec({ id: "rev", service: "Revision knee arthroplasty", category: "REVISION_SURGERY", conditionId: "knee" }),
    ]);
    expect(r.findings.some((f) => /lacks a documented trigger/i.test(f.result))).toBe(true);
    expect(blocking(r)).toHaveLength(0);
  });

  it("4. temporary walker vs lifetime wheelchair — sequential transition", () => {
    const r = analyzeConsistency([
      rec({ id: "walk", service: "Standard walker", category: "MOBILITY_AID", conditionId: "gait", durationYears: 1, isLifetime: false }),
      rec({ id: "wc", service: "Power wheelchair", category: "MOBILITY_AID", conditionId: "gait", isLifetime: true }),
    ]);
    expect(relTypes(r)).toContain("sequential");
  });

  it("5. PT flare-ups vs lifelong weekly PT — duplicate/overlap; both totaled blocks export", () => {
    const r = analyzeConsistency([
      rec({ id: "pt1", service: "Physical therapy for flare-ups", category: "PHYSICAL_THERAPY", conditionId: "back" }),
      rec({ id: "pt2", service: "Weekly physical therapy for life", category: "PHYSICAL_THERAPY", conditionId: "back", isLifetime: true }),
    ]);
    expect(relTypes(r)).toContain("duplicate");
    expect(blocking(r).length).toBeGreaterThan(0);
  });

  it("6. two alternative surgical procedures for the same pathology — mutually exclusive; more probable kept", () => {
    const r = analyzeConsistency([
      rec({ id: "a", service: "Anterior cervical discectomy and fusion", category: "NEUROSURGERY", conditionId: "cx", probability: "PROBABLE", confidence: 80 }),
      rec({ id: "b", service: "Cervical disc arthroplasty", category: "NEUROSURGERY", conditionId: "cx", probability: "POSSIBLE", confidence: 55, includedInTotal: false }),
    ]);
    expect(relTypes(r)).toContain("mutually_exclusive");
    const res = r.resolutions[0];
    expect(res.keep).toBe("a"); // PROBABLE beats POSSIBLE
    expect(res.costTiebreak).toBe(false);
  });

  it("7. two non-conflicting probable services coexist — no conflict, both allowed", () => {
    const r = analyzeConsistency([
      rec({ id: "pm", service: "Pain management office visits", category: "PAIN_MANAGEMENT", conditionId: "back" }),
      rec({ id: "img", service: "Surveillance lumbar MRI", category: "IMAGING", conditionId: "back", presentValue: 40000 }),
    ]);
    expect(blocking(r)).toHaveLength(0);
    expect(r.resolutions).toHaveLength(0);
  });

  it("cost never overrides probability: cheaper but more-probable option is kept", () => {
    const r = analyzeConsistency([
      rec({ id: "cheap", service: "Knee arthroplasty (standard)", category: "ORTHOPEDIC_SURGERY", conditionId: "knee", probability: "PROBABLE", presentValue: 40000 }),
      rec({ id: "pricey", service: "Custom robotic knee reconstruction", category: "ORTHOPEDIC_SURGERY", conditionId: "knee", probability: "POSSIBLE", presentValue: 120000 }),
    ]);
    expect(r.resolutions[0].keep).toBe("cheap");
    expect(r.resolutions[0].costTiebreak).toBe(false);
  });

  it("cost tiebreak fires only when probability AND support are equal, and is flagged", () => {
    const r = analyzeConsistency([
      rec({ id: "x", service: "Fusion approach X", category: "NEUROSURGERY", conditionId: "sp", probability: "PROBABLE", confidence: 70, presentValue: 50000 }),
      rec({ id: "y", service: "Fusion approach Y", category: "NEUROSURGERY", conditionId: "sp", probability: "PROBABLE", confidence: 70, presentValue: 90000 }),
    ]);
    const res = r.resolutions[0];
    expect(res.keep).toBe("y"); // higher cost, only because all else equal
    expect(res.costTiebreak).toBe(true);
  });
});

describe("staged/conditional metadata (§10)", () => {
  const rec2 = (o: Partial<ConsistencyRec> & { id: string; service: string }): ConsistencyRec => ({ probability: "PROBABLE", confidence: 70, presentValue: 10000, includedInTotal: true, ...o });

  it("an explicit replacesService makes the pair sequential, not concurrent", () => {
    const r = analyzeConsistency([
      rec2({ id: "cons", service: "Conservative lumbar management", category: "PAIN_MANAGEMENT", conditionId: "c1" }),
      rec2({ id: "fus", service: "Lumbar fusion", category: "NEUROSURGERY", conditionId: "c1", replacesService: "Conservative lumbar management", startTrigger: "if conservative care fails" }),
    ]);
    expect(r.relations.some((x) => x.type === "sequential" && /explicitly replaces/.test(x.basis))).toBe(true);
  });
});
