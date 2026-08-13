import { describe, expect, it } from "vitest";
import { findNotes } from "@/lib/records/noteStructure";
import {
  cleanFacilityName,
  dedupeAcrossDocuments,
  cleanProvider,
  dominantClass,
  chronologyMateriality,
  consolidateIntoNotes,
  providerKey,
  entrySubstance,
  isDuplicateClaim,
  mergeKey,
  mergeRows,
  MAX_CLAIMS_PER_ENTRY,
  pageAttributionUsable,
  type MergeableRow,
} from "@/lib/records/entryMerge";

// Rows drawn from one note overlap in the source text; that overlap is the
// evidence a merge now requires, and every real row carries it. A date alone
// no longer merges anything, which is the point of the change.
const SAME_NOTE = { start: 1_000, end: 2_000 };

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
  it("consolidates fourteen extraction rows from one note", () => {
    // A real chiropractic visit produced fourteen rows against one published
    // entry, because overlapping chunks each wrote out the same note. They
    // merge on that overlap — not on the date they happen to share.
    const rows = Array.from({ length: 14 }, (_, i) =>
      row({ id: `r${i}`, segmentKey: "note-1", claims: [{ field: "treatment", value: "Traction performed at 62 lbs", excerpt: "traction 62 lbs" }] }),
    );
    const merged = mergeRows(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].rowIds).toHaveLength(14);
  });

  it("does NOT merge two rows that share only a document and a date", () => {
    // The defect this change exists to fix: a combined production carries
    // several encounters on one day, and a date-keyed merge reported them as
    // one event.
    const merged = mergeRows([
      row({ id: "a", claims: [{ field: "subjective", value: "Patient reports right shoulder pain after lifting", excerpt: "x" }] }),
      row({ id: "b", claims: [{ field: "subjective", value: "Patient reports left knee swelling following a fall", excerpt: "y" }] }),
    ]);
    expect(merged).toHaveLength(2);
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
      row({ id: "a", segmentKey: "note-1", claims: [{ field: "subjective", value: "Numbness in the left hand digits", excerpt: "x" }] }),
      row({ id: "b", segmentKey: "note-1", claims: [{ field: "treatment", value: "Traction performed at 62 lbs", excerpt: "y" }] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].claims.map((c) => c.field).sort()).toEqual(["subjective", "treatment"]);
  });

  it("collapses the same fact reworded", () => {
    // "the previous night" and "last night" were two rows of one sentence.
    const merged = mergeRows([
      row({ id: "a", segmentKey: "note-1", claims: [{ field: "subjective", value: "Patient reports weakness and pain on the left knee last night", excerpt: "x" }] }),
      row({ id: "b", segmentKey: "note-1", claims: [{ field: "subjective", value: "Patient reports weakness and pain on the left knee", excerpt: "y" }] }),
    ]);
    expect(merged[0].claims).toHaveLength(1);
    // The fuller statement survives.
    expect(merged[0].claims[0].value).toMatch(/last night/);
  });

  it("does not collapse two different facts in the same field", () => {
    const merged = mergeRows([
      row({ id: "a", segmentKey: "note-1", claims: [{ field: "subjective", value: "Numbness in the left hand digits upon waking", excerpt: "x" }] }),
      row({ id: "b", segmentKey: "note-1", claims: [{ field: "subjective", value: "Increased numbness and tingling in the left foot", excerpt: "y" }] }),
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
    const merged = mergeRows([
      row({ id: "a", segmentKey: "note-1", analysisClass: "THERAPY_COURSE", claims: [{ field: "treatment", value: "Traction at 62 lbs for fifteen minutes", excerpt: "x" }] }),
      row({ id: "b", segmentKey: "note-1", analysisClass: "FINANCIAL", claims: [{ field: "charge", value: "Traction at 62 lbs for fifteen minutes billed", excerpt: "y" }] }),
    ]);
    expect(merged).toHaveLength(1);
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
  const opClaims = [
    { field: "procedure", value: "L2-S1 bilateral laminectomy, facetectomy and foraminotomy performed", excerpt: "x" },
    { field: "preOperativeDiagnosis", value: "Herniated disc L2-S1 with central canal stenosis", excerpt: "y" },
  ];
  const copyIn = (docId: string, extra: typeof opClaims = []) =>
    row({
      id: `r-${docId}`, sourceDocumentId: docId, analysisClass: "OPERATIVE",
      encounterDate: new Date("2024-03-15T00:00:00Z"), claims: [...opClaims, ...extra],
    });

  it("consolidates copies of one operative report bound into several PDFs", () => {
    const deduped = dedupeAcrossDocuments(mergeRows([copyIn("d1"), copyIn("d2"), copyIn("d3")]));
    expect(deduped).toHaveLength(1);
    expect(deduped[0].alsoInDocumentIds).toHaveLength(2);
  });

  it("preserves every source row and document in the provenance", () => {
    const deduped = dedupeAcrossDocuments(mergeRows([copyIn("d1"), copyIn("d2")]));
    expect(deduped[0].rowIds.sort()).toEqual(["r-d1", "r-d2"]);
    expect([deduped[0].sourceDocumentId, ...(deduped[0].alsoInDocumentIds ?? [])].sort()).toEqual(["d1", "d2"]);
  });

  it("loses no claim when one copy states something the other does not", () => {
    // An earlier version assigned the richer copy over the twin wholesale,
    // which silently discarded every claim the other copy stated alone.
    const deduped = dedupeAcrossDocuments(
      mergeRows([
        copyIn("d1", [{ field: "estimatedBloodLoss", value: "Estimated blood loss was 150 millilitres", excerpt: "a" }]),
        copyIn("d2", [{ field: "medications", value: "Dexamethasone 10 mg and vancomycin 1 gram given", excerpt: "b" }]),
      ]),
    );
    expect(deduped).toHaveLength(1);
    const fields = deduped[0].claims.map((c) => c.field);
    expect(fields).toContain("estimatedBloodLoss");
    expect(fields).toContain("medications");
  });

  it("keeps each claim's own excerpt — a claim never inherits another's citation", () => {
    const deduped = dedupeAcrossDocuments(
      mergeRows([
        copyIn("d1", [{ field: "estimatedBloodLoss", value: "Estimated blood loss was 150 millilitres", excerpt: "ebl-excerpt" }]),
        copyIn("d2", [{ field: "medications", value: "Dexamethasone 10 mg and vancomycin 1 gram given", excerpt: "meds-excerpt" }]),
      ]),
    );
    const ebl = deduped[0].claims.find((c) => c.field === "estimatedBloodLoss");
    const meds = deduped[0].claims.find((c) => c.field === "medications");
    expect(ebl?.excerpt).toBe("ebl-excerpt");
    expect(meds?.excerpt).toBe("meds-excerpt");
  });

  it("does not fold two records that merely share a date across documents", () => {
    // A surgery and an unrelated therapy note on the same day are two records,
    // however much template text their charts share.
    const surgery = copyIn("d1");
    const therapy = row({
      id: "t", sourceDocumentId: "d2", analysisClass: "THERAPY_COURSE",
      encounterDate: new Date("2024-03-15T00:00:00Z"),
      claims: [{ field: "treatment", value: "Therapeutic exercise and gait training were performed", excerpt: "z" }],
    });
    expect(dedupeAcrossDocuments(mergeRows([surgery, therapy]))).toHaveLength(2);
  });

  it("does not fold on shared boilerplate alone", () => {
    // Two unrelated notes from one chart share their medication list, their
    // allergies and their standing diagnoses. That is a template, not identity.
    const boiler = [
      { field: "subjective", value: "No known drug allergies documented", excerpt: "b1" },
      { field: "pastMedicalHistory", value: "Diabetes mellitus and hypertension", excerpt: "b2" },
      { field: "recommendations", value: "Return to the emergency department if symptoms worsen", excerpt: "b3" },
    ];
    const a = row({ id: "a", sourceDocumentId: "d1", analysisClass: "CLINICAL_ENCOUNTER", claims: boiler });
    const b = row({ id: "b", sourceDocumentId: "d2", analysisClass: "CLINICAL_ENCOUNTER", claims: boiler });
    expect(dedupeAcrossDocuments(mergeRows([a, b]))).toHaveLength(2);
  });

  it("never folds undated entries across documents", () => {
    const a = row({ id: "a", sourceDocumentId: "d1", encounterDate: null, claims: opClaims });
    const b = row({ id: "b", sourceDocumentId: "d2", encounterDate: null, claims: opClaims });
    expect(dedupeAcrossDocuments(mergeRows([a, b]))).toHaveLength(2);
  });

  it("gives the same result whatever order the entries arrive in", () => {
    const forward = dedupeAcrossDocuments(mergeRows([copyIn("d1"), copyIn("d2"), copyIn("d3")]));
    const backward = dedupeAcrossDocuments(mergeRows([copyIn("d3"), copyIn("d2"), copyIn("d1")]));
    expect(backward.map((e) => e.rowIds.sort())).toEqual(forward.map((e) => e.rowIds.sort()));
  });

  it("is idempotent", () => {
    const once = dedupeAcrossDocuments(mergeRows([copyIn("d1"), copyIn("d2")]));
    const twice = dedupeAcrossDocuments(once);
    expect(twice).toHaveLength(once.length);
    expect(twice[0].claims.length).toBe(once[0].claims.length);
  });
});

describe("an inherited date is not evidence two rows are one record", () => {
  const bulk = (i: number, status: string) =>
    row({ id: `b${i}`, dateStatus: status, segmentKey: "form-1", encounterDate: new Date("2004-10-10T00:00:00Z"),
      claims: [{ field: "documentContent", value: `Form line ${i} recorded on the pre-procedure sheet`, excerpt: `e${i}` }] });

  it("keeps a large day as one record, for the writer to paginate", () => {
    // Ninety rows on one inherited date is a lot of text but still one record
    // to a reviewer. Splitting it to fit the prompt turned 1,111 entries into
    // 1,684 and broke visits apart; a large record is written in passes.
    const merged = mergeRows(Array.from({ length: 90 }, (_, i) => bulk(i, "INFERRED")));
    expect(merged).toHaveLength(1);
    expect(merged[0].claims.length).toBeGreaterThan(35);
  });

  it("still splits a pathological group", () => {
    // Date inheritance once pooled 1,218 claims onto a single day. The bound
    // exists only to stop that becoming one unreadable entry.
    const many = Array.from({ length: 30 }, (_, i) =>
      row({ id: `m${i}`, dateStatus: "INFERRED", segmentKey: "form-1", encounterDate: new Date("2004-10-10T00:00:00Z"),
        claims: Array.from({ length: 40 }, (_, j) => ({ field: "documentContent", value: `Distinct recorded line ${i}-${j} of the form`, excerpt: `e${i}-${j}` })) }),
    );
    const merged = mergeRows(many);
    expect(merged.length).toBeGreaterThan(1);
    for (const m of merged) expect(m.claims.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_ENTRY);
  });

  it("still merges an ordinary visit into one entry", () => {
    const merged = mergeRows(Array.from({ length: 14 }, (_, i) => bulk(i, "DOCUMENTED")));
    expect(merged).toHaveLength(1);
  });

  it("does not merge two rows on identity evidence they do not have", () => {
    // No spans, no segment, no claims — nothing but a shared date. Kept apart.
    const merged = mergeRows([row({ id: "a" }), row({ id: "b" })]);
    expect(merged).toHaveLength(2);
  });
});

describe("what belongs in the clinical records list", () => {
  const entry = (klass: MergeableRow["analysisClass"], ...values: string[]) =>
    mergeRows([row({ analysisClass: klass, claims: values.map((value, i) => ({ field: "documentContent", value, excerpt: `e${i}` })) })])[0];

  it("keeps a visit clinical", () => {
    expect(entrySubstance(entry("THERAPY_COURSE", "Traction performed at 62 lbs for fifteen minutes"))).toBe("CLINICAL");
  });

  it("routes record furniture out of the clinical list", () => {
    // These reached the clinical list as entries in their own right, sitting
    // alongside a four-level laminectomy.
    expect(entrySubstance(entry("CORRESPONDENCE_OR_GENERIC_EVIDENCE", "Administrative page footer indicating this is page 3 of 3, revised December 1, 2022"))).toBe("ADMINISTRATIVE");
    expect(entrySubstance(entry("CORRESPONDENCE_OR_GENERIC_EVIDENCE", "Administrative consent form authorizing specimen retention and medical record disclosure"))).toBe("ADMINISTRATIVE");
  });

  it("keeps a bill reachable as ancillary rather than discarding it", () => {
    // A charge for a visit bears on the course of care; the reviewer asked for
    // it to be treated as a bill, not deleted.
    expect(entrySubstance(entry("FINANCIAL", "Procedure 63047 billed on 03/15/2024, outstanding charge $11,733.30"))).toBe("ANCILLARY");
  });

  it("treats unclassified paper as administrative", () => {
    expect(entrySubstance(entry("UNKNOWN", "Some text of no determinable kind"))).toBe("ADMINISTRATIVE");
  });

  it("does not call a real record furniture because it mentions a consent", () => {
    const e = entry("CLINICAL_ENCOUNTER",
      "Consent for treatment was obtained before the procedure",
      "Lumbar epidural injection was performed at L4-L5 under fluoroscopy",
      "The patient tolerated the procedure without complication");
    expect(entrySubstance(e)).toBe("CLINICAL");
  });
});

describe("what belongs on the medical chronology", () => {
  // The records list and the timeline answer different questions. Every record
  // stays reachable in the list; the timeline carries only what changed the
  // course of care. A single surgical admission produced 141 timeline events
  // before anything enforced that distinction.
  const timeline = (klass: MergeableRow["analysisClass"], claims: Array<[string, string]>) =>
    mergeRows([
      row({ analysisClass: klass, claims: claims.map(([field, value], i) => ({ field, value, excerpt: `e${i}` })) }),
    ])[0];

  it("puts an operation on the timeline", () => {
    const v = chronologyMateriality(
      timeline("OPERATIVE", [["procedure", "Bilateral lumbar laminectomy L2-S1 performed for prolapsed disc"]]),
    );
    expect(v.material).toBe(true);
  });

  it("keeps a shift's vital signs off the timeline", () => {
    const v = chronologyMateriality(
      timeline("CLINICAL_ENCOUNTER", [
        ["objectiveFindings", "Vital signs: temperature 96.2 F, temporal artery"],
        ["objectiveFindings", "Vitals recorded, blood pressure 118/72"],
      ]),
    );
    expect(v.material).toBe(false);
    expect(v.reason).toBe("INTRA_EPISODE_ROUTINE");
  });

  it("keeps a medication administration record off the timeline", () => {
    const v = chronologyMateriality(
      timeline("CLINICAL_ENCOUNTER", [["medications", "Medication administration record: dose administered 0600"]]),
    );
    expect(v.material).toBe(false);
  });

  it("keeps an operative note on the timeline despite the routine detail around it", () => {
    // A pivotal record is pivotal whatever record-keeping it also carries;
    // screening on the proportion of routine claims alone would drop this.
    const v = chronologyMateriality(
      timeline("OPERATIVE", [
        ["objectiveFindings", "Vital signs stable throughout"],
        ["objectiveFindings", "PACU monitoring, oxygen saturation 96% on room air"],
        ["procedure", "Operative report: bilateral lumbar laminectomy L2-S1"],
      ]),
    );
    expect(v.material).toBe(true);
    expect(v.reason).toBe("PIVOTAL_EVENT");
  });

  it("keeps a record with no clinical assertion off the timeline", () => {
    const v = chronologyMateriality(
      timeline("CORRESPONDENCE_OR_GENERIC_EVIDENCE", [["documentContent", "Page 3 of 3, revised December 2022"]]),
    );
    expect(v.material).toBe(false);
    expect(v.reason).toBe("NO_CLINICAL_ASSERTION");
  });

  it("keeps a lone biometric off the timeline", () => {
    // This reached the timeline as an event dated to the morning of a
    // four-level laminectomy.
    const v = chronologyMateriality(timeline("CLINICAL_ENCOUNTER", [["objectiveFindings", "Height documented at 5'4\"."]]));
    expect(v.material).toBe(false);
    expect(v.reason).toBe("MEASUREMENT_ONLY");
  });

  it("keeps a measurement that comes with an assessment", () => {
    const v = chronologyMateriality(
      timeline("CLINICAL_ENCOUNTER", [
        ["objectiveFindings", "Weight 210 lbs"],
        ["assessment", "Morbid obesity contributing to delayed wound healing"],
      ]),
    );
    expect(v.material).toBe(true);
  });

  it("keeps a discharge on the timeline", () => {
    expect(
      chronologyMateriality(timeline("CLINICAL_ENCOUNTER", [["disposition", "Discharged home with home health"]])).material,
    ).toBe(true);
  });
});

describe("what each production's copy keeps of itself", () => {
  const copy = (over: Partial<MergeableRow>, ...values: string[]) =>
    mergeRows([row({ ...over, claims: values.map((value, i) => ({ field: "assessment", value, excerpt: `e${i}` })) })])[0];

  it("keeps every copy's own pages and rows through a cross-document fold", () => {
    // Folding kept only the other document's ID; its pages and rows were
    // discarded, so a duplicate copy's citation pointed at the primary's pages.
    const same = ["Emergency department visit for fall with left knee and hip pain", "X-rays showed no fractures"];
    const a = { ...copy({ id: "a", sourceDocumentId: "hospital" }, ...same), pageStart: 12, pageEnd: 14 };
    const b = { ...copy({ id: "b", sourceDocumentId: "therapy" }, ...same), pageStart: 3, pageEnd: 4 };
    const [folded] = dedupeAcrossDocuments([a, b]);
    expect(folded.appearances).toHaveLength(2);
    const hospital = folded.appearances?.find((x) => x.documentId === "hospital");
    const therapy = folded.appearances?.find((x) => x.documentId === "therapy");
    expect(hospital).toMatchObject({ pageStart: 12, pageEnd: 14 });
    expect(therapy).toMatchObject({ pageStart: 3, pageEnd: 4 });
    expect(therapy?.rowIds).toContain("b");
  });

  it("identifies each copy's content by hash rather than another copy of it", () => {
    const a = copy({ id: "a", sourceDocumentId: "d1" }, "Emergency department visit for fall with left knee and hip pain", "Discharged home");
    const b = copy({ id: "b", sourceDocumentId: "d2" }, "Emergency department visit for fall with left knee and hip pain", "Discharged home");
    const [folded] = dedupeAcrossDocuments([a, b]);
    for (const appearance of folded.appearances ?? []) {
      expect(appearance.contentHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("one visit filed in two record productions", () => {
  const entry = (over: Partial<MergeableRow>, ...values: string[]) =>
    mergeRows([row({ ...over, claims: values.map((value, i) => ({ field: "assessment", value, excerpt: `e${i}` })) })])[0];

  it("folds one clinician's visit when the two productions agree on its substance", () => {
    // The hospital filed it as "ENGLISH, PAUL W" and the therapy practice as
    // "Paul English, MD"; those key to one man now. Where the two accounts
    // agree on what happened, the author carries the identity that the exact
    // wording does not.
    const a = entry(
      { sourceDocumentId: "hospital", provider: "ENGLISH, PAUL W" },
      "Emergency department visit for fall with left knee and hip pain",
      "X-rays showed no fractures",
      "Discharged home after Toradol",
    );
    const b = entry(
      { sourceDocumentId: "therapy", provider: "Paul English, MD" },
      "Emergency department visit for fall with left knee and hip pain",
      "X-rays showed no fractures",
      "Discharged home after Toradol administration",
    );
    expect(dedupeAcrossDocuments([a, b])).toHaveLength(1);
  });

  it("leaves two accounts that share only their opening line as two records", () => {
    // Deliberate. Folding these would need a bar low enough to also fold the
    // operative report with the discharge summary the same surgeon wrote that
    // day, and losing a real record is worse than showing a duplicate.
    const a = entry(
      { sourceDocumentId: "hospital", provider: "ENGLISH, PAUL W" },
      "Emergency department visit for fall with left knee and hip pain",
      "Toradol administered, patient discharged home",
    );
    const b = entry(
      { sourceDocumentId: "therapy", provider: "Paul English, MD" },
      "Emergency department visit for fall with left knee and hip pain",
      "X-rays showed no fractures, discharged with ibuprofen",
    );
    expect(dedupeAcrossDocuments([a, b])).toHaveLength(2);
  });

  it("keeps one surgeon's operative report and discharge summary apart", () => {
    // He writes both on the day he operates, and the published plan lists them
    // separately. Authorship alone must not fold them.
    const op = entry(
      { sourceDocumentId: "hospital", provider: "Fernando Techy, MD", analysisClass: "OPERATIVE" },
      "Bilateral L2-S1 laminectomy, facetectomy and foraminotomy performed",
      "Estimated blood loss 150 mL, patient extubated to PACU",
    );
    const discharge = entry(
      { sourceDocumentId: "hospital2", provider: "Fernando Techy, MD", analysisClass: "CLINICAL_ENCOUNTER" },
      "Discharged home on postoperative day eight with home health",
      "Diabetes management addressed, follow-up in two weeks",
    );
    expect(dedupeAcrossDocuments([op, discharge])).toHaveLength(2);
  });

  it("folds a word-for-word copy filed in two productions", () => {
    // Ten records survived as pairs this way — one MRI report, one therapy
    // visit — because cross-document folding measured only DISTINCTIVE-fact
    // overlap, which scores zero when the extractor yields no distinctive facts
    // however identical the text. Within a document this was already the test.
    const a = entry({ sourceDocumentId: "hospital" }, "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis");
    const b = entry({ sourceDocumentId: "imaging" }, "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis");
    expect(dedupeAcrossDocuments([a, b])).toHaveLength(1);
  });

  it("does not fold two records that agree only on their boilerplate", () => {
    const a = entry({ sourceDocumentId: "d1" }, "No known drug allergies (NKDA)");
    const b = entry({ sourceDocumentId: "d2" }, "No known drug allergies (NKDA)");
    expect(dedupeAcrossDocuments([a, b])).toHaveLength(2);
  });

  it("does not fold two records because a facility name matches", () => {
    // An organisation is a filing cabinet, not an author.
    const a = entry({ sourceDocumentId: "d1", provider: "Chopra Imaging Centers, Inc" }, "MRI lumbar spine performed");
    const b = entry({ sourceDocumentId: "d2", provider: "Chopra Imaging Centers, Inc" }, "CT cervical spine performed");
    expect(dedupeAcrossDocuments([a, b])).toHaveLength(2);
  });
});

describe("who signed the note", () => {
  // A hospital chart prints the same surgeon four ways on four consecutive
  // pages. Each spelling started its own record, so one operation appeared four
  // times on the timeline.
  it("keys one author however the chart spells the name", () => {
    const key = providerKey("Fernando Techy, MD");
    expect(key).toBe("TECHY|F");
    expect(providerKey("FERNANDO TECHY")).toBe(key);
    expect(providerKey("DR F. TECHY")).toBe(key);
    expect(providerKey("Techy, Fernando")).toBe(key);
  });

  it("reads the author out of a listed care team", () => {
    // The role annotation carries its own slash, so it has to go before the
    // string is split on the separators between people.
    expect(providerKey("Fernando Techy, MD (admitting/surgeon); Esteban Berberian, MD (attending)")).toBe("TECHY|F");
  });

  it("drops credentials rather than reading them as a surname", () => {
    expect(providerKey("Abraham Jiju, PT")).toBe("JIJU|A");
    expect(providerKey("Esteban N Berberian, MD")).toBe("BERBERIAN|E");
    expect(providerKey("Mary Catharine Maxian, MD")).toBe("MAXIAN|M");
  });

  it("reads a surname printed first, with or without a middle initial", () => {
    // "ENGLISH, PAUL W" is how an emergency department prints the man the
    // discharge summary calls Paul English, MD. Read the other way he keyed on
    // PAUL, and the two records never met.
    expect(providerKey("ENGLISH, PAUL W")).toBe("ENGLISH|P");
    expect(providerKey("Paul English, MD")).toBe("ENGLISH|P");
    expect(providerKey("English Paul W")).toBe("ENGLISH|P");
    expect(providerKey("GIDWANI, GIRISH M")).toBe("GIDWANI|G");
  });

  it("does not reverse a name because of a credential it has not seen before", () => {
    // The comma test ran on a string with credentials stripped by a list that
    // did not include DC, so "Michael Crone, DC" read as surname Michael — and
    // every "First Last, CRED" outside that list came out reversed.
    expect(providerKey("Michael Crone, DC")).toBe("CRONE|M");
    expect(providerKey("Mary Catharine Maxian, CRNA")).toBe("MAXIAN|M");
    expect(providerKey("Abraham Jiju, PT")).toBe("JIJU|A");
  });

  it("keys an organisation apart from any person", () => {
    // Keyed as people these became "INC" and "PLLC", which files two unrelated
    // companies under one author.
    expect(providerKey("Chopra Imaging Centers, Inc")).toBe("ORG|CHOPRA IMAGING CENTERS INC");
    expect(providerKey("Dynamic Anesthesia Providers PLLC")).toBe("ORG|DYNAMIC ANESTHESIA PROVIDERS PLLC");
    expect(providerKey("Chopra Imaging Centers, Inc")).not.toBe(providerKey("Chopra Radiology Group"));
  });

  it("says nothing when the field does not name anyone", () => {
    expect(providerKey(null)).toBeNull();
    expect(providerKey("")).toBeNull();
    expect(providerKey("Osly")).toBeNull();
  });
});

describe("the source note is the identity, not the author plus the date", () => {
  const filler = () => " clinical narrative continues ".repeat(40);
  const at = (start: number, provider: string | null, value: string) =>
    mergeRows([row({ id: `r${start}`, provider, claims: [{ field: "assessment", value, excerpt: `e${start}` }] })]).map(
      (e) => ({ ...e, span: { start, end: start + 400, pageStart: null, pageEnd: null } }),
    )[0];

  it("keeps one surgeon's operative report and discharge summary separate in one document", () => {
    // He writes both on the day he operates. Folding them by authorship put a
    // discharge's disposition inside the operative note, and the published
    // plan lists them as two entries.
    const text = `Operative Report Provider: TECHY, FERNANDO ${filler()}Discharge Summary Provider: TECHY, FERNANDO ${filler()}`;
    const structure = findNotes(text);
    expect(structure).toHaveLength(2);
    const opAt = structure[0].start + 60;
    const dcAt = structure[1].start + 60;
    const notes = consolidateIntoNotes(
      [at(opAt, "Fernando Techy, MD", "Bilateral laminectomy performed"), at(dcAt, "Fernando Techy, MD", "Discharged home with therapy")],
      { documentNotes: structure },
    );
    expect(notes).toHaveLength(2);
  });

  it("keeps notes of different kinds distinct, and folds repeats of the same kind", () => {
    // Scoping is by the KIND of note. Two same-day "Progress Note" instances by
    // one author fold — offset-scoping was measured and re-fragmented the
    // admission (14 entries on the surgery date became 39) — while an operative
    // report never folds into a consultation.
    const text = `Progress Note Provider: BERBERIAN, ESTEBAN ${filler()}Progress Note Provider: BERBERIAN, ESTEBAN ${filler()}Consultation Provider: BERBERIAN, ESTEBAN ${filler()}`;
    const structure = findNotes(text);
    expect(structure).toHaveLength(3);
    const notes = consolidateIntoNotes(
      [
        at(structure[0].start + 60, "Esteban Berberian, MD", "Ambulating with assistance"),
        at(structure[1].start + 60, "Esteban Berberian, MD", "Pain controlled on orals"),
        at(structure[2].start + 60, "Esteban Berberian, MD", "Consulted for glucose management"),
      ],
      { documentNotes: structure },
    );
    expect(notes).toHaveLength(2);
  });

  it("still folds one author's fragments inside one detected note", () => {
    const text = `Operative Report Provider: TECHY, FERNANDO ${filler()}${filler()}`;
    const structure = findNotes(text);
    const notes = consolidateIntoNotes(
      [
        at(structure[0].start + 60, "Fernando Techy, MD", "Laminectomy performed"),
        at(structure[0].start + 500, "FERNANDO TECHY, MD", "Estimated blood loss 150 mL"),
      ],
      { documentNotes: structure },
    );
    expect(notes).toHaveLength(1);
  });

  it("keeps the anti-fragmentation behaviour where headers are sparse", () => {
    // No detected boundaries at all: one author's fragments still fold, which
    // is the measured win against 128 events on one surgery date.
    const notes = consolidateIntoNotes(
      [at(0, "Fernando Techy, MD", "Laminectomy performed"), at(600, "DR F. TECHY", "Extubated to PACU")],
      { documentNotes: [] },
    );
    expect(notes).toHaveLength(1);
  });

  it("does not split an author whose boundaries the detection failed to capture", () => {
    // One fragment crosses the note's end, so the boundary evidence does not
    // cover this author's whole work — and evidence that incomplete does not
    // get to divide their record. Splitting on partial containment was measured
    // on the real chart: one surgeon became five entries on the day he
    // operated, cut into arbitrary scraps rather than into his notes.
    const text = `Progress Note Provider: BERBERIAN, ESTEBAN ${filler()}Consultation Provider: BERBERIAN, ESTEBAN ${filler()}`;
    const structure = findNotes(text);
    const spill = {
      ...at(structure[0].start + 60, "Esteban Berberian, MD", "Crosses the boundary"),
      span: { start: structure[0].start + 60, end: structure[1].end + 5_000, pageStart: null, pageEnd: null },
    };
    const inside = at(structure[1].start + 100, "Esteban Berberian, MD", "Inside the consultation");
    expect(consolidateIntoNotes([spill, inside], { documentNotes: structure })).toHaveLength(1);
  });
});

describe("names the chart got wrong", () => {
  const at = (start: number, provider: string | null, value: string) =>
    mergeRows([row({ id: `r${start}`, provider, claims: [{ field: "assessment", value, excerpt: `e${start}` }] })]).map(
      (e) => ({ ...e, span: { start, end: start + 500, pageStart: null, pageEnd: null } }),
    )[0];

  it("folds an OCR-mangled name into the author it belongs to", () => {
    // "Techy. Femando" is a surname-first listing whose comma scanned as a full
    // stop; "DR. FTECHY" ran the title into the surname. Both were separate
    // surgeons performing the same operation.
    const notes = consolidateIntoNotes([
      at(0, "FERNANDO TECHY, MD", "Bilateral lumbar laminectomy L2-S1 performed"),
      at(600, "Techy. Femando", "Intraoperative fluoroscopy, total time 3 seconds"),
      at(1_200, "DR. FTECHY", "Estimated blood loss 150 mL"),
    ]);
    expect(notes).toHaveLength(1);
  });

  it("does not fold two genuinely different authors on a short surname", () => {
    const notes = consolidateIntoNotes([
      at(0, "Alan Ross, MD", "Assessment recorded"),
      at(600, "Alan Rose, MD", "Assessment recorded separately"),
    ]);
    expect(notes).toHaveLength(2);
  });

  it("refuses the patient as author even when the scan mangled their name", () => {
    // "MCMENRY" is the patient's own surname with a letter scanned wrong. An
    // exact comparison misses it, which is how it reached the timeline.
    const notes = consolidateIntoNotes(
      [
        at(0, "Fernando Techy, MD", "Laminectomy performed"),
        at(600, "MCMENRY, DERRICK", "Elective admission for prolapsed lumbar disc"),
      ],
      { patientName: "Derrick McHenry" },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].provider).toBe("Fernando Techy, MD");
  });

  it("refuses to make the patient the author of their own note", () => {
    // The extractor read the patient's name off a chart header. Left alone it
    // collects records from every clinician who saw them under one author.
    const notes = consolidateIntoNotes(
      [
        at(0, "Fernando Techy, MD", "Laminectomy performed"),
        at(600, "MCHENRY, DERRICK", "Admission evaluation for prolapsed lumbar disc"),
      ],
      { patientName: "Derrick McHenry" },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].provider).toBe("Fernando Techy, MD");
  });
});

describe("folding a chart back into the notes it was signed as", () => {
  const at = (start: number, provider: string | null, ...values: string[]) =>
    mergeRows(
      [
        row({
          id: `r${start}`,
          provider,
          claims: values.map((value, i) => ({ field: "assessment", value, excerpt: `e${start}${i}` })),
        }),
      ],
      undefined,
    ).map((e) => ({ ...e, span: { start, end: start + 500, pageStart: null, pageEnd: null } }))[0];

  it("folds one author's fragments into one note", () => {
    const notes = consolidateIntoNotes([
      at(0, "FERNANDO TECHY, MD", "Bilateral lumbar laminectomy L2-S1 performed"),
      at(600, "Fernando Techy, MD", "Estimated blood loss 150 mL"),
      at(1_200, "DR F. TECHY", "Patient extubated awake and transferred to PACU"),
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0].claims).toHaveLength(3);
  });

  it("keeps two authors on the same day apart", () => {
    // The published plan lists the surgeon, the attending, the anaesthetist and
    // the therapist as separate entries for one admission.
    const notes = consolidateIntoNotes([
      at(0, "Fernando Techy, MD", "Laminectomy performed"),
      at(600, "Esteban Berberian, MD", "Diabetes mellitus managed on sliding scale insulin"),
    ]);
    expect(notes).toHaveLength(2);
  });

  it("attaches an unattributed fragment to the note it sits inside", () => {
    // A chart names its author once, in the note header; the pages that follow
    // do not repeat it.
    const notes = consolidateIntoNotes([
      at(0, "Fernando Techy, MD", "Laminectomy performed"),
      at(700, null, "Final count correct, MD notified"),
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0].provider).toBe("Fernando Techy, MD");
  });

  it("leaves a distant fragment alone rather than guessing an author for it", () => {
    const notes = consolidateIntoNotes([
      at(0, "Fernando Techy, MD", "Laminectomy performed"),
      at(400_000, null, "Physical therapy evaluation, gait antalgic"),
    ]);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => !n.provider)).toBeDefined();
  });

  it("cannot place a fragment with no span, and says so by leaving it", () => {
    const orphan = { ...at(0, null, "Charge posted"), span: null };
    const notes = consolidateIntoNotes([at(1_000, "Fernando Techy, MD", "Laminectomy performed"), orphan]);
    expect(notes).toHaveLength(2);
  });

  it("does not fold an organisation into a physician's note", () => {
    const notes = consolidateIntoNotes([
      at(0, "Fernando Techy, MD", "Laminectomy performed"),
      at(600, "Dynamic Anesthesia Providers PLLC", "Anesthesia services rendered"),
    ]);
    expect(notes).toHaveLength(2);
  });

  it("never folds across documents on a shared date", () => {
    // A date alone still authorises nothing.
    const a = at(0, "Fernando Techy, MD", "Laminectomy performed");
    const b = { ...at(0, "Fernando Techy, MD", "Laminectomy performed"), sourceDocumentId: "doc2" };
    expect(consolidateIntoNotes([a, b])).toHaveLength(2);
  });

  it("never folds one author's notes from two different days", () => {
    const a = at(0, "Fernando Techy, MD", "Laminectomy performed");
    const b = { ...at(600, "Fernando Techy, MD", "Wound clean, dry, intact"), encounterDate: new Date("2023-07-19T00:00:00Z") };
    expect(consolidateIntoNotes([a, b])).toHaveLength(2);
  });

  it("leaves a bucket that names nobody exactly as it found it", () => {
    const entries = [at(0, null, "Vital signs recorded"), at(600, null, "Intake and output charted")];
    expect(consolidateIntoNotes(entries)).toHaveLength(2);
  });

  it("folds identical unattributed copies of one record", () => {
    // One emergency visit reached the chronology four times, byte-identical,
    // with no author and the same document and date. Grouping is by author, and
    // an entry naming nobody can only attach to a note that names someone — so
    // a bucket naming nobody passed straight through, however many copies it
    // held.
    const copy = (start: number) => at(start, null, "Emergency department visit for initial evaluation of left knee contusion");
    const folded = consolidateIntoNotes([copy(0), copy(600), copy(1_200), copy(1_800)]);
    expect(folded).toHaveLength(1);
  });

  it("does not fold two visits that merely read alike", () => {
    // Two therapy sessions in a week genuinely resemble each other, and merging
    // those loses a visit rather than a duplicate.
    const folded = consolidateIntoNotes([
      at(0, null, "Therapy: electrical stimulation to the lumbar region, patient tolerated well"),
      at(600, null, "Therapy: ultrasound to the cervical region, moderate tenderness on palpation"),
    ]);
    expect(folded).toHaveLength(2);
  });

  it("does not fold identical text recorded on different days", () => {
    const a = at(0, null, "Emergency department visit for initial evaluation of left knee contusion");
    const b = { ...at(600, null, "Emergency department visit for initial evaluation of left knee contusion"), encounterDate: new Date("2023-08-02T00:00:00Z") };
    expect(consolidateIntoNotes([a, b])).toHaveLength(2);
  });

  it("orders notes by date", () => {
    const later = { ...at(600, "Esteban Berberian, MD", "Follow-up"), encounterDate: new Date("2024-01-02T00:00:00Z") };
    const earlier = { ...at(0, "Fernando Techy, MD", "Surgery"), encounterDate: new Date("2023-01-02T00:00:00Z") };
    const notes = consolidateIntoNotes([later, earlier]);
    expect(notes[0].encounterDate?.getUTCFullYear()).toBe(2023);
  });
});
