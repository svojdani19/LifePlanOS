// Identity is what both merge paths got wrong: the production chronology keyed
// encounters by calendar date, and the record merger by document plus date. A
// combined records production carries, on one day, a therapy session, an
// imaging study, an emergency visit, a follow-up, a procedure and the billing
// for all of them. These tests hold the line that a date is not an identity.
//
// Synthetic records only — no PHI.

import { describe, expect, it } from "vitest";
import {
  compareClass,
  compareFacility,
  compareProvider,
  compareSpans,
  compareTime,
  decideIdentity,
  distinctiveOverlap,
  identifiersOf,
  isDistinctive,
  timeFromText,
  type IdentityFacts,
} from "@/lib/records/encounterIdentity";

const facts = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  id: "f1",
  sourceDocumentId: "doc1",
  klass: "CLINICAL_ENCOUNTER",
  dateIso: "2024-03-15",
  dateDocumented: true,
  provider: null,
  facility: null,
  time: null,
  segmentKey: null,
  span: null,
  claims: [],
  ...over,
});

const claim = (field: string, value: string) => ({ field, value });

describe("a date never authorizes a merge on its own", () => {
  it("leaves two same-date fragments separate when nothing else ties them", () => {
    const d = decideIdentity(facts({ id: "a" }), facts({ id: "b" }));
    expect(d.verdict).toBe("POSSIBLE_DUPLICATE");
    expect(d.reasons).toContain("INSUFFICIENT_EVIDENCE");
  });

  it("records the shared date as support, not as a reason", () => {
    const d = decideIdentity(facts({ id: "a" }), facts({ id: "b" }));
    expect(d.supporting.map((s) => s.code)).toContain("DATE_SAME_DOCUMENTED");
    expect(d.reasons).not.toContain("DATE_SAME_DOCUMENTED");
  });

  it("weights an inferred date below a documented one", () => {
    const d = decideIdentity(facts({ dateDocumented: false }), facts({ dateDocumented: false }));
    expect(d.supporting.map((s) => s.code)).toContain("DATE_SAME_INFERRED");
    expect(d.verdict).toBe("POSSIBLE_DUPLICATE");
  });

  it("does not merge two undated rows merely because both are undated", () => {
    const d = decideIdentity(facts({ dateIso: null }), facts({ dateIso: null }));
    expect(d.verdict).not.toBe("MERGE");
  });

  it("keeps different dates apart", () => {
    const d = decideIdentity(facts({ dateIso: "2024-03-15" }), facts({ dateIso: "2024-03-16" }));
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("DATE_DIFFERENT");
  });
});

describe("hard conflicts keep records apart", () => {
  it("two different providers on the same date in the same document", () => {
    const d = decideIdentity(
      facts({ provider: "Michael Crone, DC" }),
      facts({ provider: "Fernando Techy, M.D." }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("PROVIDER_DIFFERENT");
  });

  it("a therapy visit and an orthopedic visit on the same date", () => {
    const d = decideIdentity(facts({ klass: "THERAPY_COURSE" }), facts({ klass: "CLINICAL_ENCOUNTER" }));
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("CLASS_INCOMPATIBLE");
  });

  it("imaging and a clinic visit on the same date", () => {
    const d = decideIdentity(facts({ klass: "DIAGNOSTIC_STUDY" }), facts({ klass: "CLINICAL_ENCOUNTER" }));
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("CLASS_INCOMPATIBLE");
  });

  it("the same provider on the same date at different documented times", () => {
    const d = decideIdentity(
      facts({ provider: "Michael Crone, DC", time: "09:30" }),
      facts({ provider: "Michael Crone, DC", time: "14:15" }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("TIME_DIFFERENT");
  });

  it("the same provider with no time, when the spans identify separate notes", () => {
    const d = decideIdentity(
      facts({ provider: "Michael Crone, DC", span: { start: 100, end: 900 } }),
      facts({ provider: "Michael Crone, DC", span: { start: 4_000, end: 4_800 } }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("SPANS_DISJOINT");
  });

  it("different facilities", () => {
    const d = decideIdentity(
      facts({ facility: "Houston Spine and Rehabilitation Centers" }),
      facts({ facility: "One Step Diagnostic" }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("FACILITY_DIFFERENT");
  });

  it("conflicting record identifiers", () => {
    const d = decideIdentity(
      facts({ claims: [claim("diagnosticStudies", "Accession number AC-99120 for the lumbar series")] }),
      facts({ claims: [claim("diagnosticStudies", "Accession number AC-77431 for the cervical series")] }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("IDENTIFIER_CONFLICT");
  });

  it("different documented segments", () => {
    const d = decideIdentity(facts({ segmentKey: "note-3" }), facts({ segmentKey: "note-7" }));
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("SEGMENT_DIFFERENT");
  });

  it("a conflict outranks strong similarity", () => {
    // Two notes from different clinicians that share a template are still two
    // notes, however much text they have in common.
    const shared = [
      claim("objectiveFindings", "Lumbar flexion limited to thirty degrees with pain reported at ten degrees"),
      claim("treatment", "Mechanical traction applied to the lumbar spine at sixty two pounds"),
    ];
    const d = decideIdentity(
      facts({ provider: "Michael Crone, DC", claims: shared }),
      facts({ provider: "Brett Baer, DPT", claims: shared }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
  });
});

describe("missing information is unknown, not a match", () => {
  it("two absent providers do not agree", () => {
    expect(compareProvider(null, null)).toBe("UNKNOWN");
    expect(compareProvider("Michael Crone, DC", null)).toBe("UNKNOWN");
  });

  it("a missing provider alone does not merge", () => {
    const d = decideIdentity(facts({ provider: null }), facts({ provider: null }));
    expect(d.verdict).not.toBe("MERGE");
  });

  it("two absent times do not agree", () => {
    expect(compareTime(null, null)).toBe("UNKNOWN");
  });

  it("an unlocatable span is unknown rather than a match", () => {
    expect(compareSpans(null, { start: 0, end: 10 })).toBe("UNKNOWN");
    const d = decideIdentity(facts({ span: null }), facts({ span: null }));
    expect(d.verdict).not.toBe("MERGE");
  });

  it("recognises an abbreviated name as the same clinician", () => {
    expect(compareProvider("BRITTANY R IRWIN, PA-C", "R Irwin, PA-C")).toBe("SAME");
    expect(compareProvider("Michael Crone, DC", "Fernando Techy, M.D.")).toBe("DIFFERENT");
  });
});

describe("evidence that does justify a merge", () => {
  it("overlapping source spans in one document", () => {
    const d = decideIdentity(
      facts({ span: { start: 100, end: 900 } }),
      facts({ span: { start: 500, end: 1_400 } }),
    );
    expect(d.verdict).toBe("MERGE");
    expect(d.reasons).toContain("SPANS_OVERLAP");
  });

  it("the same identified note", () => {
    const d = decideIdentity(facts({ segmentKey: "note-3" }), facts({ segmentKey: "note-3" }));
    expect(d.verdict).toBe("MERGE");
    expect(d.reasons).toContain("SEGMENT_SAME");
  });

  it("a matching record identifier, even across documents", () => {
    const d = decideIdentity(
      facts({ sourceDocumentId: "doc1", claims: [claim("diagnosticStudies", "Accession number AC-99120 for the lumbar series")] }),
      facts({ sourceDocumentId: "doc2", claims: [claim("diagnosticStudies", "Report for accession number AC-99120, lumbar spine")] }),
    );
    expect(d.verdict).toBe("MERGE");
    expect(d.reasons).toContain("IDENTIFIER_MATCH");
  });

  it("a missing provider plus overlapping spans and distinctive overlap", () => {
    const distinctive = [
      claim("treatment", "Mechanical traction applied to the lumbar spine at sixty two pounds"),
      claim("objectiveFindings", "Lumbar flexion limited to thirty degrees with pain at ten degrees"),
    ];
    const d = decideIdentity(
      facts({ provider: null, span: { start: 100, end: 900 }, claims: distinctive }),
      facts({ provider: null, span: { start: 400, end: 1_200 }, claims: distinctive }),
    );
    expect(d.verdict).toBe("MERGE");
  });

  it("distinctive clinical overlap on a shared date within one document", () => {
    const distinctive = [
      claim("treatment", "Mechanical traction applied to the lumbar spine at sixty two pounds"),
      claim("subjective", "Increased numbness and tingling of the third fourth and fifth digits"),
      claim("objectiveFindings", "Lumbar flexion limited to thirty degrees with pain at ten degrees"),
    ];
    const d = decideIdentity(facts({ claims: distinctive }), facts({ claims: distinctive }));
    expect(d.verdict).toBe("MERGE");
    expect(d.reasons).toContain("DISTINCTIVE_OVERLAP");
  });
});

describe("boilerplate is not duplicate evidence", () => {
  it("excludes reconciliation lists, allergies, history and instructions", () => {
    expect(isDistinctive(claim("subjective", "No known drug allergies"))).toBe(false);
    expect(isDistinctive(claim("medications", "Metformin 500 mg tablet twice daily"))).toBe(false);
    expect(isDistinctive(claim("pastMedicalHistory", "Diabetes mellitus and hypertension"))).toBe(false);
    expect(isDistinctive(claim("subjective", "Review of systems otherwise negative"))).toBe(false);
    expect(isDistinctive(claim("recommendations", "Return to the emergency department if symptoms worsen"))).toBe(false);
    expect(isDistinctive(claim("procedure", "Established patient office visit, level 3"))).toBe(false);
  });

  it("keeps measured findings and specific treatment parameters", () => {
    expect(isDistinctive(claim("treatment", "Mechanical traction at sixty two pounds for fifteen minutes"))).toBe(true);
    expect(isDistinctive(claim("objectiveFindings", "Lumbar flexion limited to thirty degrees"))).toBe(true);
  });

  it("does not merge two encounters that share only boilerplate", () => {
    const boiler = [
      claim("subjective", "No known drug allergies"),
      claim("pastMedicalHistory", "Diabetes mellitus and hypertension"),
      claim("recommendations", "Return to the emergency department if symptoms worsen"),
    ];
    expect(distinctiveOverlap(facts({ claims: boiler }), facts({ claims: boiler })).ratio).toBe(0);
    expect(decideIdentity(facts({ claims: boiler }), facts({ claims: boiler })).verdict).toBe("POSSIBLE_DUPLICATE");
  });
});

describe("billing and the encounter it bills for", () => {
  it("merges only when distinctive service detail connects them", () => {
    const connected = decideIdentity(
      facts({ klass: "OPERATIVE", claims: [claim("procedure", "CPT 63047 laminectomy performed at L4-L5")] }),
      facts({ klass: "FINANCIAL", claims: [claim("charge", "CPT 63047 billed, laminectomy performed at L4-L5")] }),
    );
    expect(connected.verdict).toBe("MERGE");
    expect(connected.supporting.map((s) => s.code)).toContain("PROCEDURE_MATCH");
  });

  it("does not merge a bill carrying only a generic description", () => {
    const d = decideIdentity(
      facts({ klass: "CLINICAL_ENCOUNTER", claims: [claim("assessment", "Lumbar radiculopathy with left leg pain")] }),
      facts({ klass: "FINANCIAL", claims: [claim("charge", "Established patient office visit, level 3")] }),
    );
    expect(d.verdict).not.toBe("MERGE");
  });

  it("keeps conflicting procedures apart", () => {
    const d = decideIdentity(
      facts({ claims: [claim("procedure", "CPT 63047 performed")] }),
      facts({ claims: [claim("procedure", "CPT 27447 performed")] }),
    );
    expect(d.verdict).toBe("KEEP_SEPARATE");
    expect(d.reasons).toContain("PROCEDURE_CONFLICT");
  });
});

describe("the decision is deterministic and auditable", () => {
  const a = facts({ id: "a", provider: "Michael Crone, DC", span: { start: 100, end: 900 } });
  const b = facts({ id: "b", provider: "Michael Crone, DC", span: { start: 500, end: 1_400 } });

  it("gives the same verdict whichever way round the pair is compared", () => {
    expect(decideIdentity(a, b).verdict).toBe(decideIdentity(b, a).verdict);
    expect(decideIdentity(a, b).reasons.sort()).toEqual(decideIdentity(b, a).reasons.sort());
  });

  it("repeats itself exactly", () => {
    expect(decideIdentity(a, b)).toEqual(decideIdentity(a, b));
  });

  it("reports machine-readable reasons and both kinds of signal", () => {
    const d = decideIdentity(facts({ provider: "A Smith, MD" }), facts({ provider: "B Jones, MD" }));
    expect(d.reasons.every((r) => /^[A-Z_]+$/.test(r))).toBe(true);
    expect(d.conflicting.length).toBeGreaterThan(0);
    expect(d.conflicting[0]).toHaveProperty("code");
  });
});

describe("reading identity facts out of text", () => {
  it("reads a documented clock time", () => {
    expect(timeFromText("Time: 09:30")).toBe("09:30");
    expect(timeFromText("seen at 2:15 pm in the clinic")).toBe("14:15");
    expect(timeFromText("no time recorded here")).toBeNull();
  });

  it("reads record identifiers", () => {
    const ids = identifiersOf(facts({ claims: [claim("diagnosticStudies", "Accession number AC-99120 reported")] }));
    expect([...ids]).toContain("AC-99120");
  });

  it("treats an anaesthesia record as compatible with its operation", () => {
    expect(compareClass("ANESTHESIA", "OPERATIVE")).toBe("SAME");
  });

  it("treats a bill as compatible with anything, without that proving identity", () => {
    expect(compareClass("FINANCIAL", "OPERATIVE")).toBe("UNKNOWN");
  });

  it("matches facilities through corporate noise", () => {
    expect(compareFacility("Houston Spine and Rehabilitation Centers", "The Houston Spine & Rehab Center, LLC")).toBe("SAME");
  });
});
