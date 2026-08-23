// Persisted array elements are input, not output.
//
// The schema validated that a field IS an array and stopped there, with a
// comment saying element shapes are not checked because "the elements this
// record holds are produced by the same builder that produces the record".
// That is wrong about where the data comes from: the validator's input is a
// row read back from the database, which can be legacy, hand-edited, or
// written by an older producer. Every one of these reaches a dereference.

import { describe, it, expect } from "vitest";
import { assessBasisCompleteness } from "@/lib/engine/basisCompleteness";
import { assembleBasis } from "@/lib/engine/basisAssembly";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const KASE: DossierCase = { subject: "p", pronounPoss: "their", lifeExpectancyYears: 30, adult: true };
const COND = { id: "c-1", name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED", objectiveEvidence: "narrowing", evidenceSources: [{ filename: "m.pdf", page: 4, quote: "loss" }] } as unknown as DossierCondition & { id: string };
const CHRONO: DossierChronoEvent[] = [{ eventDate: "2024-08-01", imagingFindings: "MRI of the right knee: chondral loss", sourcePage: 4 } as never];
const ITEM = {
  id: "i-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", specialty: "Ortho",
  probability: "PROBABLE", frequencyPerYear: 1, durationYears: 1, isLifetime: false,
  unitCost: 42000, lifetimeCost: 42000, presentValue: 38000, cptCode: "27447",
  physicianStatus: "APPROVED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1",
  pricingSource: "CMS fee schedule", contingencyOnly: false,
  startTrigger: null, prerequisite: null, earliestTiming: null, replacesService: null,
};
const complete = () => JSON.parse(JSON.stringify(assembleBasis({
  item: ITEM as never,
  dossier: buildRecommendationDossier(ITEM as never, COND, CHRONO, KASE),
  conditions: [COND as never], chronology: CHRONO, kase: KASE,
  assumptions: { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1, conditionName: COND.name },
})));

const set = (b: Record<string, unknown>, path: string, v: unknown) => {
  const parts = path.split(".");
  let cur: Record<string, unknown> = b;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  cur[parts[parts.length - 1]] = v;
};

describe("a null element is malformed, with an indexed path", () => {
  it.each([
    ["probabilityBasis.factors", "probabilityBasis.factors[0]"],
    ["acceptedEvidence.objectiveFindings", "acceptedEvidence.objectiveFindings[0]"],
    ["acceptedEvidence.diagnoses", "acceptedEvidence.diagnoses[0]"],
    ["literature", "literature[0]"],
    ["evidenceProvenance", "evidenceProvenance[0]"],
    ["assessmentBasis.supportingGuidelineAssessments", "assessmentBasis.supportingGuidelineAssessments[0]"],
    ["assessmentBasis.alternativesConsidered", "assessmentBasis.alternativesConsidered[0]"],
  ])("%s = [null]", (path, expected) => {
    // Each of these reaches a dereference in the report or the assessment
    // reader — f.present, x.text, l.authors, g.title, .rationale.
    const b = complete();
    set(b, path, [null]);
    const r = assessBasisCompleteness(b);
    expect(r.state, path).toBe("INCOMPLETE");
    expect(r.missing.some((m) => m.startsWith(expected)), `${path} → ${r.missing.join(", ")}`).toBe(true);
  });
});

describe("element field shapes are checked, not just element presence", () => {
  it("a factor missing `present` is malformed", () => {
    const b = complete();
    set(b, "probabilityBasis.factors", [{ label: "x" }]);
    const r = assessBasisCompleteness(b);
    expect(r.state).toBe("INCOMPLETE");
    expect(r.missing).toContain("probabilityBasis.factors[0].present");
  });

  it("a factor whose `present` is a string is malformed", () => {
    const b = complete();
    set(b, "probabilityBasis.factors", [{ label: "x", present: "yes" }]);
    expect(assessBasisCompleteness(b).missing).toContain("probabilityBasis.factors[0].present<type>");
  });

  it("an evidence row missing `text` is malformed", () => {
    const b = complete();
    set(b, "acceptedEvidence.objectiveFindings", [{ source: "p. 4" }]);
    expect(assessBasisCompleteness(b).missing).toContain("acceptedEvidence.objectiveFindings[0].text");
  });

  it("an evidence row may record a null source — that is an answer", () => {
    const b = complete();
    set(b, "acceptedEvidence.objectiveFindings", [{ text: "finding", source: null }]);
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });

  it("a literature row missing `title` is malformed", () => {
    const b = complete();
    set(b, "literature", [{ journal: null, year: null, authors: null, pmid: null, doi: null, studyType: "cohort", supports: "x", limitations: null }]);
    expect(assessBasisCompleteness(b).missing).toContain("literature[0].title");
  });

  it("contradictions must be strings, not objects", () => {
    // A malformed contradiction printed as [object Object].
    const b = complete();
    set(b, "contradictions", [{ text: "not a string" }]);
    expect(assessBasisCompleteness(b).missing).toContain("contradictions[0]<type>");
  });

  it("spinalLevels must be strings", () => {
    const b = complete();
    set(b, "spinalLevels", [4]);
    expect(assessBasisCompleteness(b).missing).toContain("spinalLevels[0]<type>");
  });

  it("potentialChallenges must be strings", () => {
    const b = complete();
    set(b, "assessmentBasis.potentialChallenges", [{}]);
    expect(assessBasisCompleteness(b).missing).toContain("assessmentBasis.potentialChallenges[0]<type>");
  });

  it("functionalBasis is validated as a real shape, not an empty object", () => {
    const b = complete();
    set(b, "assessmentBasis.functionalBasis", { domain: "gait" });
    const r = assessBasisCompleteness(b);
    expect(r.state).toBe("INCOMPLETE");
    expect(r.missing).toContain("assessmentBasis.functionalBasis.limitation");
  });

  it("a recorded null functionalBasis is still an answer", () => {
    const b = complete();
    set(b, "assessmentBasis.functionalBasis", null);
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });

  it("reports the index of the offending element, not just the array", () => {
    const b = complete();
    const good = { text: "ok", source: null };
    set(b, "acceptedEvidence.objectiveFindings", [good, good, null]);
    expect(assessBasisCompleteness(b).missing.some((m) => m.startsWith("acceptedEvidence.objectiveFindings[2]"))).toBe(true);
  });

  it("empty arrays remain COMPLETE", () => {
    const b = complete();
    for (const p of ["contradictions", "literature", "missingPremises", "evidenceProvenance", "spinalLevels"]) set(b, p, []);
    set(b, "probabilityBasis.factors", []);
    set(b, "acceptedEvidence.objectiveFindings", []);
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });
});

describe("domain values and finite numbers", () => {
  it.each([
    ["serviceFamily", "NOT_A_FAMILY"],
    ["supportClass", "MADE_UP"],
    ["assessmentBasis.inclusionInTotalsStatus", "maybe"],
    ["probabilityBasis.classification", "definitely"],
    ["projectionBasis.durationClass", "forever"],
    ["projectionBasis.pricingSourceCategory", "GUESSWORK"],
    ["specification.physicianStatus", "SORT_OF"],
    ["claimBasis.frequency.kind", "VIBES"],
  ])("%s rejects an out-of-domain value", (path, bad) => {
    // An arbitrary string changes membership or makes a label lookup print
    // undefined; the type check alone cannot see it.
    const b = complete();
    set(b, path, bad);
    const r = assessBasisCompleteness(b);
    expect(r.state, path).toBe("INCOMPLETE");
    expect(r.missing, path).toContain(`${path}<value>`);
  });

  it.each([
    ["specification.unitCost", NaN],
    ["specification.presentValue", Infinity],
    ["projectionBasis.frequencyPerYear", -Infinity],
    ["specification.lifetimeQuantity", NaN],
  ])("%s rejects a non-finite number", (path, bad) => {
    const b = complete();
    set(b, path, bad);
    const r = assessBasisCompleteness(b);
    expect(r.state, path).toBe("INCOMPLETE");
    expect(r.missing, path).toContain(`${path}<type>`);
  });

  it("a freshly assembled basis still passes every domain check", () => {
    const r = assessBasisCompleteness(complete());
    expect(r.state, r.missing.join(", ")).toBe("COMPLETE");
  });
});
