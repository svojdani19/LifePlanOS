// The emphasis profile is the one place the program claims to know what a
// life-care planner finds worth writing down. These cases hold it to what the
// published plans actually showed — and hold the honest parts honest: a kind
// the corpus never chronicled must not claim to have been measured.
import { describe, it, expect } from "vitest";
import { PROFILES } from "@/lib/documents/analysisClass";
import { SUMMARY_EMPHASIS, emphasisFor, selectClauses } from "./summaryEmphasis";

describe("the profile only claims what the corpus supports", () => {
  it("marks measured kinds as measured and the rest as hand-shaped", () => {
    const measured = Object.entries(SUMMARY_EMPHASIS)
      .filter(([, p]) => p.basis === "published-corpus")
      .map(([k]) => k)
      .sort();
    // The five published plans chronicle care. They contain no billing entry,
    // no deposition and no pathology report, so exactly these four kinds — and
    // no others — may claim a corpus basis.
    expect(measured).toEqual(["CLINICAL_ENCOUNTER", "DIAGNOSTIC_STUDY", "OPERATIVE", "THERAPY_COURSE"]);
  });

  it("records an observed entry count for every measured kind, and none for the rest", () => {
    for (const [kind, profile] of Object.entries(SUMMARY_EMPHASIS)) {
      if (profile.basis === "published-corpus") {
        expect(profile.observed, `${kind} was measured`).toBeGreaterThan(0);
        expect(profile.clauses.some((c) => c.share > 0), `${kind} carries a measured share`).toBe(true);
      } else {
        expect(profile.observed, `${kind} was not measured`).toBe(0);
        expect(profile.clauses.every((c) => c.share === 0), `${kind} claims no share`).toBe(true);
      }
    }
  });

  it("asks each kind only for fields that kind of document can express", () => {
    // A profile that reaches for a field outside its class vocabulary would
    // silently never fire — the clause would look supported and never appear.
    for (const [kind, profile] of Object.entries(SUMMARY_EMPHASIS)) {
      const allowed = new Set<string>(PROFILES[kind as keyof typeof PROFILES].fields);
      for (const clause of profile.clauses) {
        for (const field of clause.fields) {
          expect(allowed.has(field), `${kind} asks for ${field}`).toBe(true);
        }
      }
    }
  });
});

describe("what the published plans settled", () => {
  it("opens an encounter with the presenting complaint", () => {
    const [lead] = SUMMARY_EMPHASIS.CLINICAL_ENCOUNTER!.clauses;
    expect(lead.fields).toContain("subjective");
    // 91% of published encounter entries carried it, always first.
    expect(lead.share).toBeGreaterThan(0.9);
  });

  it("keeps the assessment and the plan ahead of the exam under the cap", () => {
    const by = (f: string) => SUMMARY_EMPHASIS.CLINICAL_ENCOUNTER!.clauses.find((c) => c.fields.includes(f as never))!;
    expect(by("assessment").share).toBeGreaterThan(by("objectiveFindings").share);
    expect(by("recommendations").share).toBeGreaterThan(by("objectiveFindings").share);
  });

  it("leads a study with its impression, though the planner writes findings first", () => {
    // The full entries read findings → impression; the entries compressed to a
    // single clause kept the impression 75% of the time and the findings never.
    // A summary is the compressed form, so the impression leads.
    const [lead, second] = SUMMARY_EMPHASIS.DIAGNOSTIC_STUDY!.clauses;
    expect(lead.fields).toEqual(["impression"]);
    expect(second.fields).toEqual(["diagnosticStudies"]);
  });

  it("gives an operation a slot for the agent administered, but only where a field means it", () => {
    // 44% of published procedure entries named the agent given during the
    // procedure, and the hand shape had no slot for it at all. Only
    // `anesthesia` carries that meaning: `medications` is the patient's
    // medication list, and admitting it here put a home statin where the
    // operation belonged on real records.
    const agent = SUMMARY_EMPHASIS.OPERATIVE!.clauses.find((c) => c.fields.includes("anesthesia"));
    expect(agent).toBeDefined();
    expect(agent!.share).toBeGreaterThan(0);
    expect(SUMMARY_EMPHASIS.OPERATIVE!.clauses.some((c) => c.fields.includes("medications"))).toBe(false);
  });

  it("marks a weight reasoned across from another kind as carried, never as measured", () => {
    // A procedure documented inside a visit: the planner gives procedures their
    // own entries, so no encounter entry measures one.
    const procedure = SUMMARY_EMPHASIS.CLINICAL_ENCOUNTER!.clauses.find((c) => c.fields.includes("procedure"))!;
    expect(procedure.share).toBeGreaterThan(0);
    expect(procedure.carried).toBe(true);
    // Everything else in a measured profile is an actual measurement.
    const measured = SUMMARY_EMPHASIS.CLINICAL_ENCOUNTER!.clauses.filter((c) => c.share > 0 && !c.carried);
    expect(measured.length).toBeGreaterThan(2);
  });
});

describe("selection under a cap", () => {
  const clause = (share: number, id: string) => ({ share, id });

  it("keeps the most-said clauses, not the first ones", () => {
    const kept = selectClauses([clause(0.2, "a"), clause(0.9, "b"), clause(0.8, "c")], 2);
    expect(kept.map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("returns them in reading order, not in rank order", () => {
    const kept = selectClauses([clause(0.5, "first"), clause(0.4, "second"), clause(0.9, "third")], 2);
    expect(kept.map((c) => c.id)).toEqual(["first", "third"]);
  });

  it("holds the written order when nothing was measured", () => {
    // An unmeasured hand-shaped profile is all zeroes; it must keep exactly the
    // sequence it was written in rather than being reordered by a tie-break.
    const kept = selectClauses([clause(0, "a"), clause(0, "b"), clause(0, "c")], 2);
    expect(kept.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("passes everything through when the cap is not reached", () => {
    const all = [clause(0.1, "a"), clause(0.2, "b")];
    expect(selectClauses(all, 3)).toEqual(all);
  });
});

describe("lookup", () => {
  it("defaults an unstated kind to the clinical encounter", () => {
    expect(emphasisFor(null)).toBe(SUMMARY_EMPHASIS.CLINICAL_ENCOUNTER);
  });

  it("returns null for a kind with no shape, so the caller falls back", () => {
    expect(emphasisFor("UNKNOWN")).toBeNull();
    expect(emphasisFor("SUPPORTING_FILE")).toBeNull();
  });
});
