// A hash match is not a shape check.
//
// The report selected a persisted ClinicalReasoningAssessment when its
// materialHash equalled the recorded basisHash, cast it, and dereferenced it.
// The hash proves the row was COMPUTED from that basis; it says nothing about
// the JSON that came back out of the database. alternativesConsidered is a
// nullable Json column, so a stored [null] matches perfectly and throws on
// `[0].rationale`.

import { describe, it, expect } from "vitest";
import { readPersistedAssessment } from "@/lib/engine/persistedAssessment";

const valid = (over: Record<string, unknown> = {}) => ({
  probabilityClassification: "PROBABLE_INCLUDED",
  inclusionRationale: "because the record supports it",
  evidenceStrength: "MODERATE",
  recommendationConfidence: "HIGH",
  residualUncertainty: "some uncertainty remains",
  alternativesConsidered: [{ alternative: "conservative care", rationale: "already failed" }],
  ...over,
});

describe("a well-formed persisted row is accepted", () => {
  it("returns exactly the rendered fields", () => {
    const r = readPersistedAssessment(valid())!;
    expect(r.inclusionRationale).toBe("because the record supports it");
    expect(r.alternativesConsidered).toHaveLength(1);
    expect(Object.keys(r).sort()).toEqual([
      "alternativesConsidered", "evidenceStrength", "inclusionRationale",
      "probabilityClassification", "recommendationConfidence", "residualUncertainty",
    ]);
  });

  it("treats an absent alternatives list as an empty one", () => {
    for (const v of [null, undefined]) {
      expect(readPersistedAssessment(valid({ alternativesConsidered: v }))!.alternativesConsidered).toEqual([]);
    }
  });

  it("accepts an explicitly empty list", () => {
    expect(readPersistedAssessment(valid({ alternativesConsidered: [] }))!.alternativesConsidered).toEqual([]);
  });
});

describe("a malformed persisted row is rejected whole", () => {
  it("rejects the [null] element that used to throw", () => {
    expect(readPersistedAssessment(valid({ alternativesConsidered: [null] }))).toBeNull();
  });

  it.each([
    ["alternatives not an array", { alternativesConsidered: "nope" }],
    ["alternative element missing rationale", { alternativesConsidered: [{ alternative: "x" }] }],
    ["alternative element wrong type", { alternativesConsidered: [{ alternative: 1, rationale: 2 }] }],
    ["inclusionRationale wrong type", { inclusionRationale: 42 }],
    ["inclusionRationale empty", { inclusionRationale: "" }],
    ["residualUncertainty an object", { residualUncertainty: { x: 1 } }],
    ["probabilityClassification out of domain", { probabilityClassification: "MAYBE" }],
    ["evidenceStrength out of domain", { evidenceStrength: "VIBES" }],
    ["recommendationConfidence out of domain", { recommendationConfidence: "PRETTY_SURE" }],
  ])("rejects %s", (_label, over) => {
    expect(readPersistedAssessment(valid(over))).toBeNull();
  });

  it("rejects a non-object row", () => {
    for (const v of [null, undefined, "", 0, [], "row"]) expect(readPersistedAssessment(v)).toBeNull();
  });

  it("rejects the whole row rather than half of it", () => {
    // A half-valid assessment rendered beside a "not recorded" would read as
    // though the record were partially authoritative. It is not.
    expect(readPersistedAssessment(valid({ evidenceStrength: "VIBES" }))).toBeNull();
  });
});

describe("the report consumes the validator, not the raw row", () => {
  it("selects on validation, not merely on the hash", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "export", "report.ts"), "utf8");
    expect(src).toMatch(/const persistedValid = readPersistedAssessment\(persisted\)/);
    expect(src).toMatch(/const usePersisted =\s*\n\s*!!persistedValid/);
    // The old cast is gone.
    expect(src).not.toMatch(/persisted as unknown as Pick<ReasoningAssessment/);
  });

  it("low/high are always derived, never read from unvalidated extras", () => {
    // lowCost/highCost are not in BASIS_SCHEMA, so nothing validated them; a
    // legacy row with lowCost=NaN passed completeness and poisoned the total.
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const src = readFileSync(join(__dirname, "..", "export", "report.ts"), "utf8");
    expect(src).not.toMatch(/const recLow = num\(/);
    expect(src).not.toMatch(/const recHigh = num\(/);
    expect(src).toMatch(/LOW_SCENARIO_MULTIPLIER/);
  });
});
