import { describe, it, expect } from "vitest";
import { recordEvidenceSources } from "@/lib/reference/boundary";
import { locateConditionEvidence } from "@/lib/engine/evidence";
import { EXCLUDED_TYPES } from "@/lib/engine/chronology";

// A unique marker placed ONLY in a finalized reference report must never reach
// a runtime artifact. This is the test that would have caught a generator
// reading every document on the case with no type filter.
const MARKER = "ZZQX-REFERENCE-ONLY-MARKER-7741";

const referenceReport = {
  id: "doc-ref",
  filename: "final-life-care-plan.pdf",
  type: "LIFE_CARE_PLAN",
  extractedText:
    `LIFE CARE PLAN. Future care: lumbar radiofrequency ablation, 2 per year for life. ` +
    `The patient has lumbar radiculopathy with ${MARKER} documented throughout.`,
  pageCount: 40,
};

const realRecord = {
  id: "doc-rec",
  filename: "clinic-note.pdf",
  type: "PAIN_MANAGEMENT",
  extractedText: "Assessment: lumbar radiculopathy. MRI shows L4-5 disc herniation with nerve root contact.",
  pageCount: 2,
};

describe("a finalized reference report cannot become patient evidence", () => {
  it("is withheld from the set the generator mines for condition evidence", () => {
    const mined = recordEvidenceSources([referenceReport, realRecord]);
    expect(mined.map((d) => d.id)).toEqual(["doc-rec"]);
  });

  it("carries text that IS minable — the TYPE is what saves us", () => {
    // Same bytes, typed as an ordinary record: the locator quotes it and the
    // marker becomes "condition evidence". That is what a finalized plan
    // classified as anything other than reference material would have done,
    // and it is what LIFE_CARE_PLAN did before it joined the exclusion set.
    const misfiled = { ...referenceReport, type: "PAIN_MANAGEMENT" };
    const mined = locateConditionEvidence([misfiled] as never, "lumbar radiculopathy");
    expect(mined.length).toBeGreaterThan(0);
    expect(JSON.stringify(mined)).toContain(MARKER);
  });

  it("yields nothing when correctly typed, through the shared exclusion set", () => {
    expect(locateConditionEvidence([referenceReport] as never, "lumbar radiculopathy")).toHaveLength(0);
  });

  it("yields nothing once the boundary is applied", () => {
    const gated = locateConditionEvidence(recordEvidenceSources([referenceReport]) as never, "lumbar radiculopathy");
    expect(gated).toHaveLength(0);
  });

  it("still finds the evidence that lives in a real record", () => {
    const gated = locateConditionEvidence(recordEvidenceSources([referenceReport, realRecord]) as never, "lumbar radiculopathy");
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.every((g) => g.documentId === "doc-rec")).toBe(true);
    expect(JSON.stringify(gated)).not.toContain(MARKER);
  });

  it("is excluded from the chronology", () => {
    // EXPERT_REPORT was already here; LIFE_CARE_PLAN — the answer key itself —
    // was not, so a finalized plan could be chronicled as care delivered.
    expect(EXCLUDED_TYPES.has("LIFE_CARE_PLAN")).toBe(true);
    expect(EXCLUDED_TYPES.has("EXPERT_REPORT")).toBe(true);
    expect(EXCLUDED_TYPES.has("COST_PROJECTION")).toBe(true);
    expect(EXCLUDED_TYPES.has("OPERATIVE_NOTE")).toBe(false);
  });
});
