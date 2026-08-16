// The canonical note is the review unit — and consolidation must never hide a
// problem. Synthetic data only.
import { describe, expect, it } from "vitest";
import { aggregateCorroboration, fragmentDisagreement, projectNotes, type NoteFinding } from "@/lib/records/noteProjection";
import type { StructuredEncounter } from "@/lib/records/structuredRecord";

const enc = (id: string, over: Partial<StructuredEncounter> = {}): StructuredEncounter =>
  ({
    id,
    sourceDocumentId: "doc-1",
    dateStatus: "DOCUMENTED",
    encounterDate: "2025-03-14",
    encounterDateEnd: null,
    provider: "A. Rivera, MD",
    providerCredentials: "MD",
    facility: "Northgate Clinic",
    encounterType: "Clinic visit",
    factualSummary: `Clinic visit ${id}.`,
    synthesis: null,
    claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: …", page: 1, confidence: null }],
    page: 1,
    pageEnd: 1,
    ocrConfidence: 0.98,
    warnings: [],
    status: "AI_AUDIT_PASSED",
    substanceClass: "CLINICAL",
    substanceReason: null,
    analysisClass: "CLINICAL_ENCOUNTER",
    attributionName: null,
    attributionRole: null,
    reviewedAt: null,
    verifiedAt: null,
    staleReason: null,
    auditResult: "PASS",
    contentHash: `${id}`.padEnd(64, "0"),
    ...over,
  }) as StructuredEncounter;

const finding = (over: Partial<NoteFinding> = {}): NoteFinding => ({
  id: "f1",
  scope: "ENTRY",
  type: "CONTRADICTED_DATE",
  severity: "BLOCKING",
  blocking: true,
  source: "ADJUDICATOR",
  detail: "The source contradicts the extracted date.",
  status: "OPEN",
  ...over,
});

describe("one canonical note, one decision", () => {
  it("consolidates the rows a segment names into one reviewable note", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a", "b", "c"] }], [enc("a"), enc("b"), enc("c")], []);
    expect(notes).toHaveLength(1);
    expect(notes[0].rowIds).toEqual(["a", "b", "c"]);
    expect(notes[0].claimCount).toBe(3);
    expect(notes[0].contentHashes).toHaveLength(3);
  });

  it("keeps every underlying row and citation inspectable", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], [enc("a"), enc("b")], []);
    expect(notes[0].rows).toHaveLength(2);
    expect(notes[0].claims).toHaveLength(2);
  });

  it("gives an unsegmented row its own note so nothing becomes unreviewable", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a"), enc("orphan")], []);
    expect(notes).toHaveLength(2);
  });

  it("shows the WORST status and audit result of its rows", () => {
    const notes = projectNotes(
      "doc-1",
      [{ rowIds: ["a", "b"] }],
      [enc("a", { status: "VERIFIED", auditResult: "PASS" }), enc("b", { status: "AI_DRAFT", auditResult: "SOURCE_CONFLICT" })],
      [],
    );
    expect(notes[0].status).toBe("AI_DRAFT");
    expect(notes[0].auditResult).toBe("SOURCE_CONFLICT");
  });

  it("cannot present a note as clean when one row carries a blocking finding", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], [enc("a"), enc("b")], [finding({ encounterId: "b" })]);
    expect(notes[0].needsAttention).toBe(true);
    expect(notes[0].awaitingAttestation).toBe(false);
    expect(notes[0].findings).toHaveLength(1);
  });

  it("does not show a neighbouring note's finding", () => {
    const notes = projectNotes(
      "doc-1",
      [{ rowIds: ["a"] }, { rowIds: ["b"] }],
      [enc("a"), enc("b")],
      [finding({ encounterId: "b" })],
    );
    expect(notes[0].findings).toHaveLength(0);
    expect(notes[1].findings).toHaveLength(1);
  });

  it("treats a clean audit-passed note as awaiting attestation, never as verified", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a")], []);
    expect(notes[0].awaitingAttestation).toBe(true);
    expect(notes[0].status).not.toBe("VERIFIED");
  });

  it("puts an undated clinical note in attention", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a", { dateStatus: "UNKNOWN", encounterDate: null })], []);
    expect(notes[0].needsAttention).toBe(true);
  });

  it("a resolved finding no longer holds the note", () => {
    const notes = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a")], [finding({ encounterId: "a", status: "RESOLVED" })]);
    expect(notes[0].needsAttention).toBe(false);
  });
});

describe("the flag and the explanation cannot disagree", () => {
  it("never flags a record whose guidance says it is clean", () => {
    const rows = [enc("a"), enc("b", { dateStatus: "UNKNOWN", encounterDate: null })];
    const notes = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    // One undated fragment makes the whole record undated — and says so.
    expect(notes[0].needsAttention).toBe(true);
    expect(notes[0].guidance.kind).toBe("UNDATED");
  });

  it("gives every note a reason and at least one next step", () => {
    const notes = projectNotes(
      "doc-1",
      [{ rowIds: ["a"] }, { rowIds: ["b"] }],
      [enc("a"), enc("b", { auditResult: "SOURCE_CONFLICT", status: "AI_DRAFT" })],
      [],
    );
    for (const n of notes) {
      expect(n.guidance.why.length).toBeGreaterThan(30);
      expect(n.guidance.steps.length).toBeGreaterThan(0);
    }
  });

  it("marks a clean note as attestable and an exception as not, consistently", () => {
    const clean = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a")], [])[0];
    expect(clean.needsAttention).toBe(false);
    expect(clean.awaitingAttestation).toBe(true);
    expect(clean.guidance.canAttest).toBe(true);

    const failed = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a", { auditResult: "FAILED" })], [])[0];
    expect(failed.needsAttention).toBe(true);
    expect(failed.guidance.canAttest).toBe(false);
  });
});

describe("a note is only as corroborated as its weakest fragment", () => {
  const corrob = (result: "CORROBORATED" | "NOT_CORROBORATED", reproduced: number, total: number, unreproducedFields: string[] = []) =>
    ({ result, reproduced, total, unreproducedFields }) as NonNullable<StructuredEncounter["corroboration"]>;

  it("refuses the whole note when any fragment was not reproduced", () => {
    // The failure this replaces: the first fragment's verdict was taken for
    // the note, so a corroborated opening could carry a refused remainder.
    const rows = [enc("a", { corroboration: corrob("CORROBORATED", 4, 4) }), enc("b", { corroboration: corrob("NOT_CORROBORATED", 1, 3, ["laterality"]) })];
    expect(aggregateCorroboration(rows)!.result).toBe("NOT_CORROBORATED");
  });

  it("does not call a note corroborated when a fragment was never re-read", () => {
    // Absence of a verdict is not agreement.
    const rows = [enc("a", { corroboration: corrob("CORROBORATED", 4, 4) }), enc("b")];
    expect(aggregateCorroboration(rows)!.result).toBe("NOT_CORROBORATED");
  });

  it("corroborates only when every fragment was read and every one agreed", () => {
    const rows = [enc("a", { corroboration: corrob("CORROBORATED", 4, 4) }), enc("b", { corroboration: corrob("CORROBORATED", 2, 2) })];
    const agg = aggregateCorroboration(rows)!;
    expect(agg.result).toBe("CORROBORATED");
    // Counts sum across fragments — the only arithmetic meaningful at note level.
    expect(agg.reproduced).toBe(6);
    expect(agg.total).toBe(6);
  });

  it("unions the unreproduced field names and drops duplicates", () => {
    const rows = [
      enc("a", { corroboration: corrob("NOT_CORROBORATED", 1, 2, ["date", "laterality"]) }),
      enc("b", { corroboration: corrob("NOT_CORROBORATED", 0, 2, ["laterality", "provider"]) }),
    ];
    expect([...(aggregateCorroboration(rows)!.unreproducedFields ?? [])].sort()).toEqual(["date", "laterality", "provider"]);
  });

  it("reports nothing at all when no fragment was ever re-read", () => {
    expect(aggregateCorroboration([enc("a"), enc("b")])).toBeNull();
  });

  it("puts the aggregate on the note, not the first fragment's verdict", () => {
    const rows = [enc("a", { corroboration: corrob("CORROBORATED", 4, 4) }), enc("b", { corroboration: corrob("NOT_CORROBORATED", 0, 2, ["date"]) })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.corroboration!.result).toBe("NOT_CORROBORATED");
    expect(note.needsAttention).toBe(true);
  });
});

describe("fragments of one note must agree about who and when", () => {
  it("reports a date disagreement rather than picking the first value", () => {
    const rows = [enc("a"), enc("b", { encounterDate: "2025-09-02" })];
    expect(fragmentDisagreement(rows)).toContain("date");
  });

  it("reports a provider disagreement", () => {
    const rows = [enc("a"), enc("b", { provider: "T. Okafor, DO" })];
    expect(fragmentDisagreement(rows)).toContain("provider");
  });

  it("does not call the same name written two ways a disagreement", () => {
    const rows = [enc("a"), enc("b", { provider: "A Rivera MD" })];
    expect(fragmentDisagreement(rows)).toEqual([]);
  });

  it("ignores a fragment that simply has no value", () => {
    const rows = [enc("a"), enc("b", { provider: null, encounterDate: null, dateStatus: "DOCUMENTED" })];
    expect(fragmentDisagreement(rows)).toEqual([]);
  });

  it("makes a note whose fragments are dated differently an exception that explains itself", () => {
    const rows = [enc("a"), enc("b", { encounterDate: "2025-09-02" })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.needsAttention).toBe(true);
    expect(note.guidance.kind).toBe("FRAGMENT_DISAGREEMENT");
    expect(note.guidance.canAttest).toBe(false);
    expect(note.guidance.why).toMatch(/disagree about the date/);
  });

  it("does NOT turn several providers into a review obligation", () => {
    // A therapy course, a billing ledger and a multi-visit packet name several
    // rendering providers by design. On the reference case 27 notes did — all
    // correctly segmented. Flagging them would manufacture review work.
    const rows = [enc("a"), enc("b", { provider: "T. Okafor, DO" })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.needsAttention).toBe(false);
    expect(note.guidance.kind).toBe("CLEAN");
  });

  it("shows every provider instead of asserting the first one", () => {
    const rows = [enc("a"), enc("b", { provider: "T. Okafor, DO" })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.providers).toEqual(["A. Rivera, MD", "T. Okafor, DO"]);
    expect(note.fragmentDisagreement).toContain("provider");
    // …but it is reported, not asked about.
    expect(note.materialDisagreement).toEqual([]);
  });

  it("treats a note whose fragments disagree about the date as undated", () => {
    const rows = [enc("a"), enc("b", { encounterDate: "2025-09-02" })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.dateStatus).toBe("UNKNOWN");
  });

  it("leaves an agreeing note clean", () => {
    const rows = [enc("a"), enc("b")];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.fragmentDisagreement).toEqual([]);
    expect(note.providers).toEqual(["A. Rivera, MD"]);
    expect(note.guidance.kind).toBe("CLEAN");
  });
});
