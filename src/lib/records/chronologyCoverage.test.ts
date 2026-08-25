import { describe, it, expect } from "vitest";
import { chronologyCoverage, coverageSentence } from "@/lib/records/chronologyCoverage";

// The defect: `Math.max(0, documents.length - events.length)` was presented as
// a count of documents "without a bearing on the complaint". It is not a
// quantity at all — it subtracts events from documents — and it asserted a
// reason the data never established.

const doc = (id: string, status = "PROCESSED", type: string | null = "MEDICAL_RECORD") => ({ id, status, type });
const ev = (sourceDocumentId: string | null, seriesMembers?: unknown) => ({ sourceDocumentId, seriesMembers });

describe("chronologyCoverage", () => {
  it("counts many events from one document as one represented document", () => {
    // The old arithmetic: 3 documents - 40 events, clamped to 0, claiming full
    // coverage of a case where two documents were never represented.
    const documents = [doc("a"), doc("b"), doc("c")];
    const events = Array.from({ length: 40 }, () => ev("a"));
    const c = chronologyCoverage(documents, events);
    expect(c.representedDocuments).toBe(1);
    expect(c.processedNotRepresented).toBe(2);
    expect(Math.max(0, documents.length - events.length)).toBe(0); // the old number
  });

  it("counts one event citing several documents through its series members", () => {
    const documents = [doc("a"), doc("b"), doc("c")];
    const events = [ev("a", [{ documentId: "b" }, { documentId: "c" }])];
    const c = chronologyCoverage(documents, events);
    expect(c.representedDocuments).toBe(3);
    expect(c.processedNotRepresented).toBe(0);
  });

  it("separates failed and unprocessed documents from irrelevant ones", () => {
    const documents = [doc("a"), doc("b", "FAILED"), doc("c", "OCR_PENDING"), doc("d", "PROCESSING")];
    const c = chronologyCoverage(documents, [ev("a")]);
    expect(c.representedDocuments).toBe(1);
    expect(c.unprocessed).toBe(3);
    expect(c.failed).toBe(1);
    // Crucially: a document that could not be read is never counted as one
    // found to have no bearing on the complaint.
    expect(c.processedNotRepresented).toBe(0);
    expect(c.excludedByType).toBe(0);
  });

  it("counts a processed document excluded by stored type separately", () => {
    const documents = [doc("a"), doc("bill", "PROCESSED", "BILLING_RECORD"), doc("depo", "PROCESSED", "DEPOSITION")];
    const c = chronologyCoverage(documents, [ev("a")]);
    expect(c.excludedByType).toBe(2);
    expect(c.processedNotRepresented).toBe(0);
  });

  it("counts a processed, non-excluded, unrepresented document neutrally", () => {
    const documents = [doc("a"), doc("b")];
    const c = chronologyCoverage(documents, [ev("a")]);
    expect(c.processedNotRepresented).toBe(1);
    expect(c.excludedByType).toBe(0);
  });

  it("does not let a citation to an unknown document inflate coverage", () => {
    const c = chronologyCoverage([doc("a")], [ev("a"), ev("ghost")]);
    expect(c.representedDocuments).toBe(1);
    expect(c.totalDocuments).toBe(1);
  });

  it("ignores events with no source citation", () => {
    const c = chronologyCoverage([doc("a")], [ev(null), ev(undefined as never)]);
    expect(c.representedDocuments).toBe(0);
    expect(c.processedNotRepresented).toBe(1);
  });

  it("never returns a negative or clamped count", () => {
    const documents = [doc("a")];
    const events = Array.from({ length: 500 }, () => ev("a"));
    const c = chronologyCoverage(documents, events);
    expect(c.representedDocuments).toBe(1);
    expect(c.representedDocuments + c.excludedByType + c.processedNotRepresented + c.unprocessed).toBe(c.totalDocuments);
  });

  it("every document lands in exactly one bucket", () => {
    const documents = [doc("a"), doc("b"), doc("bill", "PROCESSED", "BILLING_RECORD"), doc("f", "FAILED")];
    const c = chronologyCoverage(documents, [ev("a")]);
    expect(c.representedDocuments + c.excludedByType + c.processedNotRepresented + c.unprocessed).toBe(4);
  });
});

describe("coverageSentence", () => {
  it("never asserts a reason for a document that merely failed to process", () => {
    const c = chronologyCoverage([doc("a"), doc("b", "FAILED")], [ev("a")]);
    const s = coverageSentence(c, 1);
    expect(s).toContain("not yet processed");
    expect(s).toContain("1 failed");
    expect(s).not.toMatch(/bearing on the complaint/i);
    expect(s).not.toMatch(/excluded by record type/i);
  });

  it("uses neutral wording when the data does not prove why a record is absent", () => {
    const c = chronologyCoverage([doc("a"), doc("b")], [ev("a")]);
    const s = coverageSentence(c, 1);
    expect(s).toContain("not represented in the chronology");
    expect(s).not.toMatch(/no chronology-bearing content/i);
    expect(s).not.toMatch(/without a bearing/i);
  });

  it("claims an exclusion only where the stored type proves it", () => {
    const c = chronologyCoverage([doc("a"), doc("bill", "PROCESSED", "BILLING_RECORD")], [ev("a")]);
    expect(coverageSentence(c, 1)).toContain("1 record excluded by record type");
  });

  it("says only the headline when every document is represented", () => {
    const c = chronologyCoverage([doc("a")], [ev("a")]);
    expect(coverageSentence(c, 3)).toBe("3 pivotal events — those bearing on the diagnoses and future care — drawn from 1 record of 1.");
  });

  it("reports documents drawn on, not events minus documents", () => {
    const documents = [doc("a"), doc("b"), doc("c")];
    const c = chronologyCoverage(documents, Array.from({ length: 40 }, () => ev("a")));
    expect(coverageSentence(c, 40)).toContain("drawn from 1 record of 3");
  });
});
