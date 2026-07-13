import { describe, it, expect } from "vitest";
import { pricingSourceFor, guidelineSourcesFor, referencesFor } from "./sources";

describe("reference-source registry", () => {
  it("routes each care category to its correct pricing source", () => {
    expect(pricingSourceFor("MEDICATION").id).toBe("goodrx");
    expect(pricingSourceFor("ATTENDANT_CARE").id).toBe("genworth");
    expect(pricingSourceFor("SKILLED_NURSING").id).toBe("genworth");
    expect(pricingSourceFor("DME").id).toBe("dmedirect");
    expect(pricingSourceFor("MOBILITY_AID").id).toBe("dmedirect");
    expect(pricingSourceFor("ORTHOTICS_PROSTHETICS").id).toBe("rinellapro");
    expect(pricingSourceFor("LABS").id).toBe("healix");
    expect(pricingSourceFor("ORTHOPEDIC_SURGERY").id).toBe("fairhealth");
    expect(pricingSourceFor("PAIN_MANAGEMENT").id).toBe("fairhealth");
  });

  it("selects specialty-apt guideline/evidence sources (ODG first)", () => {
    const pain = guidelineSourcesFor("PAIN_MANAGEMENT", "lumbar").map((s) => s.id);
    expect(pain[0]).toBe("odg");
    expect(pain).toContain("aapm"); // pain guidance
    expect(pain).toContain("moss-opioid-weaning"); // opioid weaning literature
    const spine = guidelineSourcesFor("NEUROSURGERY", "lumbar").map((s) => s.id);
    expect(spine).toContain("orthobullets"); // spine clinical guidance
    expect(spine).toContain("milliman"); // lumbar utilization study
  });

  it("does NOT attach pain-only sources to an unrelated recommendation", () => {
    const img = guidelineSourcesFor("IMAGING", "knee").map((s) => s.id);
    expect(img).not.toContain("aapm");
    expect(img).not.toContain("moss-opioid-weaning");
  });

  it("references appendix lists only the sources the plan relied upon, deduped", () => {
    const refs = referencesFor(["MEDICATION", "PAIN_MANAGEMENT"], { includeGuidelines: true }).map((s) => s.id);
    expect(new Set(refs).size).toBe(refs.length); // deduped
    expect(refs).toContain("goodrx");
    expect(refs).toContain("fairhealth");
    expect(refs).toContain("odg");
    expect(refs).not.toContain("rinellapro"); // no prosthetics in this plan
  });
});
