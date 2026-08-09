import { describe, expect, it } from "vitest";
import {
  cleanFacilityName,
  cleanProvider,
  dominantClass,
  isDuplicateClaim,
  mergeKey,
  mergeRows,
  pageAttributionUsable,
  type MergeableRow,
} from "@/lib/records/entryMerge";

const row = (over: Partial<MergeableRow> = {}): MergeableRow => ({
  id: "r1",
  sourceDocumentId: "doc1",
  analysisClass: "THERAPY_COURSE",
  encounterDate: new Date("2023-07-12T00:00:00Z"),
  provider: null,
  facility: null,
  page: 1,
  pageEnd: 1,
  substanceClass: "CLINICAL",
  claims: [],
  ...over,
});

describe("one visit becomes one entry", () => {
  it("merges rows sharing a document and a date", () => {
    // A real chiropractic visit produced fourteen rows against one published
    // entry, because overlapping chunks each wrote out the same note.
    const rows = Array.from({ length: 14 }, (_, i) =>
      row({ id: `r${i}`, claims: [{ field: "treatment", value: "Traction performed at 62 lbs", excerpt: "traction 62 lbs" }] }),
    );
    const merged = mergeRows(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].rowIds).toHaveLength(14);
  });

  it("keeps records from different documents apart", () => {
    const merged = mergeRows([row({ id: "a" }), row({ id: "b", sourceDocumentId: "doc2" })]);
    expect(merged).toHaveLength(2);
  });

  it("keeps different dates apart", () => {
    const merged = mergeRows([row({ id: "a" }), row({ id: "b", encounterDate: new Date("2023-07-14T00:00:00Z") })]);
    expect(merged).toHaveLength(2);
  });

  it("never merges undated rows with each other", () => {
    // Two records that merely both lack a date are not the same record.
    const merged = mergeRows([row({ id: "a", encounterDate: null }), row({ id: "b", encounterDate: null })]);
    expect(merged).toHaveLength(2);
    expect(mergeKey(row({ id: "a", encounterDate: null }))).not.toBe(mergeKey(row({ id: "b", encounterDate: null })));
  });
});

describe("merging loses no fact", () => {
  it("keeps distinct claims from every row", () => {
    const merged = mergeRows([
      row({ id: "a", claims: [{ field: "subjective", value: "Numbness in the left hand digits", excerpt: "x" }] }),
      row({ id: "b", claims: [{ field: "treatment", value: "Traction performed at 62 lbs", excerpt: "y" }] }),
    ]);
    expect(merged[0].claims.map((c) => c.field).sort()).toEqual(["subjective", "treatment"]);
  });

  it("collapses the same fact reworded", () => {
    // "the previous night" and "last night" were two rows of one sentence.
    const merged = mergeRows([
      row({ id: "a", claims: [{ field: "subjective", value: "Patient reports weakness and pain on the left knee last night", excerpt: "x" }] }),
      row({ id: "b", claims: [{ field: "subjective", value: "Patient reports weakness and pain on the left knee", excerpt: "y" }] }),
    ]);
    expect(merged[0].claims).toHaveLength(1);
    // The fuller statement survives.
    expect(merged[0].claims[0].value).toMatch(/last night/);
  });

  it("does not collapse two different facts in the same field", () => {
    const merged = mergeRows([
      row({ id: "a", claims: [{ field: "subjective", value: "Numbness in the left hand digits upon waking", excerpt: "x" }] }),
      row({ id: "b", claims: [{ field: "subjective", value: "Increased numbness and tingling in the left foot", excerpt: "y" }] }),
    ]);
    expect(merged[0].claims).toHaveLength(2);
  });

  it("does not treat a short fragment as a duplicate of a long statement", () => {
    expect(isDuplicateClaim({ field: "t", value: "traction" }, [{ field: "t", value: "Traction performed from 10:53 am at 62 lbs" }])).toBe(false);
  });
});

describe("the clinical reading wins over the billing one", () => {
  it("keeps an operation an operation when its charge merges in", () => {
    // A four-level laminectomy appeared on the timeline as "Procedure 63047
    // billed, outstanding charge $11,733.30" because the billing row won.
    expect(dominantClass(["FINANCIAL", "OPERATIVE", "FINANCIAL"])).toBe("OPERATIVE");
  });

  it("prefers any clinical class over correspondence", () => {
    expect(dominantClass(["CORRESPONDENCE_OR_GENERIC_EVIDENCE", "THERAPY_COURSE"])).toBe("THERAPY_COURSE");
  });

  it("records what it merged, so a disagreement stays visible", () => {
    const merged = mergeRows([row({ id: "a", analysisClass: "THERAPY_COURSE" }), row({ id: "b", analysisClass: "FINANCIAL" })]);
    expect(merged[0].mergedClasses.sort()).toEqual(["FINANCIAL", "THERAPY_COURSE"]);
  });
});

describe("a byline we are willing to print", () => {
  it("keeps a name with a credential", () => {
    expect(cleanProvider("Michael Crone, DC")).toBe("Michael Crone, DC");
    expect(cleanProvider("Paul English, M.D.")).toBe("Paul English, M.D.");
  });

  it("keeps a full name without one", () => {
    expect(cleanProvider("Mary Catharine Maxian")).toBe("Mary Catharine Maxian");
  });

  it("discards an OCR fragment rather than printing a wrong author", () => {
    // Real entries came back attributed to "Osly" and to "Andrew".
    expect(cleanProvider("Osly")).toBeNull();
    expect(cleanProvider("Andrew")).toBeNull();
    expect(cleanProvider("")).toBeNull();
  });

  it("drops the fragment during a merge", () => {
    const merged = mergeRows([row({ provider: "Osly" })]);
    expect(merged[0].provider).toBeNull();
  });
});

describe("a facility name, not a mailing address", () => {
  it("strips the street address", () => {
    expect(cleanFacilityName("EHS - Porter Hospital Systems, 24540 Fm 1314 Rd, Porter, TX 77365")).toBe("EHS - Porter Hospital Systems");
  });

  it("leaves a plain institution alone", () => {
    expect(cleanFacilityName("The Houston Spine and Rehabilitation Centers")).toBe("The Houston Spine and Rehabilitation Centers");
  });
});

describe("citing a page only when the page is real", () => {
  it("refuses to cite when every row claims the same page of a long document", () => {
    // A 56-page packet recorded every extracted row on "page 1".
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, page: 1, pageEnd: 1 }));
    expect(pageAttributionUsable(rows, 56)).toBe(false);
  });

  it("cites when pages actually vary", () => {
    expect(pageAttributionUsable([row({ page: 5, pageEnd: 7 }), row({ id: "b", page: 11, pageEnd: 13 })], 56)).toBe(true);
  });

  it("cites a genuinely single-page document", () => {
    expect(pageAttributionUsable([row({ page: 1, pageEnd: 1 })], 1)).toBe(true);
  });

  it("refuses when no row carries a page at all", () => {
    expect(pageAttributionUsable([row({ page: null, pageEnd: null })], 56)).toBe(false);
  });
});
