import { describe, it, expect } from "vitest";
import { extractGuidelineQuote } from "./standardOfCare";

describe("extractGuidelineQuote", () => {
  const abstract =
    "Background This study reviewed the literature. Methods A systematic search was performed. " +
    "Statistical significance was set at p < 0.05. A total of 1,200 patients were identified. " +
    "For periprosthetic joint infection, two-stage revision is recommended as the standard of care in chronic cases. " +
    "The prosthesis should be removed and antibiotic spacer placed.";

  it("quotes the on-topic recommendation, not the stats or methods sentence", () => {
    const r = extractGuidelineQuote(abstract, "Infection due to internal knee prosthesis");
    expect(r).not.toBeNull();
    expect(r!.quote.toLowerCase()).toContain("prosthesis"); // the distinctive term
    expect(r!.quote.toLowerCase()).toMatch(/recommended|should/);
    expect(r!.quote).not.toContain("Statistical significance");
    expect(r!.quote).not.toContain("A total of");
  });

  it("appends the continuing imperative sentence when it fits", () => {
    const r = extractGuidelineQuote(abstract, "periprosthetic prosthesis infection");
    expect(r!.quote).toContain("antibiotic spacer placed"); // "should be removed…" continuation
  });

  it("returns null when no sentence pertains to the condition", () => {
    expect(extractGuidelineQuote(abstract, "traumatic brain injury concussion")).toBeNull();
  });

  it("returns null for a condition with no distinctive terms", () => {
    expect(extractGuidelineQuote(abstract, "chronic pain")).toBeNull();
  });

  it("recognizes concept-vocabulary guidance for an ICD-phrased condition", () => {
    // The guideline speaks in standard terms ("traumatic brain injury") while the
    // condition is ICD-phrased ("Severe TBI with spastic quadriparesis"). Folding
    // the mapped concept's vocabulary into the term set must let the quote attach
    // (previously returned null because neither "TBI" nor "quadriparesis" appears).
    const abstract =
      "This consensus statement addresses rehabilitation after neurologic injury. " +
      "For traumatic brain injury, early multidisciplinary rehabilitation is recommended to improve functional outcomes.";
    const r = extractGuidelineQuote(abstract, "Severe TBI with spastic quadriparesis");
    expect(r).not.toBeNull();
    expect(r!.quote.toLowerCase()).toContain("brain");
    expect(r!.quote.toLowerCase()).toMatch(/recommended/);
  });

  it("ungluess structured-abstract headers so the quote is clean", () => {
    const glued =
      "Objective To summarize guidance.ResultsArticle 1: For tibial plateau fracture, primary definitive fixation is recommended in stable patients.";
    const r = extractGuidelineQuote(glued, "Fracture of tibial plateau");
    expect(r).not.toBeNull();
    expect(r!.quote).not.toMatch(/ResultsArticle/);
    expect(r!.quote.toLowerCase()).toContain("tibial plateau");
    expect(r!.quote.toLowerCase()).toContain("recommended");
  });
});
