import { describe, it, expect } from "vitest";
import { lintNarrative, lintAssessmentNarratives } from "./narrativeSanity";

const kneeCtx = { service: "Total knee arthroplasty", region: "knee", physicianStatus: "PENDING", isLifetime: false, durationYears: 5, frequencyPerYear: 4, inclusionInTotalsStatus: "included", diagnosis: "Post-traumatic osteoarthritis of the right knee" };

describe("lintNarrative — does this make sense to say here?", () => {
  it("flags anatomy incoherence (the David Chen defect class)", () => {
    const issues = lintNarrative("medicalNecessityRationale",
      "David Chen's fracture of tibial plateau rests on a concrete finding — L1 burst fracture with retropulsion and canal compromise.", kneeCtx);
    expect(issues.some((i) => i.rule === "anatomy_incoherence" && i.severity === "High")).toBe(true);
  });

  it("flags a broken page citation and unbalanced parentheses", () => {
    const issues = lintNarrative("medicalNecessityRationale",
      'The record reflects open reduction internal fixation, left tibial plateau." (Uploaded_Document_01.pdf, p. Prior treatment has not returned the patient to baseline.', kneeCtx);
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain("broken_citation");
    expect(rules).toContain("unbalanced_parens");
  });

  it("flags a state contradiction: text asserts approval while the item is pending", () => {
    const issues = lintNarrative("frequencyRationale",
      "The frequency is grounded in physician review — the reviewing physician approved this recommendation.", kneeCtx);
    expect(issues.some((i) => i.rule === "state_contradiction")).toBe(true);
  });

  it("flags a duration contradiction and a frequency mismatch", () => {
    expect(lintNarrative("durationRationale", "This care continues across the patient's lifetime.", kneeCtx)
      .some((i) => i.rule === "duration_contradiction")).toBe(true);
    expect(lintNarrative("frequencyRationale", "The 12×/yr frequency is grounded in the documented cadence.", kneeCtx)
      .some((i) => i.rule === "frequency_mismatch")).toBe(true);
  });

  it("flags placeholder leakage and dangling clauses", () => {
    expect(lintNarrative("inclusionRationale", "Included in totals because undefined supports the need.", kneeCtx)
      .some((i) => i.rule === "placeholder_leak")).toBe(true);
    expect(lintNarrative("timingRationale", "Care begins after the documented trigger and", kneeCtx)
      .some((i) => i.rule === "dangling_clause")).toBe(true);
  });

  it("tolerates a passing mention of another region when it is not the evidentiary anchor", () => {
    const spineCtx = { ...kneeCtx, service: "Orthopedic follow-up visits", region: "spine" };
    const issues = lintNarrative("medicalNecessityRationale",
      "Orthopedic follow-up visits address surveillance of post-traumatic knee arthritis toward coordinated oversight.", spineCtx);
    expect(issues.some((i) => i.rule === "anatomy_incoherence")).toBe(false);
  });

  it("does not misread a decimal frequency (0.2×/yr) as an integer mismatch", () => {
    const issues = lintNarrative("frequencyRationale",
      "The 0.2×/yr frequency is grounded in the documented treatment cadence.", { ...kneeCtx, frequencyPerYear: 0.2 });
    expect(issues.some((i) => i.rule === "frequency_mismatch")).toBe(false);
  });

  it("passes clean, situation-consistent text without manufactured issues", () => {
    const issues = lintNarrative("medicalNecessityRationale",
      "Ms. Trice's post-traumatic osteoarthritis of the right knee rests on tricompartmental joint-space narrowing on weight-bearing radiographs (xray.pdf, p. 2). The 4×/yr frequency reflects the documented cadence over a 5-year course.", kneeCtx);
    expect(issues).toEqual([]);
  });
});

describe("lintAssessmentNarratives", () => {
  it("sweeps every narrative field of an assessment", () => {
    const fake = {
      recommendationService: "Total knee arthroplasty",
      bodyRegion: "knee",
      medicalNecessityRationale: "Anchored on L1 burst fracture with retropulsion.", // wrong anatomy
      frequencyRationale: "The 12×/yr frequency is grounded in the record.", // wrong number
      durationRationale: null,
    };
    const issues = lintAssessmentNarratives(fake as never, { physicianStatus: "PENDING", isLifetime: false, durationYears: 5, frequencyPerYear: 4 });
    expect(issues.filter((i) => i.field === "medicalNecessityRationale").some((i) => i.rule === "anatomy_incoherence")).toBe(true);
    expect(issues.filter((i) => i.field === "frequencyRationale").some((i) => i.rule === "frequency_mismatch")).toBe(true);
  });
});
