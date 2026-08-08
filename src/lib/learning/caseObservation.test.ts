// Observation is the half of learning that runs on every case, so it must be
// honest about our OWN output with no ground truth to lean on: a clause that
// never fires has to show as dead, a profile that composes nothing has to show
// as falling back, and a fact the planner wants that we cannot produce has to
// surface as a gap rather than as an emphasis question.
import { describe, it, expect } from "vitest";
import { observeCase, mergeObservations, findEmphasisGaps, findDeadClauses, deriveNorms, checkAgainstNorms, type ObservedEncounter } from "./caseObservation";
import type { EmphasisProfile } from "@/lib/llm/summaryEmphasis";
import type { Proposal } from "./emphasisLearning";

const PROFILE: EmphasisProfile = {
  basis: "published-corpus",
  observed: 100,
  clauses: [
    { fields: ["subjective"], prefix: "reported: ", share: 0.9 },
    { fields: ["assessment"], prefix: "assessment: ", share: 0.8 },
    { fields: ["impression"], prefix: "impression: ", share: 0.7 },
  ],
};
const profileFor = () => PROFILE;

const enc = (fields: Record<string, string>): ObservedEncounter => ({
  analysisClass: "CLINICAL_ENCOUNTER",
  claims: Object.entries(fields).map(([field, value]) => ({ field, value })),
});

describe("observing a case with no published plan", () => {
  const encounters = [
    enc({ subjective: "Low back pain since the fall", assessment: "Lumbar strain" }),
    enc({ subjective: "No improvement reported", assessment: "Radiculopathy" }),
    enc({ assessment: "Contusion" }),
    enc({ medications: "Atorvastatin 40 mg" }),
  ];

  it("measures what our own extraction actually yields", () => {
    const obs = observeCase(encounters, profileFor)!.CLINICAL_ENCOUNTER!;
    expect(obs.encounters).toBe(4);
    expect(obs.fieldYield.find((f) => f.field === "assessment")!.yield).toBe(0.75);
    expect(obs.fieldYield.find((f) => f.field === "subjective")!.yield).toBe(0.5);
  });

  it("counts the encounters where the profile composed nothing at all", () => {
    // The last encounter has only a medication list; no clause of the profile
    // can draw on it, so the caller must fall back.
    const obs = observeCase(encounters, profileFor)!.CLINICAL_ENCOUNTER!;
    expect(obs.composed).toBe(3);
    expect(obs.fellBack).toBe(1);
    expect(obs.profileMissed).toBe(1);
    expect(obs.noProfile).toBe(0);
  });

  it("separates having no shape from having one that does not fit", () => {
    // A class with a single field has no shape to impose, and the fallback path
    // states that one fact with a more generous length than a clause would
    // allow. Reported as a failure, it sends a reader looking for a defect that
    // is a design working as intended.
    const obs = observeCase(encounters, () => null)!.CLINICAL_ENCOUNTER!;
    expect(obs.fellBack).toBe(4);
    expect(obs.noProfile).toBe(4);
    expect(obs.profileMissed).toBe(0);
  });

  it("reports a clause that never had anything to say", () => {
    const obs = observeCase(encounters, profileFor)!.CLINICAL_ENCOUNTER!;
    const impression = obs.clauses.find((c) => c.fields[0] === "impression")!;
    expect(impression.fired).toBe(0);
    expect(impression.fireRate).toBe(0);
  });

  it("does not count unusable text as yield", () => {
    // An intake recital and a restated field label are real strings in the
    // record and neither can carry a summary; counting them as yield would
    // report a capability we do not have.
    const obs = observeCase(
      [enc({ subjective: "Never smoker", assessment: "Encounter Date: Jul 18, 2023" })],
      profileFor,
    )!.CLINICAL_ENCOUNTER!;
    expect(obs.fieldYield).toHaveLength(0);
    expect(obs.fellBack).toBe(1);
  });
});

describe("finding dead clauses", () => {
  it("stays silent when there is too little to judge on", () => {
    const few = observeCase([enc({ subjective: "x y z" })], profileFor);
    expect(findDeadClauses(few)).toHaveLength(0);
  });

  it("names a clause that never fired across a real number of encounters", () => {
    const many = observeCase(
      Array.from({ length: 30 }, () => enc({ subjective: "Low back pain reported today", assessment: "Lumbar strain" })),
      profileFor,
    );
    const dead = findDeadClauses(many);
    expect(dead).toHaveLength(1);
    expect(dead[0].fields).toEqual(["impression"]);
  });
});

describe("merging observations across cases", () => {
  it("adds up encounters and re-derives the rates over the total", () => {
    const a = observeCase([enc({ subjective: "pain in the lower back" })], profileFor);
    const b = observeCase(
      [enc({ assessment: "Lumbar strain" }), enc({ assessment: "Radiculopathy" }), enc({ assessment: "Contusion" })],
      profileFor,
    );
    const merged = mergeObservations([a, b])!.CLINICAL_ENCOUNTER!;
    expect(merged.encounters).toBe(4);
    expect(merged.fieldYield.find((f) => f.field === "assessment")!.yield).toBe(0.75);
    expect(merged.fieldYield.find((f) => f.field === "subjective")!.yield).toBe(0.25);
  });
});

describe("checking a case that has no plan to check it against", () => {
  const healthy = () =>
    observeCase(
      Array.from({ length: 20 }, () => enc({ subjective: "reported pain in the lower back", assessment: "Lumbar strain" })),
      profileFor,
    );

  it("will not state a norm from too few cases", () => {
    // Two cases are an anecdote. Deviation from an anecdote means nothing, and
    // reporting it would train a reviewer to ignore the screen.
    const norms = deriveNorms([healthy(), healthy()]);
    expect(norms.CLINICAL_ENCOUNTER).toBeUndefined();
    expect(deriveNorms([healthy(), healthy(), healthy()]).CLINICAL_ENCOUNTER).toBeDefined();
  });

  it("says nothing about a case that looks like the others", () => {
    const norms = deriveNorms([healthy(), healthy(), healthy()]);
    expect(checkAgainstNorms(healthy(), norms)).toHaveLength(0);
  });

  it("catches a case whose records produced almost nothing", () => {
    // The shape of a document set that OCR'd badly: the records are there, the
    // facts are not. No published plan is needed to see it.
    const starved = observeCase(
      Array.from({ length: 20 }, () => enc({ medications: "Atorvastatin 40 mg" })),
      profileFor,
    );
    const anomalies = checkAgainstNorms(starved, deriveNorms([healthy(), healthy(), healthy()]));
    expect(anomalies.map((a) => a.measure)).toContain("composition misfit");
    expect(anomalies.some((a) => a.measure === "missing assessment")).toBe(true);
  });

  it("catches a field that normally arrives and did not", () => {
    const noAssessment = observeCase(
      Array.from({ length: 20 }, () => enc({ subjective: "reported pain in the lower back" })),
      profileFor,
    );
    const anomalies = checkAgainstNorms(noAssessment, deriveNorms([healthy(), healthy(), healthy()]));
    expect(anomalies.find((a) => a.measure === "missing assessment")?.expected).toBe(1);
  });

  it("stays quiet on a case too small to judge", () => {
    const tiny = observeCase([enc({ medications: "Atorvastatin 40 mg" })], profileFor);
    expect(checkAgainstNorms(tiny, deriveNorms([healthy(), healthy(), healthy()]))).toHaveLength(0);
  });

  it("counts a case that never yielded a field as a zero, not as absent", () => {
    // Otherwise a field only one case ever produces looks universal, and every
    // other case gets flagged for missing it.
    const withImpression = observeCase(
      Array.from({ length: 20 }, () => enc({ subjective: "reported pain", impression: "L4-L5 extrusion" })),
      profileFor,
    );
    const norms = deriveNorms([withImpression, healthy(), healthy()]);
    expect(norms.CLINICAL_ENCOUNTER!.medianYield.impression).toBe(0);
  });
});

describe("joining the two halves", () => {
  const proposal: Proposal = {
    profiles: { CLINICAL_ENCOUNTER: PROFILE },
    unmapped: [],
    outsideVocabulary: [],
    insufficient: [],
  };

  it("names a fact the planner wants that we almost never produce", () => {
    // The planner writes an impression in 70% of entries; our extraction gives
    // us one almost never. That is not something to re-order a summary around.
    const observed = observeCase(
      Array.from({ length: 20 }, () => enc({ subjective: "reported pain today", assessment: "Lumbar strain" })),
      profileFor,
    );
    const gaps = findEmphasisGaps(proposal, observed);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fields).toEqual(["impression"]);
    expect(gaps[0].plannerShare).toBe(0.7);
    expect(gaps[0].ourYield).toBe(0);
  });

  it("does not call it a gap when our extraction keeps up", () => {
    const observed = observeCase(
      Array.from({ length: 20 }, () =>
        enc({ subjective: "reported pain today", assessment: "Lumbar strain", impression: "L4-L5 extrusion" }),
      ),
      profileFor,
    );
    expect(findEmphasisGaps(proposal, observed)).toHaveLength(0);
  });

  it("ignores a clause the planner rarely writes anyway", () => {
    const rare: Proposal = {
      ...proposal,
      profiles: {
        CLINICAL_ENCOUNTER: { ...PROFILE, clauses: [{ fields: ["impression"], prefix: "impression: ", share: 0.1 }] },
      },
    };
    const observed = observeCase(Array.from({ length: 20 }, () => enc({ subjective: "reported pain" })), profileFor);
    expect(findEmphasisGaps(rare, observed)).toHaveLength(0);
  });
});
