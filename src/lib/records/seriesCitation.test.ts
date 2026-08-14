import { describe, expect, it } from "vitest";
import { seriesCitation, seriesMembersOf } from "@/lib/records/seriesCitation";

// A series row asserting "12 documented visits" must cite them: the members
// are persisted for exactly this, and the first rendering showed only the
// first document with no page at all.

const nameOf = (id: string | null | undefined) => (id === "doc-1" ? "PT_Records.pdf" : id === "doc-2" ? "Clinic_Chart.pdf" : "record on file");

describe("citing a treatment series", () => {
  it("groups member pages by document, in order of first appearance", () => {
    const text = seriesCitation(
      [
        { date: "2023-07-03", documentId: "doc-1", page: 12 },
        { date: "2023-07-07", documentId: "doc-1", page: 15 },
        { date: "2023-07-12", documentId: "doc-2", page: 4 },
      ],
      nameOf,
    );
    expect(text).toBe("Sources (3 documented visits): PT_Records.pdf, pp. 12, 15; Clinic_Chart.pdf, p. 4.");
  });

  it("keeps a document without page numbers citable by name", () => {
    const text = seriesCitation([{ date: "2023-07-03", documentId: "doc-1", page: null }], nameOf);
    expect(text).toBe("Sources (1 documented visits): PT_Records.pdf.");
  });

  it("deduplicates repeated pages and sorts them", () => {
    const text = seriesCitation(
      [
        { date: "2023-07-07", documentId: "doc-1", page: 15 },
        { date: "2023-07-03", documentId: "doc-1", page: 12 },
        { date: "2023-07-12", documentId: "doc-1", page: 15 },
      ],
      nameOf,
    );
    expect(text).toContain("pp. 12, 15");
    expect(text).toContain("(3 documented visits)");
  });

  it("returns null for an ordinary event with no membership", () => {
    expect(seriesCitation([], nameOf)).toBeNull();
  });
});

describe("narrowing the persisted JSON", () => {
  it("accepts only an array of objects", () => {
    expect(seriesMembersOf(null)).toEqual([]);
    expect(seriesMembersOf("not an array")).toEqual([]);
    expect(seriesMembersOf([null, "x", { date: "2023-07-03", documentId: "doc-1", page: 2 }])).toEqual([
      { date: "2023-07-03", documentId: "doc-1", page: 2 },
    ]);
  });
});
