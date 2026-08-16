// The canonical note is the review unit — and consolidation must never hide a
// problem. Synthetic data only.
import { describe, expect, it } from "vitest";
import { projectNotes, type NoteFinding } from "@/lib/records/noteProjection";
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
