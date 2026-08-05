// Exemplar-derived chronology emphasis rules — pure-module tests. The profile
// was learned from a professionally published corpus reference plan; these pin
// the generalizable behaviors (no case content).
import { describe, it, expect } from "vitest";
import {
  expansionVerdict,
  compressedSummary,
  imagingImpression,
  hasImagingSpecifics,
  responseMilestone,
  statusPostAnchor,
  careGapNote,
  diagnosisKey,
} from "./chronologyEmphasis";
import type { EncounterData } from "./chronology";

const enc = (over: Partial<EncounterData> = {}): EncounterData => ({
  subjective: null, pastMedicalHistory: null, objectiveFindings: null, diagnosis: null,
  treatment: null, procedure: null, disposition: null, imagingFindings: null,
  medications: null, functionalStatus: null, workStatus: null, restrictions: null,
  impairmentRating: null, ...over,
});

describe("expansionVerdict — the exemplar's milestone test", () => {
  it("a routine interval visit with nothing new is NOT expanded", () => {
    const v = expansionVerdict(
      enc({ subjective: "Patient reports continued neck stiffness.", diagnosis: "Cervical strain", treatment: "Continue therapy as tolerated." }),
      "Patient reports continued neck stiffness. Continue therapy as tolerated.",
      { eventType: "THERAPY" },
    );
    expect(v.expanded).toBe(false);
    expect(v.signals).toEqual([]);
  });

  it("imaging review, escalation, response milestones, and medico-legal content each expand", () => {
    expect(expansionVerdict(enc({ imagingFindings: "L4-L5 disc protrusion" }), "", { eventType: "CLINIC_VISIT" }).signals).toContain("imaging");
    expect(
      expansionVerdict(enc({ treatment: "Recommended lumbar epidural steroid injection." }), "", { eventType: "CLINIC_VISIT" }).signals,
    ).toContain("escalation");
    expect(
      expansionVerdict(enc({ subjective: "He reports 80% relief following the injection." }), "", { eventType: "CLINIC_VISIT" }).signals,
    ).toContain("response");
    expect(expansionVerdict(enc({ workStatus: "Off work until next visit." }), "", { eventType: "CLINIC_VISIT" }).signals).toContain("medicolegal");
    expect(expansionVerdict(enc(), "The collision exacerbated his pre-existing symptoms.", { eventType: "CLINIC_VISIT" }).signals).toContain("medicolegal");
  });

  it("ER visits, procedures, and first visits always expand", () => {
    expect(expansionVerdict(enc(), "", { eventType: "ER_VISIT" }).expanded).toBe(true);
    expect(expansionVerdict(enc({ procedure: "Bilateral L4-L5 facet injection" }), "", { eventType: "CLINIC_VISIT" }).expanded).toBe(true);
    expect(expansionVerdict(enc(), "", { eventType: "CLINIC_VISIT", firstVisitWithProvider: true }).signals).toContain("first-visit");
  });
});

describe("compressedSummary — the stereotyped interval line", () => {
  it("carries response, unchanged assessment, and continued treatment", () => {
    const s = compressedSummary(
      enc({ subjective: "Feels improved since the last visit.", diagnosis: "Lumbar radiculopathy.", treatment: "Therapeutic exercise continued." }),
      "Chiropractic Record",
    );
    expect(s).toMatch(/^Interval chiropractic visit/i);
    expect(s).toContain("assessment unchanged: lumbar radiculopathy");
    expect(s).toContain("treatment continued");
  });
});

describe("imagingImpression — near-verbatim, never truncating mid-level", () => {
  it("keeps short impressions verbatim", () => {
    const t = "L4-L5: 5.2 mm posterior central disc protrusion contacting the descending L5 nerve roots.";
    expect(imagingImpression(t)).toBe(t);
  });

  it("cuts long impressions only at clause boundaries", () => {
    const long = Array.from({ length: 12 }, (_, i) => `T${i + 1}-T${i + 2}: no evidence of disc disease at this level`).join("; ") + ".";
    const out = imagingImpression(long, 200);
    expect(out.length).toBeLessThan(215);
    expect(out.endsWith("…")).toBe(true);
    // Never ends mid disc-level token.
    expect(/T\d{1,2}\s*[-–]$/.test(out.replace(/\s*…$/, ""))).toBe(false);
  });

  it("recognizes the details that must never be dropped", () => {
    expect(hasImagingSpecifics("5 mm AP canal stenosis at C5-C6 with cord contact")).toBe(true);
    expect(hasImagingSpecifics("unremarkable study")).toBe(false);
  });
});

describe("longitudinal devices", () => {
  it("responseMilestone extracts the quantified response clause", () => {
    expect(responseMilestone("Since the injection he reports 80% relief of low back pain. Sleep improved.")).toMatch(/80% relief/);
    expect(responseMilestone("He received no relief from the lumbar injection.")).toMatch(/no relief/);
    expect(responseMilestone("Routine follow-up today.")).toBeNull();
  });

  it("statusPostAnchor renders weeks then months within the anchoring window", () => {
    const surgery = { date: new Date("2026-01-01T00:00:00Z"), label: "L4-L5 decompression" };
    expect(statusPostAnchor(new Date("2026-01-15T00:00:00Z"), surgery)).toBe("2 weeks status post l4-L5 decompression");
    expect(statusPostAnchor(new Date("2026-07-01T00:00:00Z"), surgery)).toMatch(/6 months status post/);
    expect(statusPostAnchor(new Date("2027-06-01T00:00:00Z"), surgery)).toBeNull(); // beyond window
    expect(statusPostAnchor(new Date("2026-01-02T00:00:00Z"), surgery)).toBeNull(); // same admission
  });

  it("careGapNote fires only across a real gap and states months", () => {
    expect(careGapNote(new Date("2026-01-01"), new Date("2026-02-15"))).toBeNull();
    expect(careGapNote(new Date("2026-01-01"), new Date("2026-06-01"))).toMatch(/approximately 5 months/);
  });

  it("diagnosisKey normalizes so a reworded identical assessment is not 'new'", () => {
    expect(diagnosisKey("Lumbar radiculopathy; cervical strain")).toBe(diagnosisKey("Cervical strain and lumbar radiculopathy"));
    expect(diagnosisKey("Lumbar radiculopathy")).not.toBe(diagnosisKey("Lumbar radiculopathy with new foot drop"));
    expect(diagnosisKey(null)).toBeNull();
  });
});
