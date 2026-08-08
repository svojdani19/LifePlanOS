// The parser is the only route the corpus takes into what the program believes,
// so its failures are silent and expensive: a clause it misses is a clause the
// program never learns to write. Fixtures are synthetic, in the layout the
// published plans use.
import { describe, it, expect } from "vitest";
import { parsePublishedPlan, normalizeLabel, entryKind } from "./publishedPlan";

const ENCOUNTER_PLAN = `
Life Care Plan - Sample Patient (DOB: 01/01/1970)

Page 4
03/14/2025 - Alex Rivera, M.D./Sample Orthopedics
Subjective: The patient presented with low back pain after a fall.
Exam: Examination revealed tenderness at the lumbar paraspinals.
Assessment: Lumbar strain.
Plan: Physical therapy twice weekly for six weeks. (Pdf 3: p. 1-2)


03/28/2025 - Alex Rivera, M.D./Sample Orthopedics
Subjective: The patient reported no improvement.
Assessment: Lumbar radiculopathy.
Plan: MRI ordered. (Pdf 3: p. 3)
`;

const STUDY_PLAN = `
04/02/2025 Jordan Blake, M.D./Sample Radiology
MRI Report of the Lumbar Spine
Findings:
• L4-L5: Disc extrusion with caudal migration.
• Soft tissues: Unremarkable.
Impressions:
• L4-L5 disc extrusion with lateral recess stenosis. (Pdf 9: p. 1)
`;

describe("reading a published plan", () => {
  it("splits the chronology into dated entries and drops page furniture", () => {
    const entries = parsePublishedPlan(ENCOUNTER_PLAN);
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe("03/14/2025");
    expect(entries[0].isoDate).toBe("2025-03-14");
    expect(entries[0].heading).toContain("Alex Rivera");
    expect(entries[0].heading).not.toContain("Page 4");
    expect(entries[0].heading).not.toContain("DOB");
  });

  it("reads the planner's clauses in the order they were written", () => {
    const [first] = parsePublishedPlan(ENCOUNTER_PLAN);
    expect(first.clauses.map((c) => c.label)).toEqual(["subjective", "exam", "assessment", "plan"]);
    expect(first.clauses[2].text).toBe("Lumbar strain.");
  });

  it("folds radiology sub-headings into the findings clause they belong to", () => {
    // "Soft tissues:" subdivides the findings block. Counted as its own clause
    // it would look like a clause type the planner uses, and crowd out one that
    // actually is.
    const [study] = parsePublishedPlan(STUDY_PLAN);
    expect(study.clauses.map((c) => c.label)).toEqual(["findings", "impression"]);
    expect(study.clauses[0].text).toContain("L4-L5");
    expect(study.clauses[0].text).toContain("Unremarkable");
  });

  it("recognizes a study by its own title line", () => {
    expect(parsePublishedPlan(STUDY_PLAN)[0].kind).toBe("DIAGNOSTIC_STUDY");
    expect(parsePublishedPlan(ENCOUNTER_PLAN)[0].kind).toBe("CLINICAL_ENCOUNTER");
  });

  it("does not mistake a cost table row for an encounter", () => {
    // The cost schedule and the medication table also open with a date.
    const entries = parsePublishedPlan(`
03/14/2025 - Alex Rivera, M.D./Sample Orthopedics
Assessment: Lumbar strain. (Pdf 3: p. 1)
05/01/2025 Lumbar MRI $2,400.00 annually
`);
    expect(entries).toHaveLength(1);
  });

  it("reports an unparseable date rather than inventing one", () => {
    const [e] = parsePublishedPlan(`13/45/2025 - Someone, M.D./Somewhere\nAssessment: Something.`);
    expect(e.date).toBe("13/45/2025");
    expect(e.isoDate).toBeNull();
  });
});

describe("label normalization", () => {
  it("collapses the plural and spacing variants the plans use", () => {
    expect(normalizeLabel("Impressions")).toBe("impression");
    expect(normalizeLabel("Diagnostic  Studies")).toBe("diagnostic studies");
    expect(normalizeLabel("Medications used")).toBe("medication used");
  });
});

describe("entry kind", () => {
  it("falls back to the clause vocabulary when the heading is bare", () => {
    expect(entryKind("Some Provider/Some Clinic", ["procedure performed"])).toBe("OPERATIVE");
    expect(entryKind("Some Provider/Some Clinic", ["findings", "impression"])).toBe("DIAGNOSTIC_STUDY");
    expect(entryKind("Some Provider/Some Clinic", ["subjective", "plan"])).toBe("CLINICAL_ENCOUNTER");
  });
});
