// The ledger's whole claim is that it detects misses WITHOUT a published plan
// to diff against. These tests hold it to that: every case here supplies only
// source text and claims, never a gold answer.

import { describe, expect, it } from "vitest";
import { discoverSections, ledgerFor, locateSpan, prepareDocumentText, SECTION_CONTRACT, type LedgerClaim } from "@/lib/records/sectionLedger";

const claim = (field: string, value: string, excerpt = value): LedgerClaim => ({ field, value, excerpt });

describe("a section the record documents but we did not capture", () => {
  // The real failure this file exists for: a chiropractic note printed its
  // review of systems as checkbox notation, the planner published it as the
  // visit's exam, and the program captured nothing while reporting success.
  const CHIRO_NOTE = `
Visit: 07/12/2023
Subjective: He also had weakness and pain on the left knee last night.
ROS: Musculoskeletal: (+) limitation of motion, (+) stiff / tight.
Assessment: Internal derangement of the left knee; lumbar facet syndrome.
Plan: The patient was explained the treatment and received the same.
`;

  it("marks the uncaptured exam RECOVERABLE_MISS, not absent", () => {
    const v = ledgerFor("THERAPY_COURSE", [claim("subjective", "Patient reports weakness and pain on the left knee")], CHIRO_NOTE);
    const exam = v.sections.find((s) => s.key === "exam");
    expect(exam?.state).toBe("RECOVERABLE_MISS");
    expect(exam?.headingText?.toLowerCase()).toMatch(/ros|musculoskeletal|review of systems/);
  });

  it("marks the uncaptured assessment RECOVERABLE_MISS", () => {
    // The extraction guidance told the model that a therapy note's repeated
    // diagnosis was boilerplate. The planner publishes it on every entry.
    const v = ledgerFor("THERAPY_COURSE", [claim("subjective", "Patient reports weakness")], CHIRO_NOTE);
    expect(v.sections.find((s) => s.key === "assessment")?.state).toBe("RECOVERABLE_MISS");
  });

  it("counts a captured section PRESENT", () => {
    const v = ledgerFor("THERAPY_COURSE", [claim("objectiveFindings", "Limitation of motion and stiffness were present")], CHIRO_NOTE);
    const exam = v.sections.find((s) => s.key === "exam");
    expect(exam?.state).toBe("PRESENT");
    expect(exam?.satisfiedBy).toContain("objectiveFindings");
  });

  it("reports completeness over documented sections only", () => {
    const v = ledgerFor("THERAPY_COURSE", [claim("subjective", "weakness in the left knee")], CHIRO_NOTE);
    // Subjective captured; exam, assessment and plan are on the page and empty.
    expect(v.completeness).toBeLessThan(0.5);
    expect(v.recoverable.map((s) => s.key).sort()).toEqual(["assessment", "exam", "plan"]);
  });
});

describe("a section the record genuinely does not document", () => {
  it("is ABSENT_FROM_SOURCE, and is not a defect", () => {
    const ED = `Subjective: Left hip and knee pain after a fall.
Exam: Abrasion on the left knee.
Assessment: Contusion of left knee and left hip.
Disposition: Discharged to home.`;
    const v = ledgerFor("CLINICAL_ENCOUNTER", [
      claim("subjective", "Left hip and knee pain after a fall"),
      claim("objectiveFindings", "Abrasion on the left knee"),
      claim("assessment", "Contusion of left knee and left hip"),
      claim("disposition", "Discharged to home"),
    ], ED);
    // An emergency note has no operative findings and no functional status
    // section; the ledger must not manufacture misses out of their absence.
    expect(v.sections.find((s) => s.key === "functional")?.state).toBe("ABSENT_FROM_SOURCE");
    expect(v.recoverable).toHaveLength(0);
    expect(v.completeness).toBe(1);
  });
});

describe("kind-specific contracts", () => {
  it("asks an operative note for the sections a plan publishes for one", () => {
    const keys = SECTION_CONTRACT.OPERATIVE.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["procedure", "preopDx", "postopDx", "medications"]));
  });

  it("does not ask a study for an assessment or a plan", () => {
    const keys = SECTION_CONTRACT.DIAGNOSTIC_STUDY.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["findings", "impression"]));
    expect(keys).not.toContain("plan");
  });

  it("flags an operative note that yielded only its billing", () => {
    // The pivotal record in a real case: a four-level laminectomy for which
    // every captured row was a charge, and the operation itself was never
    // stated on the timeline.
    const OP = `Procedure Performed: L2-L3, L3-L4, L4-L5 and L5-S1 bilateral laminectomy, facetectomy, and foraminotomy.
Preoperative diagnosis: Herniated disc L2-S1.
Postoperative diagnosis: Herniated disc L2-S1.
Medications: 10 mg dexamethasone and 1 gm vancomycin.
Estimated blood loss: 150 mL.`;
    const v = ledgerFor("OPERATIVE", [claim("charge", "Procedure 63047 billed, $11,733.30")], OP);
    expect(v.recoverable.map((s) => s.key).sort()).toEqual(["ebl", "medications", "postopDx", "preopDx", "procedure"]);
    expect(v.completeness).toBe(0);
  });

  it("holds no contract for supporting files or unclassified paper", () => {
    // Measuring these would invent misses out of material that never had a
    // clinical structure to document.
    expect(SECTION_CONTRACT.SUPPORTING_FILE).toHaveLength(0);
    expect(ledgerFor("UNKNOWN", [], "Anything: at all").recoverable).toHaveLength(0);
  });
});

describe("headings the contract has never seen", () => {
  const BURN = `
Subjective: Patient reports pain at the graft site.
Burn Depth Assessment: Deep partial thickness, 12% TBSA.
Graft Viability: Take estimated at 90%.
`;

  it("tracks a discovered heading as a section", () => {
    const found = discoverSections(BURN, SECTION_CONTRACT.CLINICAL_ENCOUNTER);
    expect(found.map((s) => s.label)).toEqual(expect.arrayContaining(["Burn Depth Assessment", "Graft Viability"]));
  });

  it("reports a discovered heading with nothing behind it as a miss", () => {
    const v = ledgerFor("CLINICAL_ENCOUNTER", [claim("subjective", "Patient reports pain at the graft site")], BURN);
    const graft = v.sections.find((s) => s.label === "Graft Viability");
    expect(graft?.state).toBe("RECOVERABLE_MISS");
    expect(graft?.discovered).toBe(true);
  });

  it("does not treat record furniture as a section", () => {
    const found = discoverSections("Patient: McHenry, Derrick\nDOB: 10/19/1976\nMRN: 375067\n", SECTION_CONTRACT.CLINICAL_ENCOUNTER);
    expect(found).toHaveLength(0);
  });

  it("does not re-discover a heading the contract already covers", () => {
    const found = discoverSections("Assessment: lumbar strain\nPlan: therapy\n", SECTION_CONTRACT.CLINICAL_ENCOUNTER);
    expect(found).toHaveLength(0);
  });
});

describe("a section name used mid-sentence is not a heading", () => {
  it("does not read prose as a section", () => {
    const PROSE = "Subjective: The assessment was unchanged and the plan was reviewed with the patient.";
    const v = ledgerFor("CLINICAL_ENCOUNTER", [claim("subjective", "The assessment was unchanged")], PROSE);
    expect(v.sections.find((s) => s.key === "assessment")?.state).toBe("ABSENT_FROM_SOURCE");
    expect(v.sections.find((s) => s.key === "plan")?.state).toBe("ABSENT_FROM_SOURCE");
  });
});

describe("when the entry's own text cannot be located", () => {
  it("claims nothing was missed", () => {
    // With no source in hand the honest verdict is silence, not a miss.
    const v = ledgerFor("CLINICAL_ENCOUNTER", [claim("subjective", "pain")], null);
    expect(v.recoverable).toHaveLength(0);
    expect(v.sections.every((s) => s.state !== "RECOVERABLE_MISS")).toBe(true);
  });
});

describe("locating an entry's span by its own excerpts", () => {
  const DOC = `${"filler ".repeat(400)}
Visit: 07/12/2023
Exam: limitation of motion and stiffness were present today
${"filler ".repeat(400)}`;

  it("finds the span without trusting page numbers", () => {
    // Page attribution was wrong on a real 56-page packet — every row said
    // "page 1" — so the excerpts, which the extractor already verified, are
    // the only trustworthy anchor.
    const span = locateSpan(prepareDocumentText(DOC), ["limitation of motion and stiffness were present"]);
    expect(span).not.toBeNull();
    expect(span!.text).toContain("limitation of motion");
  });

  it("returns null when no excerpt can be located", () => {
    expect(locateSpan(prepareDocumentText(DOC), ["a sentence that is not in this document at all"])).toBeNull();
  });

  it("ignores excerpts too short to locate reliably", () => {
    expect(locateSpan(prepareDocumentText(DOC), ["yes"])).toBeNull();
  });

  it("pads the span so the heading above a quoted line is in view", () => {
    // A claim quotes the finding, not the "Exam:" heading that governs it.
    const span = locateSpan(prepareDocumentText(DOC), ["limitation of motion and stiffness were present"]);
    expect(span!.text).toMatch(/Exam\s*:/i);
  });
});
