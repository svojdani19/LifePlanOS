import { describe, expect, it } from "vitest";
import { groupBySpan, prepareDocument, spanOf, spansAreSameRecord, type SpannableRow } from "@/lib/records/rowSpans";

const row = (id: string, ...excerpts: string[]): SpannableRow => ({ id, claims: excerpts.map((excerpt) => ({ excerpt })) });

// Two notes in one packet, each with its own page marker and signature block.
const PACKET = `
Page 1 of 4
Visit: 07/12/2023
Subjective: increased numbness and tingling of the third fourth and fifth digits
Plan: lumbar traction was performed at sixty two pounds for fifteen minutes
Electronically signed by the treating clinician on the date of service
${"footer boilerplate ".repeat(120)}
Page 3 of 4
Visit: 07/14/2023
Subjective: the patient stated he felt improved with decreased muscle tightness
Plan: therapeutic massage was applied to the lumbar region for twenty minutes
`;

describe("finding where a row sits", () => {
  const doc = prepareDocument(PACKET);

  it("locates a row from its own claim excerpts", () => {
    const s = spanOf(doc, row("a", "increased numbness and tingling of the third fourth and fifth digits"));
    expect(s).not.toBeNull();
    expect(s!.start).toBeGreaterThan(0);
  });

  it("reads the page off the document's own markers", () => {
    // Page attribution was so unreliable that a 56-page packet recorded every
    // row on "page 1"; the offset resolves it against the printed marker.
    const first = spanOf(doc, row("a", "lumbar traction was performed at sixty two pounds"));
    const second = spanOf(doc, row("b", "therapeutic massage was applied to the lumbar region"));
    expect(first!.pageStart).toBe(1);
    expect(second!.pageStart).toBe(3);
  });

  it("returns null when no excerpt can be found", () => {
    expect(spanOf(doc, row("z", "a sentence that appears nowhere in this packet at all"))).toBeNull();
  });
});

describe("which rows are the same record", () => {
  const doc = prepareDocument(PACKET);

  it("groups chunks of one note together", () => {
    const groups = groupBySpan(doc, [
      row("a", "increased numbness and tingling of the third fourth and fifth digits"),
      row("b", "lumbar traction was performed at sixty two pounds for fifteen minutes"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps two notes in the same packet apart", () => {
    const groups = groupBySpan(doc, [
      row("a", "increased numbness and tingling of the third fourth and fifth digits"),
      row("b", "the patient stated he felt improved with decreased muscle tightness"),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("returns groups in document order", () => {
    const groups = groupBySpan(doc, [
      row("later", "the patient stated he felt improved with decreased muscle tightness"),
      row("earlier", "increased numbness and tingling of the third fourth and fifth digits"),
    ]);
    expect(groups[0].rows[0].id).toBe("earlier");
  });

  it("gives an unlocatable row its own group rather than guessing", () => {
    // With no position in hand there is no evidence it belongs with anything,
    // and merging it would fold an unrelated note into a real record.
    const groups = groupBySpan(doc, [
      row("a", "increased numbness and tingling of the third fourth and fifth digits"),
      row("lost", "text that is not in the document"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.span === null)?.rows[0].id).toBe("lost");
  });

  it("carries the page range across a record that spans pages", () => {
    const groups = groupBySpan(doc, [row("a", "lumbar traction was performed at sixty two pounds")]);
    expect(groups[0].span?.pageStart).toBe(1);
  });
});

describe("the same-record gap", () => {
  const at = (start: number, end: number) => ({ start, end, pageStart: null, pageEnd: null });

  it("treats overlapping spans as one record", () => {
    expect(spansAreSameRecord(at(100, 500), at(400, 900))).toBe(true);
  });

  it("treats an abutting span as one record", () => {
    expect(spansAreSameRecord(at(100, 500), at(520, 900))).toBe(true);
  });

  it("treats a span a page away as a different record", () => {
    expect(spansAreSameRecord(at(100, 500), at(9_000, 9_400))).toBe(false);
  });
});
