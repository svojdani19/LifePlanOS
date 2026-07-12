import { describe, it, expect } from "vitest";
import { extractGuidelineQuote, assembleAnalysis, type SocGuideline } from "./standardOfCare";

// EventRow shape assembleAnalysis expects.
const ev = (o: Partial<{ eventDate: Date; summary: string; sourcePage: number | null; eventType: string | null; treatment: string | null; diagnosis: string | null; clinicalSignificance: string | null }>) => ({
  eventDate: o.eventDate ?? new Date("2024-06-12"),
  summary: o.summary ?? "",
  sourcePage: o.sourcePage ?? null,
  eventType: o.eventType ?? null,
  treatment: o.treatment ?? null,
  diagnosis: o.diagnosis ?? null,
  clinicalSignificance: o.clinicalSignificance ?? null,
});

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

describe("assembleAnalysis — expert rationale", () => {
  const guideline: SocGuideline = {
    source: "Europe PMC",
    title: "Tibial Plateau Fracture Consensus",
    journal: "J Orthop",
    year: "2023",
    authors: "Smith et al.",
    url: "https://example.org/g1",
    quote: "For tibial plateau fracture, primary definitive fixation is recommended in stable patients.",
  };

  it("emits a deposition-style rationale grounded in the guideline and record", () => {
    const soc = assembleAnalysis(
      "Fracture of tibial plateau",
      true,
      [guideline],
      [ev({ summary: "ORIF of the tibial plateau performed", treatment: "open reduction internal fixation", diagnosis: "tibial plateau fracture", sourcePage: 3, eventType: "OPERATIVE_NOTE" })],
      [],
      [],
      true,
    );
    const op = soc.assessment.opinion;
    expect(Array.isArray(op)).toBe(true);
    expect(op.length).toBeGreaterThanOrEqual(3);
    // States the standard for THIS diagnosis, citing the guideline.
    expect(op[0]).toContain("Fracture of tibial plateau");
    expect(op[0]).toContain("standard of care");
    expect(op[0]).toContain("Tibial Plateau Fracture Consensus");
    // Identifies the appropriately-addressed decision point, grounded in the record.
    expect(op.join(" ")).toMatch(/appropriately addressed/i);
    expect(op.join(" ")).toContain("p. 3");
    // Closes with the reserved-to-physician determination.
    expect(op[op.length - 1]).toMatch(/reviewing physician/i);
  });

  it("flags an undocumented recommendation as a potential departure", () => {
    const soc = assembleAnalysis(
      "Fracture of tibial plateau",
      true,
      [guideline],
      [], // no records document the recommended fixation
      [],
      [],
      true,
    );
    expect(soc.assessment.verdict).toBe("POTENTIAL_GAP");
    expect(soc.assessment.opinion.join(" ")).toMatch(/departure from the standard/i);
  });

  it("honestly reports when no guideline was located", () => {
    const soc = assembleAnalysis("Some rare diagnosis", true, [], [], [], [], true);
    expect(soc.assessment.opinion).toHaveLength(1);
    expect(soc.assessment.opinion[0]).toMatch(/no indexed clinical practice guideline/i);
  });
});
