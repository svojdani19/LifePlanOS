// An entry from a later page of a dated note is not a loose, undated record —
// the document already says when it happened. These tests hold the line
// between placing an entry from its own document and inventing a date.
// Synthetic data only.
import { describe, it, expect } from "vitest";
import { inheritDatesWithinDocument, type DatableEntry } from "./dateInheritance";

const entry = (over: Partial<DatableEntry> = {}): DatableEntry => ({
  dateStatus: "UNKNOWN",
  encounterDate: null,
  encounterDateEnd: null,
  page: 5,
  pageEnd: 5,
  sourceDocumentId: "doc-1",
  warnings: [],
  ...over,
});

const dated = (page: number, pageEnd: number, iso: string) =>
  entry({ dateStatus: "DOCUMENTED", encounterDate: new Date(`${iso}T00:00:00Z`), page, pageEnd });

describe("an undated entry is placed by its own document", () => {
  it("inherits from the dated entry whose pages contain it", () => {
    const out = inheritDatesWithinDocument([dated(3, 7, "2025-03-14"), entry({ page: 5 })]);
    expect(out.placed).toBe(1);
    const placed = out.entries[1];
    expect(placed.dateStatus).toBe("INFERRED");
    expect(placed.encounterDate?.toISOString().slice(0, 10)).toBe("2025-03-14");
    // The row says what placed it; an inherited date is never silent.
    expect(placed.warnings.join(" ")).toMatch(/inherited from the dated entry covering pages 3–7/);
  });

  it("prefers the TIGHTEST containing span", () => {
    // A four-page note explains its own page 5 better than a forty-page
    // admission that also covers it.
    const out = inheritDatesWithinDocument([
      dated(1, 40, "2025-01-01"),
      dated(4, 7, "2025-03-14"),
      entry({ page: 5 }),
    ]);
    expect(out.entries[2].encounterDate?.toISOString().slice(0, 10)).toBe("2025-03-14");
  });

  it("falls back to a dated SECTION of the same document", () => {
    const out = inheritDatesWithinDocument([entry({ page: 12 })], [{ date: "2025-06-02", pageStart: 10, pageEnd: 14 }]);
    expect(out.placed).toBe(1);
    expect(out.entries[0].dateStatus).toBe("INFERRED");
    expect(out.entries[0].warnings.join(" ")).toMatch(/dated section of this same document/);
  });

  it("an inherited date is INFERRED, never DOCUMENTED", () => {
    const out = inheritDatesWithinDocument([dated(3, 7, "2025-03-14"), entry({ page: 5 })]);
    // It was not cited on that page; it was carried from a neighbour.
    expect(out.entries[1].dateStatus).not.toBe("DOCUMENTED");
  });
});

describe("what the document cannot place stays undated", () => {
  it("a page outside every dated span is left alone", () => {
    const out = inheritDatesWithinDocument([dated(3, 7, "2025-03-14"), entry({ page: 90 })]);
    expect(out.placed).toBe(0);
    expect(out.unresolved).toBe(1);
    expect(out.entries[1].dateStatus).toBe("UNKNOWN");
    expect(out.entries[1].encounterDate).toBeNull();
  });

  it("an entry with no page has no position, so nothing can place it", () => {
    const out = inheritDatesWithinDocument([dated(3, 7, "2025-03-14"), entry({ page: null })]);
    expect(out.placed).toBe(0);
    expect(out.entries[1].dateStatus).toBe("UNKNOWN");
  });

  it("a document with no dated content places nothing", () => {
    const out = inheritDatesWithinDocument([entry({ page: 2 }), entry({ page: 5 })]);
    expect(out.placed).toBe(0);
    expect(out.unresolved).toBe(2);
  });

  it("entries that already carry a date are untouched", () => {
    const keep = dated(3, 7, "2025-03-14");
    const out = inheritDatesWithinDocument([keep, dated(8, 9, "2025-03-20")]);
    expect(out.placed).toBe(0);
    expect(out.entries[0].warnings).toHaveLength(0);
    expect(out.entries[0].dateStatus).toBe("DOCUMENTED");
  });
});
