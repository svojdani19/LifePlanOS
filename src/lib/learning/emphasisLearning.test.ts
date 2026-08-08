// What the program learns has to be traceable to what it was shown. These cases
// hold the derivation to that: the measurements come out of the entries, a kind
// with thin evidence is held back rather than fitted, and a clause we have no
// field for is REPORTED rather than quietly dropped.
import { describe, it, expect } from "vitest";
import { measureEmphasis, proposeProfile, renderEmphasisSource, mergeForAdoption, MIN_ENTRIES_FOR_PROFILE } from "./emphasisLearning";
import type { PublishedEntry } from "./publishedPlan";

const entry = (kind: PublishedEntry["kind"], labels: string[], n = 1): PublishedEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    date: "01/01/2025",
    isoDate: "2025-01-01",
    heading: `provider ${i}`,
    kind,
    clauses: labels.map((label) => ({ label, text: `${label} text ${i}` })),
  }));

describe("measuring what a planner did", () => {
  const entries = [
    ...entry("CLINICAL_ENCOUNTER", ["subjective", "exam", "assessment", "plan"], 10),
    ...entry("CLINICAL_ENCOUNTER", ["subjective", "assessment", "plan"], 6),
    ...entry("CLINICAL_ENCOUNTER", ["subjective"], 4),
  ];

  it("counts how often a clause appears and where it sits", () => {
    const stats = measureEmphasis(entries)!.CLINICAL_ENCOUNTER!;
    expect(stats.labelled).toBe(20);
    const subjective = stats.clauses.find((c) => c.label === "subjective")!;
    expect(subjective.share).toBe(1);
    expect(subjective.meanPosition).toBe(0);
    const exam = stats.clauses.find((c) => c.label === "exam")!;
    expect(exam.count).toBe(10);
    expect(exam.share).toBe(0.5);
  });

  it("measures separately what survives when the planner writes only one clause", () => {
    const stats = measureEmphasis(entries)!.CLINICAL_ENCOUNTER!;
    expect(stats.solo).toBe(4);
    expect(stats.clauses.find((c) => c.label === "subjective")!.soloShare).toBe(1);
    expect(stats.clauses.find((c) => c.label === "plan")!.soloShare).toBe(0);
  });

  it("drops a clause that appeared once — one sentence is not a pattern", () => {
    const stats = measureEmphasis([...entries, ...entry("CLINICAL_ENCOUNTER", ["horoscope"], 1)])!.CLINICAL_ENCOUNTER!;
    expect(stats.clauses.map((c) => c.label)).not.toContain("horoscope");
  });
});

describe("proposing a profile", () => {
  it("leads with the clause the planner keeps when they keep only one", () => {
    // Written last in every full entry, but the only clause of every compressed
    // one: a bounded summary is the compressed form, so it leads.
    const entries = [
      ...entry("DIAGNOSTIC_STUDY", ["findings", "impression"], 20),
      ...entry("DIAGNOSTIC_STUDY", ["impression"], 8),
    ];
    const { profiles } = proposeProfile(measureEmphasis(entries));
    const study = profiles.DIAGNOSTIC_STUDY!;
    expect(study.clauses[0].fields).toEqual(["impression"]);
    expect(study.clauses[1].fields).toEqual(["diagnosticStudies"]);
    expect(study.basis).toBe("published-corpus");
    expect(study.observed).toBe(28);
  });

  it("orders everything after the lead the way the planner narrates it", () => {
    const entries = entry("CLINICAL_ENCOUNTER", ["subjective", "exam", "assessment", "plan"], 20);
    const { profiles } = proposeProfile(measureEmphasis(entries));
    expect(profiles.CLINICAL_ENCOUNTER!.clauses.map((c) => c.fields[0])).toEqual([
      "subjective",
      "objectiveFindings",
      "assessment",
      "recommendations",
    ]);
  });

  it("holds back a kind with too little evidence instead of fitting it", () => {
    const thin = entry("TESTIMONY", ["testimony", "admission"], MIN_ENTRIES_FOR_PROFILE - 1);
    const { profiles, insufficient } = proposeProfile(measureEmphasis(thin));
    expect(profiles.TESTIMONY).toBeUndefined();
    expect(insufficient).toContainEqual({ kind: "TESTIMONY", labelled: MIN_ENTRIES_FOR_PROFILE - 1 });
  });

  it("reports a clause no field of ours can express, rather than dropping it", () => {
    // The planner says something the schema has no room for. That is a finding
    // about our schema — the kind of thing this whole exercise exists to catch.
    const entries = entry("CLINICAL_ENCOUNTER", ["subjective", "psychosocial barriers", "plan"], 20);
    const { unmapped } = proposeProfile(measureEmphasis(entries));
    expect(unmapped).toContainEqual({ kind: "CLINICAL_ENCOUNTER", label: "psychosocial barriers", share: 1 });
  });

  it("distinguishes a field we lack from one this document may not express", () => {
    // The planner writes an assessment inside a procedure entry. We HAVE an
    // assessment field; OPERATIVE is not allowed one. Reporting that as "no
    // field expresses it" would hide a real question about our vocabulary.
    const entries = entry("OPERATIVE", ["procedure performed", "assessment"], 20);
    const { unmapped, outsideVocabulary } = proposeProfile(measureEmphasis(entries));
    expect(unmapped.map((u) => u.label)).not.toContain("assessment");
    expect(outsideVocabulary).toContainEqual({
      kind: "OPERATIVE",
      label: "assessment",
      share: 1,
      fields: ["assessment"],
    });
  });

  it("does not spend two clauses on one field", () => {
    // "Procedure performed:" and "Procedure:" are one clause of ours. A second
    // over the same field can never fire — the first consumes the claim — and
    // it would waste a slot of a three-clause summary.
    const entries = entry("OPERATIVE", ["procedure performed", "procedure", "medication used"], 20);
    const { profiles } = proposeProfile(measureEmphasis(entries));
    const signatures = profiles.OPERATIVE!.clauses.map((c) => c.fields.join("|"));
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe("merging a candidate for adoption", () => {
  const incumbent = {
    CLINICAL_ENCOUNTER: {
      basis: "published-corpus" as const,
      observed: 164,
      clauses: [
        { fields: ["subjective" as const], prefix: "reported: ", share: 0.91 },
        { fields: ["procedure" as const], prefix: "procedure: ", share: 0.81, carried: true as const },
        { fields: ["disposition" as const], prefix: "disposition: ", share: 0 },
      ],
    },
    FINANCIAL: {
      basis: "hand-shaped" as const,
      observed: 0,
      clauses: [{ fields: ["charge" as const], prefix: "charge: ", share: 0 }],
    },
  };

  it("keeps a clause the corpus cannot teach", () => {
    // A planner gives a procedure its own entry, so no encounter entry ever
    // labels one. Derived alone, the clause vanishes and a visit where an
    // injection was performed stops saying so.
    const candidate = {
      CLINICAL_ENCOUNTER: {
        basis: "published-corpus" as const,
        observed: 200,
        clauses: [{ fields: ["subjective" as const], prefix: "reported: ", share: 0.93 }],
      },
    };
    const merged = mergeForAdoption(candidate, incumbent);
    const fields = merged.CLINICAL_ENCOUNTER!.clauses.map((c) => c.fields[0]);
    expect(fields).toContain("procedure");
    expect(fields).toContain("disposition");
    // The measured clause is the candidate's, with its newer share.
    expect(merged.CLINICAL_ENCOUNTER!.clauses[0].share).toBe(0.93);
    expect(merged.CLINICAL_ENCOUNTER!.observed).toBe(200);
  });

  it("leaves a kind the corpus never chronicles exactly as it was", () => {
    const merged = mergeForAdoption({ CLINICAL_ENCOUNTER: incumbent.CLINICAL_ENCOUNTER }, incumbent);
    expect(merged.FINANCIAL).toEqual(incumbent.FINANCIAL);
  });

  it("takes the weight from the measurement and the fields from the human", () => {
    // Our therapy clause prefers the modality DELIVERED over the course
    // advised. The planner writes one "Plan:" paragraph covering both, so a
    // derivation cannot see that preference and would silently reverse it.
    const prior = {
      THERAPY_COURSE: {
        basis: "published-corpus" as const,
        observed: 17,
        clauses: [{ fields: ["treatment" as const, "recommendations" as const], prefix: "care: ", share: 1 }],
      },
    };
    const candidate = {
      THERAPY_COURSE: {
        basis: "published-corpus" as const,
        observed: 40,
        clauses: [{ fields: ["recommendations" as const, "treatment" as const], prefix: "plan: ", share: 0.87 }],
      },
    };
    const merged = mergeForAdoption(candidate, prior).THERAPY_COURSE!;
    expect(merged.clauses).toHaveLength(1);
    expect(merged.clauses[0].fields).toEqual(["treatment", "recommendations"]);
    expect(merged.clauses[0].prefix).toBe("care: ");
    expect(merged.clauses[0].share).toBe(0.87);
  });

  it("does not restate a hand-shaped profile as a measured one", () => {
    const src = renderEmphasisSource(
      { profiles: { FINANCIAL: incumbent.FINANCIAL }, unmapped: [], outsideVocabulary: [], insufficient: [] },
      "test",
    );
    expect(src).toContain(`basis: "hand-shaped"`);
    expect(src).not.toContain(`FINANCIAL: {\n    basis: "published-corpus"`);
  });

  it("renders a proposal as source a person can diff and commit", () => {
    const entries = [
      ...entry("DIAGNOSTIC_STUDY", ["findings", "impression"], 20),
      ...entry("DIAGNOSTIC_STUDY", ["impression"], 8),
    ];
    const src = renderEmphasisSource(proposeProfile(measureEmphasis(entries)), "derived from 1 plan, 28 entries");
    expect(src).toContain("GENERATED by the learning harness");
    expect(src).toContain("derived from 1 plan, 28 entries");
    expect(src).toContain("DIAGNOSTIC_STUDY");
    expect(src).toContain(`{ fields: ["impression"], prefix: "impression: ", share: 1 },`);
    expect(src).toContain("observed: 28,");
  });

  it("carries the unexpressible clauses into the generated source as a note", () => {
    // A gap in our schema must survive into the artefact a person reviews.
    const entries = entry("CLINICAL_ENCOUNTER", ["subjective", "psychosocial barriers", "plan"], 20);
    const src = renderEmphasisSource(proposeProfile(measureEmphasis(entries)), "test");
    expect(src).toContain("no field of ours expresses");
    expect(src).toContain("psychosocial barriers");
  });

  it("never proposes a field the kind of document cannot express", () => {
    // A deposition has no treating clinician and therefore no assessment; a
    // proposal that asked for one would silently never fire.
    const entries = entry("TESTIMONY", ["testimony", "admission", "assessment"], 20);
    const { profiles } = proposeProfile(measureEmphasis(entries));
    const fields = profiles.TESTIMONY!.clauses.flatMap((c) => c.fields);
    expect(fields).not.toContain("assessment");
    expect(fields).toContain("testimony");
  });
});
