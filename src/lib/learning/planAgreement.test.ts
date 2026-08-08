// A score that flatters the program is worse than no score. These cases pin the
// measurements to things that can actually be wrong: a missed date must cost
// recall, a fact left out of the summary must cost summary recall WITHOUT
// costing extraction recall, and leading with the wrong clause must show.
import { describe, it, expect } from "vitest";
import { salientTerms, scoreAgreement, type ProgramEntry } from "./planAgreement";
import type { PublishedEntry } from "./publishedPlan";

const published = (isoDate: string, clauses: [string, string][]): PublishedEntry => ({
  date: isoDate,
  isoDate,
  heading: "provider",
  kind: "CLINICAL_ENCOUNTER",
  clauses: clauses.map(([label, text]) => ({ label, text })),
});

const program = (isoDate: string, leadField: string | null, summary: string, claimText = summary): ProgramEntry => ({
  isoDate,
  leadField,
  summary,
  claimText,
});

describe("salient terms", () => {
  it("keeps an anatomic level whole", () => {
    // Split on the hyphen, "L4-L5" becomes two meaningless numbers and the most
    // load-bearing detail in a spine record is thrown away.
    expect(salientTerms("Disc extrusion at L4-L5")).toContain("l4-l5");
  });

  it("drops grammar and bare numbers", () => {
    const terms = salientTerms("The patient was noted to have 4 of them");
    expect(terms.has("patient")).toBe(false);
    expect(terms.has("the")).toBe(false);
    expect(terms.has("4")).toBe(false);
  });
});

describe("scoring against a published plan", () => {
  it("charges a missed date to recall", () => {
    const score = scoreAgreement(
      [published("2025-01-01", [["assessment", "Lumbar strain"]]), published("2025-02-01", [["assessment", "Radiculopathy"]])],
      [program("2025-01-01", "assessment", "Lumbar strain")],
    );
    expect(score.publishedDates).toBe(2);
    expect(score.matchedDates).toBe(1);
    expect(score.dateRecall).toBe(0.5);
  });

  it("counts an entry the planner did not chronicle without pretending it is wrong", () => {
    // The planner omits records; so may we. It is reported, not penalized.
    const score = scoreAgreement(
      [published("2025-01-01", [["assessment", "Lumbar strain"]])],
      [program("2025-01-01", "assessment", "Lumbar strain"), program("2025-03-03", "assessment", "Something else")],
    );
    expect(score.unmatchedProgramDates).toBe(1);
    expect(score.dateRecall).toBe(1);
  });

  it("separates a fact we never extracted from one we extracted and left out", () => {
    const plan = [published("2025-01-01", [["impression", "extrusion at L4-L5 with stenosis"]])];

    // Extracted and surfaced.
    const surfaced = scoreAgreement(plan, [program("2025-01-01", "impression", "extrusion at L4-L5 with stenosis")]);
    expect(surfaced.extractionRecall).toBe(1);
    expect(surfaced.summaryRecall).toBe(1);

    // Extracted, but the summary left it out: an EMPHASIS defect.
    const buried = scoreAgreement(plan, [
      program("2025-01-01", "impression", "study performed", "extrusion at L4-L5 with stenosis"),
    ]);
    expect(buried.extractionRecall).toBe(1);
    expect(buried.summaryRecall).toBeLessThan(0.5);

    // Never extracted at all: an EXTRACTION defect.
    const missing = scoreAgreement(plan, [program("2025-01-01", "impression", "study performed", "study performed")]);
    expect(missing.extractionRecall).toBeLessThan(0.5);
  });

  it("agrees on the lead only when the clause kinds match", () => {
    const plan = [published("2025-01-01", [["impression", "L4-L5 extrusion"], ["findings", "disc bulge"]])];
    expect(scoreAgreement(plan, [program("2025-01-01", "impression", "L4-L5 extrusion")]).leadAgreement).toBe(1);
    expect(scoreAgreement(plan, [program("2025-01-01", "diagnosticStudies", "disc bulge")]).leadAgreement).toBe(0);
  });

  it("does not score a lead it cannot compare", () => {
    // No composed summary means nothing to compare — that must not read as
    // agreement, and it must not read as disagreement either.
    const plan = [published("2025-01-01", [["impression", "L4-L5 extrusion"]])];
    const score = scoreAgreement(plan, [program("2025-01-01", null, "")]);
    expect(score.leadComparable).toBe(0);
    expect(score.leadAgreement).toBe(0);
  });

  it("accepts any of the day's entries when the planner wrote several", () => {
    const plan = [
      published("2025-01-01", [["assessment", "Lumbar strain"]]),
      published("2025-01-01", [["impression", "L4-L5 extrusion"]]),
    ];
    expect(scoreAgreement(plan, [program("2025-01-01", "impression", "L4-L5 extrusion")]).leadAgreement).toBe(1);
  });
});
