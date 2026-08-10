import { describe, expect, it } from "vitest";
import {
  cleanFacilityName,
  dedupeAcrossDocuments,
  cleanProvider,
  dominantClass,
  isDuplicateClaim,
  mergeKey,
  mergeRows,
  MAX_CLAIMS_PER_ENTRY,
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

describe("the same record filed in several documents", () => {
  const claimsA = [
    { field: "procedure", value: "Pre-procedural assessment for sedation procedure", excerpt: "x" },
    { field: "assessment", value: "Sedation planned under monitored anesthesia care", excerpt: "y" },
  ];
  const entryIn = (docId: string, extra: typeof claimsA = []) =>
    row({ id: `r-${docId}`, sourceDocumentId: docId, encounterDate: new Date("2004-10-10T00:00:00Z"), claims: [...claimsA, ...extra] });

  it("folds copies of one record bound into four PDFs", () => {
    // A real chronology showed 10/10/2004 four times, one per document the
    // same pre-procedure form happened to be filed in.
    const merged = mergeRows([entryIn("d1"), entryIn("d2"), entryIn("d3"), entryIn("d4")]);
    expect(merged).toHaveLength(4);
    const deduped = dedupeAcrossDocuments(merged);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].alsoInDocumentIds).toHaveLength(3);
  });

  it("keeps the copy that states more", () => {
    const deduped = dedupeAcrossDocuments(
      mergeRows([entryIn("d1"), entryIn("d2", [{ field: "medications", value: "Midazolam 2 mg administered intravenously", excerpt: "z" }])]),
    );
    expect(deduped).toHaveLength(1);
    expect(deduped[0].claims.some((c) => c.field === "medications")).toBe(true);
  });

  it("does not fold two genuinely different records on one date", () => {
    // A surgery and the anaesthesia record share a date and are not the same
    // document; folding them would delete one of them from the timeline.
    const surgery = row({ id: "s", sourceDocumentId: "d1", encounterDate: new Date("2024-03-15T00:00:00Z"),
      claims: [{ field: "procedure", value: "L2-S1 bilateral laminectomy, facetectomy and foraminotomy", excerpt: "a" }] });
    const anesthesia = row({ id: "a", sourceDocumentId: "d2", encounterDate: new Date("2024-03-15T00:00:00Z"),
      claims: [{ field: "medications", value: "Total charge billed: $11,000.00 for anesthesia services", excerpt: "b" }] });
    expect(dedupeAcrossDocuments(mergeRows([surgery, anesthesia]))).toHaveLength(2);
  });

  it("never folds undated entries", () => {
    const a = row({ id: "a", sourceDocumentId: "d1", encounterDate: null, claims: claimsA });
    const b = row({ id: "b", sourceDocumentId: "d2", encounterDate: null, claims: claimsA });
    expect(dedupeAcrossDocuments(mergeRows([a, b]))).toHaveLength(2);
  });
});

describe("an inherited date is not evidence two rows are one record", () => {
  const bulk = (i: number, status: string) =>
    row({ id: `b${i}`, dateStatus: status, encounterDate: new Date("2004-10-10T00:00:00Z"),
      claims: [{ field: "documentContent", value: `Form line ${i} recorded on the pre-procedure sheet`, excerpt: `e${i}` }] });

  it("splits a group that holds more than one record's worth of claims", () => {
    // Date inheritance smeared one date across a document: ninety rows and
    // 1,218 claims merged into a single "record" the writer could not compose.
    // Refusing to merge inherited dates at all produced 1,376 entries where
    // 720 was already too many, so oversized groups are split instead.
    const rows = Array.from({ length: 90 }, (_, i) => bulk(i, "INFERRED"));
    const merged = mergeRows(rows);
    expect(merged.length).toBeGreaterThan(1);
    expect(merged.length).toBeLessThan(90);
    for (const m of merged) expect(m.claims.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_ENTRY);
  });

  it("still merges an ordinary visit into one entry", () => {
    const merged = mergeRows(Array.from({ length: 14 }, (_, i) => bulk(i, "DOCUMENTED")));
    expect(merged).toHaveLength(1);
  });

  it("treats a missing dateStatus as documented, for rows written before it existed", () => {
    const merged = mergeRows([row({ id: "a" }), row({ id: "b" })]);
    expect(merged).toHaveLength(1);
  });
});
