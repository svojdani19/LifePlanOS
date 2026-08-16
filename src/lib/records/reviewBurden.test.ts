// ─────────────────────────────────────────────────────────────────────────────
// Counting at the right grain.
//
// The failure these tests exist to prevent: a document-level finding stored on
// every row was counted once per row, so 14 real contradictions were reported
// as ~1,276. Every count here is by identity, and the headline test copies one
// finding onto hundreds of synthetic rows to prove it still counts as one.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { measureReviewBurden, canonicalNoteId, type BurdenFinding, type BurdenRow } from "@/lib/records/reviewBurden";
import { findingFingerprint, distinctOpen } from "@/lib/records/recordFindings";

const row = (id: string, over: Partial<BurdenRow> = {}): BurdenRow => ({
  id,
  sourceDocumentId: "doc-1",
  status: "AI_AUDIT_PASSED",
  auditResult: "PASS",
  dateStatus: "DOCUMENTED",
  ...over,
});

const docFinding = (over: Partial<BurdenFinding> = {}): BurdenFinding => ({
  id: "f1",
  fingerprint: "fp-doc-1",
  scope: "DOCUMENT",
  type: "MISSING_ENCOUNTER",
  status: "OPEN",
  blocking: true,
  sourceDocumentId: "doc-1",
  ...over,
});

describe("a document finding is one finding, however many rows display it", () => {
  it("counts one document finding copied onto 512 rows as ONE", () => {
    // The exact shape of the original mis-measurement.
    const rows = Array.from({ length: 512 }, (_, i) => row(`r${i}`));
    const repeated = rows.map((_, i) => docFinding({ id: `copy-${i}` })); // same fingerprint
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: rows.map((r) => r.id) }] }],
      rows,
      findings: repeated,
      pages: [],
    });
    expect(burden.findingsByScope.DOCUMENT).toBe(1);
    expect(burden.documentBlockers).toBe(1);
  });

  it("counts 14 distinct contradictions as 14, not as the rows that show them", () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`r${i}`));
    const contradictions: BurdenFinding[] = Array.from({ length: 14 }, (_, i) => ({
      id: `c${i}`,
      fingerprint: `fp-entry-${i}`,
      scope: "ENTRY",
      type: i % 2 ? "CONTRADICTED_DATE" : "CONTRADICTED_PROVIDER",
      status: "OPEN",
      blocking: true,
      encounterId: `r${i}`,
    }));
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: rows.map((r) => r.id) }] }],
      rows,
      findings: contradictions,
      pages: [],
    });
    expect(burden.findingsByScope.ENTRY).toBe(14);
    expect(burden.entriesWithFindings).toBe(14);
  });

  it("does not count findings a reviewer already answered", () => {
    const rows = [row("r1")];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["r1"] }] }],
      rows,
      findings: [docFinding({ status: "DISMISSED" }), docFinding({ id: "f2", fingerprint: "fp-2", status: "RESOLVED" })],
      pages: [],
    });
    expect(burden.documentBlockers).toBe(0);
  });
});

describe("the review unit is the canonical note", () => {
  it("consolidates rows into the notes the records builder persisted", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a", "b", "c"] }, { rowIds: ["d"] }] }],
      rows,
      findings: [],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(2);
    expect(burden.multiRowNotes).toBe(1);
    expect(burden.decisionsBeforeConsolidation).toBe(4);
    expect(burden.decisionsAfterConsolidation).toBe(2);
  });

  it("gives a row no segment claims its own note, so nothing becomes unreviewable", () => {
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a"] }] }],
      rows: [row("a"), row("orphan")],
      findings: [],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(2);
    expect(burden.rowsWithoutSegment).toBe(1);
  });

  it("ignores a segment whose rows are all superseded", () => {
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["gone-1", "gone-2"] }, { rowIds: ["live"] }] }],
      rows: [row("live")],
      findings: [],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(1);
  });

  it("puts a note in attention when ANY of its rows carries an entry finding", () => {
    const rows = [row("a"), row("b"), row("c")];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }] }],
      rows,
      findings: [{ id: "f", fingerprint: "fp", scope: "ENTRY", type: "CONTRADICTED_DATE", status: "OPEN", blocking: true, encounterId: "b" }],
      pages: [],
    });
    expect(burden.notesNeedingAttention).toBe(1);
    expect(burden.cleanNotesAwaitingAttestation).toBe(1);
  });

  it("does not let a document finding push every note into attention", () => {
    const rows = [row("a"), row("b")];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a"] }, { rowIds: ["b"] }] }],
      rows,
      findings: [docFinding()],
      pages: [],
    });
    // The document is blocked; the sound notes are still clean to attest.
    expect(burden.documentBlockers).toBe(1);
    expect(burden.notesNeedingAttention).toBe(0);
    expect(burden.cleanNotesAwaitingAttestation).toBe(2);
  });

  it("counts an unresolved row as attention even with no finding attached", () => {
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a"] }] }],
      rows: [row("a", { status: "STALE", auditResult: "PASS" })],
      findings: [],
      pages: [],
    });
    expect(burden.notesNeedingAttention).toBe(1);
  });
});

describe("finding identity", () => {
  it("is the same for the same problem re-derived, and different for a different page", () => {
    const base = { firmId: "f", caseId: "c", scope: "PAGE" as const, type: "PAGE_UNREADABLE", source: "PAGE_LEDGER" as const, detail: "x" };
    const first = findingFingerprint({ ...base, pageStart: 4, pageEnd: 4 });
    const again = findingFingerprint({ ...base, pageStart: 4, pageEnd: 4, detail: "reworded explanation" });
    const other = findingFingerprint({ ...base, pageStart: 9, pageEnd: 9 });
    expect(again).toBe(first); // wording is not identity
    expect(other).not.toBe(first); // a different page is a different problem
  });

  it("deduplicates by identity when the same finding is stored twice", () => {
    const rows = [
      { fingerprint: "same", status: "OPEN" },
      { fingerprint: "same", status: "OPEN" },
      { fingerprint: "other", status: "OPEN" },
      { fingerprint: "third", status: "DISMISSED" },
    ];
    expect(distinctOpen(rows)).toHaveLength(2);
  });
});

describe("each metric counts what its name says", () => {
  it("counts only rows whose KIND requires a date as a dating gap", () => {
    // The Records page tells the user that fee schedules and letters need no
    // date. The metric said otherwise, about the same rows.
    const rows = [
      row("clinical", { dateStatus: "UNKNOWN", analysisClass: "CLINICAL_ENCOUNTER" }),
      row("ledger", { dateStatus: "UNKNOWN", analysisClass: "FINANCIAL" }),
      row("letter", { dateStatus: "UNKNOWN", analysisClass: "CORRESPONDENCE_OR_GENERIC_EVIDENCE" }),
    ];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: rows.map((r) => r.id) }] }],
      rows,
      findings: [],
      pages: [],
    });
    expect(burden.undatedClinical).toBe(1);
    expect(burden.undatedDatelessByDesign).toBe(2);
  });

  it("treats a row of unrecorded kind as needing a date — the conservative reading", () => {
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["legacy"] }] }],
      rows: [row("legacy", { dateStatus: "UNKNOWN", analysisClass: null })],
      findings: [],
      pages: [],
    });
    expect(burden.undatedClinical).toBe(1);
  });

  it("keeps notesWithFindings and notesNeedingAttention as different questions", () => {
    // One note carries a finding; a second is stale with no finding attached.
    // Returning one Set for both made them aliases that could never disagree.
    const rows = [row("a"), row("b", { status: "STALE" })];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a"] }, { rowIds: ["b"] }] }],
      rows,
      findings: [{ id: "f", fingerprint: "fp", scope: "ENTRY", type: "CONTRADICTED_DATE", status: "OPEN", blocking: true, encounterId: "a" }],
      pages: [],
    });
    expect(burden.notesWithFindings).toBe(1);
    expect(burden.notesNeedingAttention).toBe(2);
  });

  it("counts the cross-document copies one decision now covers", () => {
    // The linkage IS the segment: a note assembled from two documents' rows.
    const rows = [row("primary", { sourceDocumentId: "doc-1" }), row("copy", { sourceDocumentId: "doc-2" })];
    const burden = measureReviewBurden({
      documents: [
        { id: "doc-1", segments: [{ rowIds: ["primary", "copy"] }] },
        { id: "doc-2", segments: [] },
      ],
      rows,
      findings: [],
      pages: [],
    });
    expect(burden.crossDocumentCopies).toBe(1);
    // …and it is one decision, not two.
    expect(burden.canonicalNotes).toBe(1);
  });

  it("reports no copies when nothing is linked across documents", () => {
    const rows = [row("a"), row("b")];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a", "b"] }] }],
      rows,
      findings: [],
      pages: [],
    });
    expect(burden.crossDocumentCopies).toBe(0);
  });
});
