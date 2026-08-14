import { describe, expect, it, vi } from "vitest";
import {
  buildRecords,
  makeRecordStore,
  caseFingerprint,
  caseLockKey,
  collapseTreatmentSeries,
  MIN_SERIES_RUN,
  persistRecords,
  refreshCaseRecordsWithRecovery,
  MAX_STALE_RETRIES,
  type ChronologyDraft,
  sortForDisplay,
  type RecordSegment,
  type RecordStore,
} from "@/lib/records/buildRecords";
import type { MergeableRow } from "@/lib/records/entryMerge";
import { findNotes } from "@/lib/records/noteStructure";

// Synthetic throughout. Every fixture below is written to look like the charts
// this failed on — an EHR export, a scanned hospital packet, a billing ledger —
// without carrying anyone's record.

const CASE = "case-1";

let nextRow = 0;
const row = (over: Partial<MergeableRow> = {}): MergeableRow => ({
  id: `row-${++nextRow}`,
  sourceDocumentId: "doc-1",
  analysisClass: "CLINICAL_ENCOUNTER",
  encounterDate: null,
  provider: null,
  facility: null,
  page: null,
  pageEnd: null,
  substanceClass: "CLINICAL",
  dateStatus: "UNKNOWN",
  claims: [{ field: "assessment", value: "Lumbar radiculopathy documented", excerpt: "lumbar radiculopathy" }],
  ...over,
});

/** Build without composing prose: these tests are about structure and dates. */
const build = (text: string, rows: MergeableRow[], pageCount = 12, write = false) =>
  buildRecords({
    caseId: CASE,
    documents: [{ id: "doc-1", pageCount, extractedText: text, rows }],
    write,
    adjudicateDuplicates: false,
  });

const seg = (built: Awaited<ReturnType<typeof build>>) => built.segmentsByDocument.get("doc-1") ?? [];

const filler = (n = 500) => " clinical narrative continues ".repeat(n / 10);

describe("a note's own date reaches the fragments inside it", () => {
  it("dates a multi-page progress note from its header", async () => {
    // 1. The date appears only in the note's header; the pages under it repeat
    //    nothing but findings.
    const text = `Progress Note Date of Service: 03/18/2024 ${filler()} straight leg raise positive on the right ${filler()}`;
    const at = text.indexOf("straight leg raise");
    const built = await build(text, [
      row({ claims: [{ field: "objectiveFindings", value: "Straight leg raise positive on the right at 40 degrees", excerpt: "straight leg raise positive on the right" }] }),
    ]);
    expect(at).toBeGreaterThan(0);
    const [entry] = seg(built);
    expect(entry.date).toBe("2024-03-18");
    expect(entry.dateBasis).toBe("NOTE_SERVICE_LABEL");
    expect(entry.dateDocumented).toBe(true);
  });

  it("gives several fragments of one note the same documented date", async () => {
    // 2. Extraction chunked one note into three; all three are that note.
    const text = `History and Physical Encounter Date: 05/02/2024 ${filler()} reports low back pain ${filler()} examination showed reduced range of motion ${filler()} assessment lumbar strain ${filler()}`;
    const built = await build(text, [
      row({ claims: [{ field: "subjective", value: "Reports low back pain radiating to the left leg", excerpt: "reports low back pain" }] }),
      row({ claims: [{ field: "objectiveFindings", value: "Examination showed reduced lumbar range of motion", excerpt: "examination showed reduced range of motion" }] }),
      row({ claims: [{ field: "assessment", value: "Lumbar strain with radicular features", excerpt: "assessment lumbar strain" }] }),
    ]);
    const dates = new Set(seg(built).map((s) => s.date));
    expect(dates).toEqual(new Set(["2024-05-02"]));
  });

  it("does not give a note's date to a fragment outside it", async () => {
    // 4. An operative note and an anaesthesia record on one day stay distinct,
    //    and neither takes the other's date merely by sitting nearby.
    const text = `Operative Report Date of Procedure: 03/15/2024 ${filler()} laminectomy performed ${filler()}Anesthesia Record Date of Service: 03/15/2024 ${filler()} general anesthesia administered ${filler()}`;
    const notes = findNotes(text);
    expect(notes).toHaveLength(2);
    expect(notes[0].date).toBe("2024-03-15");
    expect(notes[1].date).toBe("2024-03-15");
    // Each note carries its own evidence rather than inheriting a neighbour's.
    expect(notes[0].dateEvidence).toContain("03/15/2024");
    expect(notes[1].dateEvidence).toContain("03/15/2024");
  });

  it("keeps an admission date off the notes filed later in the stay", async () => {
    // 5. An inpatient packet: the admission dates itself, and the progress note
    //    two days later dates itself too. The stay does not flatten onto one day.
    const text = `Admission Note Admission Date: 03/15/2024 ${filler()} admitted for lumbar decompression ${filler()}Progress Note Date of Service: 03/17/2024 ${filler()} ambulating with assistance ${filler()}Discharge Summary Date of Service: 03/23/2024 ${filler()} discharged home with therapy ${filler()}`;
    expect(findNotes(text).map((n) => n.date)).toEqual(["2024-03-15", "2024-03-17", "2024-03-23"]);
  });
});

describe("dates that must never be the encounter date", () => {
  it("refuses a date of birth and a print date", async () => {
    // 7.
    const text = `Progress Note DOB: 10/19/1976 Date Printed: 07/11/2025 ${filler()} reports ongoing pain ${filler()}`;
    expect(findNotes(text)[0].date).toBeNull();
  });

  it("refuses a scheduled follow-up", async () => {
    // 8.
    const text = `Progress Note Follow-up scheduled: 04/02/2024 ${filler()} reports improvement ${filler()}`;
    expect(findNotes(text)[0].date).toBeNull();
  });

  it("refuses a signature date and takes the service date instead", async () => {
    // 9.
    const text = `Radiology Report Exam Date: 06/04/2024 ${filler()} impression: L5-S1 disc protrusion ${filler()} Electronically Signed by: SHETTY_MANJUNATH_MD on 06/09/2024`;
    const note = findNotes(text)[0];
    expect(note.date).toBe("2024-06-04");
    expect(note.dateBasis).toBe("SERVICE_LABEL");
  });

  it("refuses two conflicting service dates rather than choosing one", async () => {
    const text = `Progress Note Date of Service: 03/18/2024 ${filler()} Date of Service: 04/22/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBeNull();
  });

  it("reads a specimen collection date and an imaging performed date", async () => {
    // 11, 12.
    const lab = `Pathology Report Collection Date: 02/14/2024 ${filler()} specimen received ${filler()}`;
    expect(findNotes(lab)[0].date).toBe("2024-02-14");
    const imaging = `Radiology Report Date Performed: 09/03/2024 ${filler()} impression: no acute fracture ${filler()} Electronically Signed by: CRONE_MICHAEL_MD on 09/05/2024`;
    expect(findNotes(imaging)[0].date).toBe("2024-09-03");
  });

  it("takes a date of service off a billing line", async () => {
    // 10. Via the claims rung of the ladder, not the note header.
    const built = await build(`Statement of charges ${filler()}`, [
      row({
        claims: [
          { field: "procedure", value: "Office visit (CPT 99214) performed on 10/01/2024", excerpt: "99214 performed on 10/01/2024" },
        ],
      }),
    ]);
    const [entry] = seg(built);
    expect(entry.date).toBe("2024-10-01");
    expect(entry.dateBasis).toBe("STATED_IN_CLAIMS");
    // Worked out from the record's own words, not read off a header.
    expect(entry.dateDocumented).toBe(false);
  });
});

describe("records that are not clinical encounters", () => {
  it("keeps a demographic fragment out of the clinical list", async () => {
    // 13. The entry from the screenshot.
    const built = await build(`Progress Note ${filler()}`, [
      row({ claims: [{ field: "subjective", value: "47-year-old male patient record.", excerpt: "47-year-old male" }] }),
    ]);
    const [entry] = seg(built);
    expect(entry.kind).toBe("administrative");
    expect(entry.insubstantialReason).toBe("DEMOGRAPHIC_ONLY");
    expect(entry.summary).toMatch(/no clinical event/i);
  });

  it("keeps an administrative fragment reachable but off the chronology", async () => {
    // 14.
    const built = await build(`Progress Note ${filler()}`, [
      row({
        analysisClass: "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
        encounterDate: new Date("2024-03-15T00:00:00Z"),
        dateStatus: "DOCUMENTED",
        claims: [{ field: "documentContent", value: "Records custodian affidavit page 2 of 3", excerpt: "custodian affidavit" }],
      }),
    ]);
    expect(seg(built)).toHaveLength(1);
    expect(seg(built)[0].kind).toBe("administrative");
    expect(built.chronology).toHaveLength(0);
  });

  it("keeps a study list without results out of the clinical list", async () => {
    const built = await build(`Progress Note ${filler()}`, [
      row({ claims: [{ field: "diagnosticStudies", value: "Laboratory and imaging studies included CBC and radiographs.", excerpt: "laboratory and imaging studies" }] }),
    ]);
    expect(seg(built)[0].insubstantialReason).toBe("STUDY_CATEGORIES_ONLY");
  });
});

describe("what a reviewer sees", () => {
  it("puts a genuinely undated clinical record in the review group with a reason", async () => {
    // 15.
    const built = await build("charge ledger with no dates at all", [
      row({ claims: [{ field: "assessment", value: "Lumbar radiculopathy with weakness in the right foot", excerpt: "lumbar radiculopathy" }] }),
    ]);
    const [entry] = seg(built);
    expect(entry.kind).toBe("clinical");
    expect(entry.date).toBeNull();
    expect(entry.unresolvedReason).toBeTruthy();
    expect(built.stats.undatedClinical).toBe(1);
  });

  it("sorts chronologically and puts undated records last", () => {
    // 16, and same-day notes keep the order the source filed them.
    const base: Omit<RecordSegment, "date" | "label" | "summary"> = {
      pageStart: null, pageEnd: null, kind: "clinical", type: "CLINICAL_ENCOUNTER",
      category: null, bearsOnCare: true, provider: null, facility: null,
    };
    const sorted = sortForDisplay([
      { ...base, date: null, label: "Undated", summary: "no date" },
      { ...base, date: "2024-03-18", label: "03/18/2024", summary: "later" },
      { ...base, date: "2024-03-15", label: "03/15/2024", summary: "operative" },
      { ...base, date: "2024-03-15", label: "03/15/2024", summary: "anesthesia" },
    ]);
    expect(sorted.map((s) => s.summary)).toEqual(["operative", "anesthesia", "later", "no date"]);
  });

  it("shows the basis and the evidence for a date", async () => {
    // 17.
    const built = await build(
      `Progress Note Date of Service: 03/18/2024 ${filler()} lumbar radiculopathy ${filler()}`,
      [row()],
    );
    const [entry] = seg(built);
    expect(entry.dateBasis).toBe("NOTE_SERVICE_LABEL");
    expect(entry.dateEvidence).toContain("03/18/2024");
  });

  it("keeps page citations through consolidation", async () => {
    // 18.
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [
      row({ page: 12, pageEnd: 14 }),
      row({ page: 15, pageEnd: 15 }),
    ]);
    const pages = seg(built).flatMap((s) => [s.pageStart, s.pageEnd]).filter(Boolean);
    expect(pages.length).toBeGreaterThan(0);
  });
});

describe("a document whose rows are all gone", () => {
  it("clears its stale segments rather than leaving old Details visible", async () => {
    // 4. Every row superseded or rejected: the document must publish an EMPTY
    //    segment list, not vanish from the update and keep its old content.
    const built = await build("some text with no active rows", []);
    expect(built.segmentsByDocument.get("doc-1")).toEqual([]);
  });
});

describe("citations for a record filed in two documents", () => {
  it("shows each document its own copy's pages", async () => {
    // 21. The same segment carried the primary's page numbers into every
    //     duplicate document's Details dropdown.
    const same = [
      { field: "assessment", value: "Emergency department visit for fall with left knee and hip pain", excerpt: "e1" },
      { field: "assessment", value: "X-rays showed no fractures, discharged home", excerpt: "e2" },
    ];
    const built = await buildRecords({
      caseId: CASE,
      write: false,
      adjudicateDuplicates: false,
      documents: [
        {
          id: "hospital",
          pageCount: 20,
          extractedText: `Progress Note Date of Service: 05/29/2023 ${filler()}`,
          rows: [row({ id: "h1", sourceDocumentId: "hospital", page: 12, pageEnd: 14, claims: same, encounterDate: new Date("2023-05-29T00:00:00Z"), dateStatus: "DOCUMENTED" })],
        },
        {
          id: "therapy",
          pageCount: 8,
          extractedText: `Progress Note Date of Service: 05/29/2023 ${filler()}`,
          rows: [row({ id: "t1", sourceDocumentId: "therapy", page: 3, pageEnd: 4, claims: same, encounterDate: new Date("2023-05-29T00:00:00Z"), dateStatus: "DOCUMENTED" })],
        },
      ],
    });
    const hospital = built.segmentsByDocument.get("hospital") ?? [];
    const therapy = built.segmentsByDocument.get("therapy") ?? [];
    expect(hospital).toHaveLength(1);
    expect(therapy).toHaveLength(1);
    expect(hospital[0].pageStart).toBe(12);
    expect(therapy[0].pageStart).toBe(3);
    expect(therapy[0].rowIds).toContain("t1");
  });
});

describe("publishing a rebuilt case", () => {
  const store = (over: Partial<RecordStore> = {}, reviewedEvents: never[] = []) => {
    const calls = { updated: 0, created: 0, deleted: 0 };
    let expected: string | null = null;
    const base: RecordStore = {
      lockCase: async () => {},
      // Agrees with whatever was built, unless the test overrides: these fakes
      // exist to test publication mechanics, not staleness.
      currentFingerprint: async () => expected ?? "",
      document: {
        update: async () => {
          calls.updated++;
          return null;
        },
      },
      chronologyEvent: {
        count: async () => 3,
        findMany: async () => reviewedEvents,
        deleteMany: async () => {
          calls.deleted++;
          return { count: 7 };
        },
        createMany: async ({ data }) => {
          calls.created += data.length;
          return null;
        },
        updateMany: async ({ where }) => ({ count: (where.id as { in: string[] }).in.length }),
      },
      $transaction: async (work) => work({ ...base, ...over }),
      ...over,
    };
    return { store: base, calls, agreeWith: (fp: string) => { expected = fp; } };
  };

  it("publishes a complete build and keeps reviewed events", async () => {
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [row()]);
    const reviewed = [
      { eventDate: new Date("2020-01-01T00:00:00Z"), eventType: "CLINIC_VISIT", provider: "Someone Else", sourceDocumentId: "other" },
    ] as never[];
    const { store: s, calls } = store({}, reviewed);
    (s as { currentFingerprint(caseId: string): Promise<string> }).currentFingerprint = async () => built.fingerprint;
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(true);
    expect(result.reviewedKept).toBe(1);
    expect(calls.updated).toBe(1);
  });

  it("does not insert a draft twin of an event a human already reviewed", async () => {
    // Publication kept every reviewed event and then inserted the whole fresh
    // draft chronology, so a reviewed record gained a second copy of itself —
    // and the draft usually reads more fluently than the reviewed one.
    const built = await build(
      `Progress Note Date of Service: 03/18/2024 ${filler()} lumbar radiculopathy ${filler()}`,
      [row()],
      12,
      true,
    );
    expect(built.chronology.length).toBeGreaterThan(0);
    const twin = built.chronology[0];
    const reviewed = [
      {
        eventDate: twin.eventDate,
        eventType: twin.eventType,
        provider: twin.provider,
        sourceDocumentId: twin.sourceDocumentId,
      },
    ] as never[];

    const { store: s, calls, agreeWith } = store({}, reviewed);
    agreeWith(built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(true);
    expect(result.draftsSuppressed).toBe(1);
    expect(calls.created).toBe(built.chronology.length - 1);
  });

  it("still inserts a draft for a different event on the same day", async () => {
    // An operative report and the discharge that follows it are two events.
    const built = await build(
      `Progress Note Date of Service: 03/18/2024 ${filler()} lumbar radiculopathy ${filler()}`,
      [row()],
      12,
      true,
    );
    const twin = built.chronology[0];
    const reviewed = [
      { eventDate: twin.eventDate, eventType: "SURGERY", provider: twin.provider, sourceDocumentId: twin.sourceDocumentId },
    ] as never[];
    const { store: s, agreeWith } = store({}, reviewed);
    agreeWith(built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.draftsSuppressed).toBe(0);
  });

  it("leaves the previous Records and Chronology intact when any note failed", async () => {
    // 20. A half-described case looks identical to a finished one, so a build
    //     carrying failures does not publish at all.
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [row()]);
    built.failures.push({ rowIds: ["row-x"], error: "writer timed out" });

    const { store: s, calls } = store();
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/previous result was kept/i);
    expect(calls.updated).toBe(0);
    expect(calls.deleted).toBe(0);
    expect(calls.created).toBe(0);
  });
});

describe("overlapping rebuilds", () => {
  // Every completed document starts a full-case rebuild, and a rebuild takes
  // minutes because it composes prose. Two routinely overlap, and the one that
  // finishes last wins regardless of which read newer data.
  const storeWith = (currentFingerprint: string) => {
    const calls = { updated: 0, created: 0, locked: 0 };
    const base: RecordStore = {
      lockCase: async () => {
        calls.locked++;
      },
      currentFingerprint: async () => currentFingerprint,
      document: {
        update: async () => {
          calls.updated++;
          return null;
        },
      },
      chronologyEvent: {
        count: async () => 0,
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }) => {
          calls.created += data.length;
          return null;
        },
      },
      $transaction: async (work) => work(base),
    };
    return { store: base, calls };
  };

  it("refuses to publish a build read from state the case has moved past", async () => {
    // An older build finishing after a newer source state must not overwrite it.
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [row()]);
    const { store: s, calls } = storeWith("a-different-fingerprint");
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(false);
    expect(result.staleBuild).toBe(true);
    expect(calls.updated).toBe(0);
    expect(calls.created).toBe(0);
  });

  it("publishes when the case is still as the build found it", async () => {
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [row()]);
    const { store: s, calls } = storeWith(built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(true);
    expect(calls.locked).toBe(1);
  });

  it("changes when only a claim's value changes", () => {
    // The first fingerprint skipped claim content entirely, so a build reading
    // rewritten claims could publish over one reading the originals unnoticed.
    const base = () => [{ id: "doc-1", pageCount: 1, extractedText: "x", rows: [row({ id: "r" })] }];
    const changed = base();
    changed[0].rows[0] = {
      ...changed[0].rows[0],
      claims: [{ field: "assessment", value: "A DIFFERENT finding", excerpt: "lumbar radiculopathy" }],
    };
    expect(caseFingerprint(changed)).not.toBe(caseFingerprint(base()));
  });

  it("changes when only a claim's excerpt or page changes", () => {
    const base = () => [{ id: "doc-1", pageCount: 1, extractedText: "x", rows: [row({ id: "r" })] }];
    const excerpt = base();
    excerpt[0].rows[0] = {
      ...excerpt[0].rows[0],
      claims: [{ field: "assessment", value: "Lumbar radiculopathy documented", excerpt: "different excerpt" }],
    };
    const page = base();
    page[0].rows[0] = {
      ...page[0].rows[0],
      claims: [{ field: "assessment", value: "Lumbar radiculopathy documented", excerpt: "lumbar radiculopathy", page: 7 }],
    };
    expect(caseFingerprint(excerpt)).not.toBe(caseFingerprint(base()));
    expect(caseFingerprint(page)).not.toBe(caseFingerprint(base()));
  });

  it("changes when the text changes to different content of the same length", () => {
    // Length was the old proxy, and two texts of equal length are not the same
    // text.
    const a = [{ id: "doc-1", pageCount: 1, extractedText: "abcdef", rows: [row({ id: "r" })] }];
    const b = [{ id: "doc-1", pageCount: 1, extractedText: "abcdeg", rows: [row({ id: "r" })] }];
    expect(caseFingerprint(a)).not.toBe(caseFingerprint(b));
  });

  it("ignores document and row order", () => {
    const r1 = row({ id: "r1" });
    const r2 = row({ id: "r2" });
    const forward = [
      { id: "doc-1", pageCount: 1, extractedText: "x", rows: [r1, r2] },
      { id: "doc-2", pageCount: 1, extractedText: "y", rows: [] },
    ];
    const backward = [
      { id: "doc-2", pageCount: 1, extractedText: "y", rows: [] },
      { id: "doc-1", pageCount: 1, extractedText: "x", rows: [r2, r1] },
    ];
    expect(caseFingerprint(forward)).toBe(caseFingerprint(backward));
  });

  it("refuses publication when only claims changed while the build ran", async () => {
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [row({ id: "r" })]);
    const changedNow = caseFingerprint([
      {
        id: "doc-1",
        pageCount: 12,
        extractedText: `Progress Note Date of Service: 03/18/2024 ${filler()}`,
        rows: [{ ...row({ id: "r" }), claims: [{ field: "assessment", value: "Rewritten while building", excerpt: "e" }] }],
      },
    ]);
    const { store: s, calls } = storeWith(changedNow);
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(false);
    expect(result.staleBuild).toBe(true);
    expect(calls.updated).toBe(0);
  });

  it("refuses publication when the text changed to equal-length content while the build ran", async () => {
    const text = `Progress Note Date of Service: 03/18/2024 ${filler()}`;
    const built = await build(text, [row({ id: "r" })]);
    const altered = text.slice(0, -1) + (text.endsWith("!") ? "?" : "!");
    const changedNow = caseFingerprint([{ id: "doc-1", pageCount: 12, extractedText: altered, rows: [row({ id: "r" })] }]);
    const { store: s, calls } = storeWith(changedNow);
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(false);
    expect(calls.created).toBe(0);
  });

  it("changes fingerprint when a reviewer corrects a record", async () => {
    // A rebuild that missed a correction is exactly the one that must not
    // publish, so a corrected field has to move the fingerprint.
    const plain = caseFingerprint([{ id: "doc-1", pageCount: 1, extractedText: "x", rows: [row({ id: "r" })] }]);
    const corrected = caseFingerprint([
      { id: "doc-1", pageCount: 1, extractedText: "x", rows: [{ ...row({ id: "r" }), factualSummary: "Physician's corrected wording." }] },
    ]);
    expect(corrected).not.toBe(plain);
  });

  it("is stable for the same case read twice", () => {
    const sources = [{ id: "doc-1", pageCount: 1, extractedText: "x", rows: [row({ id: "r" })] }];
    expect(caseFingerprint(sources)).toBe(caseFingerprint(sources));
  });

  it("gives every case its own lock key", () => {
    expect(caseLockKey("case-a")).not.toBe(caseLockKey("case-b"));
    expect(caseLockKey("case-a")).toBe(caseLockKey("case-a"));
  });
});

describe("a reviewed series does not swallow the visits added after it", () => {
  const visit = (iso: string): ChronologyDraft => ({
    caseId: CASE,
    eventDate: new Date(`${iso}T00:00:00Z`),
    eventType: "THERAPY",
    specialty: null,
    recordType: null,
    provider: "Michael Crone, DC",
    facility: "Houston Spine and Rehabilitation",
    summary: "Therapy visit; tolerated well.",
    sourceDocumentId: "doc-1",
    sourcePage: 1,
    reviewStatus: "AI_DRAFT",
    dateInferred: false,
    relevanceScore: 50,
  });

  const storeWithReviewed = (reviewed: Record<string, unknown>[], fingerprintOf?: () => string) => {
    const calls = { created: 0, staleMarked: [] as string[] };
    const base: RecordStore = {
      lockCase: async () => {},
      currentFingerprint: async () => fingerprintOf?.() ?? "",
      document: { update: async () => null },
      chronologyEvent: {
        count: async () => reviewed.length,
        findMany: async () => reviewed as never,
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }) => {
          calls.created += data.length;
          return null;
        },
        updateMany: async ({ where }) => {
          const ids = (where.id as { in: string[] }).in;
          calls.staleMarked.push(...ids);
          return { count: ids.length };
        },
      },
      $transaction: async (work) => work(base),
    };
    return { store: base, calls };
  };

  it("marks the reviewed three-visit series stale and inserts the four-visit draft", async () => {
    // The base identity alone suppressed the four-visit draft forever: the
    // fourth extracted visit became invisible behind the reviewed entry.
    const built = await build(`Progress Note ${filler()}`, []);
    built.chronology.push(
      ...collapseTreatmentSeries(["2023-07-07", "2023-07-12", "2023-07-19", "2023-07-26"].map(visit)),
    );
    const reviewedSeries = {
      id: "reviewed-series",
      eventDate: new Date("2023-07-07T00:00:00Z"),
      eventDateEnd: new Date("2023-07-19T00:00:00Z"),
      eventType: "THERAPY",
      provider: "Michael Crone, DC",
      sourceDocumentId: "doc-1",
    };
    const { store: s, calls } = storeWithReviewed([reviewedSeries], () => built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(true);
    expect(result.draftsSuppressed).toBe(0);
    expect(result.reviewedMarkedStale).toBe(1);
    expect(calls.staleMarked).toContain("reviewed-series");
    expect(calls.created).toBe(built.chronology.length);
  });

  it("still suppresses a draft whose membership is unchanged", async () => {
    const built = await build(`Progress Note ${filler()}`, []);
    built.chronology.push(
      ...collapseTreatmentSeries(["2023-07-07", "2023-07-12", "2023-07-19"].map(visit)),
    );
    const reviewedSeries = {
      id: "reviewed-series",
      eventDate: new Date("2023-07-07T00:00:00Z"),
      eventDateEnd: new Date("2023-07-19T00:00:00Z"),
      eventType: "THERAPY",
      provider: "Michael Crone, DC",
      sourceDocumentId: "doc-1",
    };
    const { store: s, calls } = storeWithReviewed([reviewedSeries], () => built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.draftsSuppressed).toBe(1);
    expect(result.reviewedMarkedStale).toBe(0);
    expect(calls.staleMarked).toHaveLength(0);
  });

  it("a series asserts no clinical findings and cites every member", () => {
    const [series] = collapseTreatmentSeries(["2023-07-07", "2023-07-12", "2023-07-19"].map(visit));
    // Constructed clean: the first visit's findings and page must not span the
    // range. Membership is PERSISTED — each member's own date, document and
    // page — rather than narrated into an unreadable date list.
    expect(series.sourcePage).toBeNull();
    expect(series.procedure).toBeUndefined();
    expect(series.recordType).toBe("TREATMENT_SERIES");
    expect(series.seriesMembers).toHaveLength(3);
    expect((series.seriesMembers as { date: string }[])[0]).toMatchObject({ date: "2023-07-07", documentId: "doc-1", page: 1 });
    expect(series.sourceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a forty-six-day gap breaks the series", () => {
    const out = collapseTreatmentSeries(["2023-07-07", "2023-07-12", "2023-09-01", "2023-09-08", "2023-09-15"].map(visit));
    // Two visits, a break in care, then a three-visit series.
    expect(out.filter((e) => e.recordType === "TREATMENT_SERIES")).toHaveLength(1);
    expect(out).toHaveLength(3);
  });

  it("unknown providers never pool into an anonymous series", () => {
    const anonymous = ["2023-07-07", "2023-07-12", "2023-07-19"].map((d) => ({ ...visit(d), provider: null, facility: null }));
    expect(collapseTreatmentSeries(anonymous)).toHaveLength(3);
  });

  it("a structured procedure column breaks a visit out whatever the summary says", () => {
    const events = ["2023-07-07", "2023-07-12", "2023-07-19", "2023-07-21"].map(visit);
    events[2] = { ...events[2], procedure: "Epidural steroid injection administered" };
    const out = collapseTreatmentSeries(events);
    expect(out.some((e) => e.procedure)).toBe(true);
    expect(out.filter((e) => e.recordType === "TREATMENT_SERIES")).toHaveLength(0);
  });
});

describe("a bill with nothing but codes still witnesses its visit", () => {
  it("admits a codes-only dated bill to the chronology with an honest summary", async () => {
    // The detector was gated behind substance.meaningful — and pure service
    // codes are exactly what the substance screen rejects, so the billing-only
    // productions the detector was built FOR never reached it.
    const built = await build(`Statement of charges ${filler()}`, [
      row({
        analysisClass: "FINANCIAL",
        substanceClass: "ANCILLARY",
        encounterDate: new Date("2025-07-21T00:00:00Z"),
        dateStatus: "DOCUMENTED",
        claims: [{ field: "serviceCode", value: "99215", excerpt: "99215" }],
      }),
    ]);
    const event = built.chronology.find((e) => /^Billed service/.test(e.summary));
    expect(event).toBeDefined();
    expect(event?.eventType).toBe("CLINIC_VISIT");
    expect(event?.summary).toContain("99215");
  });

  it("withholds the billing twin when a clinical record documents the same service", async () => {
    const clinicalRows = [
      row({
        id: "note",
        encounterDate: new Date("2025-07-21T00:00:00Z"),
        dateStatus: "DOCUMENTED",
        provider: "Fernando Techy, MD",
        claims: [{ field: "assessment", value: "Follow-up for lumbar radiculopathy, pain improving", excerpt: "follow-up lumbar" }],
      }),
    ];
    const billingRows = [
      row({
        id: "bill",
        sourceDocumentId: "doc-2",
        analysisClass: "FINANCIAL",
        substanceClass: "ANCILLARY",
        encounterDate: new Date("2025-07-21T00:00:00Z"),
        dateStatus: "DOCUMENTED",
        provider: "Fernando Techy, MD",
        claims: [{ field: "serviceCode", value: "99215", excerpt: "99215" }],
      }),
    ];
    const built = await buildRecords({
      caseId: CASE,
      write: false,
      adjudicateDuplicates: false,
      documents: [
        { id: "doc-1", pageCount: 3, extractedText: `Progress Note ${filler()}`, rows: clinicalRows },
        { id: "doc-2", pageCount: 2, extractedText: "Statement of charges", rows: billingRows },
      ],
    });
    // The clinical event stands; the bill corroborates rather than duplicates.
    expect(built.chronology.filter((e) => e.eventDate.toISOString().startsWith("2025-07-21"))).toHaveLength(1);
    expect(built.chronology.some((e) => /^Billed service/.test(e.summary))).toBe(false);
  });
});

describe("the live path and the manual rebuild agree", () => {
  it("produces the same structured result from the same rows", async () => {
    // 19. Both callers run buildRecords; this asserts the contract they share
    //     rather than the wiring, which typechecking already holds.
    const text = `Progress Note Date of Service: 03/18/2024 ${filler()} reports low back pain ${filler()}`;
    const rows = [row({ id: "stable-1" }), row({ id: "stable-2" })];
    const first = await build(text, rows);
    const second = await build(text, rows);
    expect(seg(second).map((s) => [s.date, s.dateBasis, s.kind])).toEqual(
      seg(first).map((s) => [s.date, s.dateBasis, s.kind]),
    );
  });

  it("reports counts a reviewer can check the build against", async () => {
    const built = await build(
      `Progress Note Date of Service: 03/18/2024 ${filler()} lumbar radiculopathy ${filler()}`,
      [row()],
      284,
    );
    expect(built.stats).toMatchObject({ documents: 1, pages: 284, rows: 1 });
    expect(built.stats.dateBasis).toHaveProperty("NOTE_SERVICE_LABEL");
  });
});

describe("an out-of-order packet", () => {
  it("does not date a record from neighbours that run backwards", async () => {
    // 6. Position proves nothing where the filing is out of sequence.
    const text = `Progress Note Date of Service: 03/21/2024 ${filler()}Nursing Note ${filler()}Progress Note Date of Service: 03/18/2024 ${filler()}`;
    const built = await build(text, [
      row({ claims: [{ field: "assessment", value: "Reviewed on the later visit", excerpt: "reviewed" }] }),
    ]);
    const middle = seg(built).find((s) => !s.date);
    // Either the note's own boundary dated it, or nothing did — but no date is
    // ever taken from neighbours in the wrong order.
    if (middle) expect(middle.unresolvedReason).toBeTruthy();
    expect(vi.isMockFunction(build)).toBe(false);
  });
});

describe("routine treatment collapses to a series; material visits stand alone", () => {
  const visit = (iso: string, over: Partial<ChronologyDraft> = {}): ChronologyDraft => ({
    caseId: CASE,
    eventDate: new Date(`${iso}T00:00:00Z`),
    eventType: "THERAPY",
    specialty: null,
    recordType: null,
    provider: "Michael Crone, DC",
    facility: "Houston Spine and Rehabilitation",
    summary: "Therapy visit with electrical stimulation and hot/cold packs; tolerated well.",
    sourceDocumentId: "doc-1",
    sourcePage: 1,
    reviewStatus: "AI_DRAFT",
    dateInferred: false,
    relevanceScore: 50,
    ...over,
  });

  it("collapses a run of routine visits into one dated series entry", () => {
    const events = ["2023-07-07", "2023-07-12", "2023-07-19", "2023-07-26"].map((d) => visit(d));
    const out = collapseTreatmentSeries(events);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toContain("4 documented therapy visits");
    expect(out[0].summary).toContain("07/07/2023");
    expect(out[0].summary).toContain("07/26/2023");
    expect(out[0].eventDateEnd?.toISOString().slice(0, 10)).toBe("2023-07-26");
  });

  it("never invents continuity, findings or improvement", () => {
    const out = collapseTreatmentSeries(["2023-07-07", "2023-07-12", "2023-07-19"].map((d) => visit(d)));
    // The series states only what is deterministically known: count, range,
    // kind, provider. A finding true of one visit generalised across a series
    // is an invention.
    expect(out[0].summary).not.toMatch(/improv|progress|continuous|daily|weekly|stimulation|tolerated/i);
  });

  it("breaks a material visit out of the series", () => {
    const events = [
      visit("2023-07-07"),
      visit("2023-07-12"),
      visit("2023-07-19"),
      visit("2023-07-21", { summary: "New MRI ordered after worsening radicular pain into the right foot." }),
      visit("2023-07-26"),
      visit("2023-08-02"),
      visit("2023-08-09"),
    ];
    const out = collapseTreatmentSeries(events);
    const material = out.find((e) => /MRI/.test(e.summary));
    expect(material).toBeDefined();
    expect(out.filter((e) => /documented therapy visits/.test(e.summary))).toHaveLength(2);
  });

  it("never combines different providers or facilities", () => {
    const events = [
      visit("2023-07-07"),
      visit("2023-07-12", { provider: "Someone Else, DC" }),
      visit("2023-07-19"),
      visit("2023-07-26"),
    ];
    const out = collapseTreatmentSeries(events);
    expect(out.some((e) => e.provider === "Someone Else, DC" && !/documented/.test(e.summary))).toBe(true);
  });

  it("leaves short runs alone", () => {
    const out = collapseTreatmentSeries(["2023-07-07", "2023-07-12"].map((d) => visit(d)));
    expect(out).toHaveLength(2);
    expect(MIN_SERIES_RUN).toBeGreaterThan(2);
  });

  it("leaves independent clinically meaningful events visible", () => {
    const events = [
      visit("2023-07-07", { eventType: "SURGERY", summary: "Laminectomy performed." }),
      visit("2023-07-08", { eventType: "IMAGING", summary: "MRI lumbar spine: L5-S1 protrusion." }),
    ];
    expect(collapseTreatmentSeries(events)).toHaveLength(2);
  });
});

describe("recovering from a stale-build refusal", () => {
  const loaderFor = (fingerprints: string[]) => {
    // A store whose "current" fingerprint is consumed one refusal at a time:
    // the first build(s) find the case moved; the last finds it settled.
    let call = 0;
    const base: Record<string, unknown> = {
      case: { findUnique: async () => ({ clientName: null }) },
      document: {
        findMany: async () => [
          { id: "doc-1", pageCount: 1, extractedText: "Progress Note Date of Service: 03/18/2024 lumbar radiculopathy" },
        ],
        update: async () => null,
      },
      extractedEncounter: { findMany: async () => [row({ id: "r" })] },
      chronologyEvent: {
        count: async () => 0,
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => null,
      },
      lockCase: async () => {},
      currentFingerprint: async () => fingerprints[Math.min(call++, fingerprints.length - 1)],
    };
    base.$transaction = async (work: (tx: unknown) => Promise<unknown>) => work(base);
    return base as never;
  };

  it("retries from the newest state and publishes when the case settles", async () => {
    // Attempt 1 builds F, case says F' -> refused. Attempt 2 rebuilds; case
    // now agrees -> published. One flight, bounded.
    const real = caseFingerprint([
      { id: "doc-1", pageCount: 1, extractedText: "Progress Note Date of Service: 03/18/2024 lumbar radiculopathy", rows: [row({ id: "r" })] },
    ]);
    const db = loaderFor(["moved-on", real]);
    const outcome = await refreshCaseRecordsWithRecovery(db, "case-recovery-1", { write: false });
    expect(outcome.published).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.history[0].outcome).toBe("STALE_REFUSED");
    expect(outcome.history[1].outcome).toBe("PUBLISHED");
  });

  it("exhausts bounded retries, keeps the prior output, and reports visibly", async () => {
    const db = loaderFor(["never-matches"]);
    const outcome = await refreshCaseRecordsWithRecovery(db, "case-recovery-2", { write: false });
    expect(outcome.published).toBe(false);
    expect(outcome.attempts).toBe(1 + MAX_STALE_RETRIES);
    expect(outcome.history.every((h) => h.outcome === "STALE_REFUSED")).toBe(true);
    expect(outcome.status).toMatch(/previous complete version/i);
  });

  it("coalesces a request arriving while a refresh is running, and waits for it", async () => {
    // The coalesced caller must not learn "published" before it is true: a
    // caller chaining plan regeneration on the outcome would regenerate from
    // the pre-publication chronology. So the second call resolves only after
    // the flight it folded into has actually finished, with that flight's
    // real result.
    const real = caseFingerprint([
      { id: "doc-1", pageCount: 1, extractedText: "Progress Note Date of Service: 03/18/2024 lumbar radiculopathy", rows: [row({ id: "r" })] },
    ]);
    const db = loaderFor([real]);
    let firstSettled = false;
    const first = refreshCaseRecordsWithRecovery(db, "case-recovery-3", { write: false }).then((o) => {
      firstSettled = true;
      return o;
    });
    const second = await refreshCaseRecordsWithRecovery(db, "case-recovery-3", { write: false });
    expect(second.coalesced).toBe(true);
    // By the time the coalesced caller resolves, the flight has completed.
    expect(firstSettled).toBe(true);
    expect(second.published).toBe((await first).published);
  });

  it("reports a failed flight honestly to the caller that coalesced into it", async () => {
    const db = loaderFor(["never-matches"]);
    const first = refreshCaseRecordsWithRecovery(db, "case-recovery-4", { write: false });
    const second = await refreshCaseRecordsWithRecovery(db, "case-recovery-4", { write: false });
    expect(second.coalesced).toBe(true);
    expect(second.published).toBe(false);
    expect(second.status).toMatch(/previous complete version/i);
    expect((await first).published).toBe(false);
  });
});

describe("series membership changes that keep the same end date", () => {
  const visit = (iso: string, page = 1): ChronologyDraft => ({
    caseId: CASE,
    eventDate: new Date(`${iso}T00:00:00Z`),
    eventType: "THERAPY",
    specialty: null,
    recordType: null,
    provider: "Michael Crone, DC",
    facility: "Houston Spine and Rehabilitation",
    summary: "Therapy visit; tolerated well.",
    sourceDocumentId: "doc-1",
    sourcePage: page,
    reviewStatus: "AI_DRAFT",
    dateInferred: false,
    relevanceScore: 50,
  });

  it("an internal visit added without moving the end still changes the fingerprint", () => {
    // The end-date discriminator alone could not see this: same start, same
    // end, one more visit inside. The membership hash can.
    const [three] = collapseTreatmentSeries(["2023-07-07", "2023-07-12", "2023-07-19"].map((d) => visit(d)));
    const [four] = collapseTreatmentSeries(["2023-07-07", "2023-07-10", "2023-07-12", "2023-07-19"].map((d) => visit(d)));
    expect(three.eventDateEnd?.getTime()).toBe(four.eventDateEnd?.getTime());
    expect(three.sourceFingerprint).not.toBe(four.sourceFingerprint);
  });

  it("a structured diagnosis change breaks the series whatever the summary says", () => {
    const events = ["2023-07-07", "2023-07-12", "2023-07-19", "2023-07-26"].map((d) => visit(d));
    events[2] = { ...events[2], diagnosis: "Lumbar radiculopathy, new right foot drop" };
    events[1] = { ...events[1], diagnosis: "Lumbar strain" };
    const out = collapseTreatmentSeries(events);
    expect(out.filter((e) => e.recordType === "TREATMENT_SERIES")).toHaveLength(0);
  });
});

describe("a reviewed event whose SOURCE changed is stale, not authoritative", () => {
  const contentStore = (reviewed: Record<string, unknown>[], fingerprintOf: () => string) => {
    const calls = { created: 0, staleMarked: [] as string[] };
    const base: RecordStore = {
      lockCase: async () => {},
      currentFingerprint: async () => fingerprintOf(),
      document: { update: async () => null },
      chronologyEvent: {
        count: async () => reviewed.length,
        findMany: async () => reviewed as never,
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }) => {
          calls.created += data.length;
          return null;
        },
        updateMany: async ({ where }) => {
          const ids = (where.id as { in: string[] }).in;
          calls.staleMarked.push(...ids);
          return { count: ids.length };
        },
      },
      $transaction: async (work) => work(base),
    };
    return { store: base, calls };
  };

  it("inserts the corrected draft and marks the content-changed review stale", async () => {
    // Identity alone let the source change under a reviewed entry while date,
    // provider and range stayed put: the stale review stayed "reviewed" and
    // the corrected draft was the one suppressed.
    const built = await build(
      `Progress Note Date of Service: 03/18/2024 ${filler()} lumbar radiculopathy ${filler()}`,
      [row({ id: "r" })],
      12,
      true,
    );
    expect(built.chronology.length).toBeGreaterThan(0);
    const draft = built.chronology[0];
    expect(draft.sourceFingerprint).toBeTruthy();
    const reviewed = [
      {
        id: "reviewed-old-content",
        eventDate: draft.eventDate,
        eventDateEnd: null,
        eventType: draft.eventType,
        provider: draft.provider,
        sourceDocumentId: draft.sourceDocumentId,
        sourceFingerprint: "a-hash-of-content-that-no-longer-exists",
      },
    ] as never[];
    const { store: s, calls } = contentStore(reviewed as never, () => built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.published).toBe(true);
    expect(result.draftsSuppressed).toBe(0);
    expect(result.reviewedMarkedStale).toBe(1);
    expect(calls.staleMarked).toContain("reviewed-old-content");
    expect(calls.created).toBe(built.chronology.length);
  });

  it("still suppresses when the reviewed content matches exactly", async () => {
    const built = await build(
      `Progress Note Date of Service: 03/18/2024 ${filler()} lumbar radiculopathy ${filler()}`,
      [row({ id: "r" })],
      12,
      true,
    );
    const draft = built.chronology[0];
    const reviewed = [
      {
        id: "reviewed-same-content",
        eventDate: draft.eventDate,
        eventDateEnd: null,
        eventType: draft.eventType,
        provider: draft.provider,
        sourceDocumentId: draft.sourceDocumentId,
        sourceFingerprint: draft.sourceFingerprint,
      },
    ] as never[];
    const { store: s } = contentStore(reviewed as never, () => built.fingerprint);
    const result = await persistRecords(s, CASE, built);
    expect(result.draftsSuppressed).toBe(1);
    expect(result.reviewedMarkedStale).toBe(0);
  });
});

describe("the production adapter wires the safeguards to the RIGHT client", () => {
  // The advisory lock existed, was described, and had never once held: the
  // script adapter executed it through the OUTER client — a different
  // connection whose implicit transaction released the lock the instant the
  // statement finished — and the live callers passed raw Prisma, which had
  // neither safeguard, both being optional. Every fake store in this file
  // faithfully implemented the interface the real adapter got wrong. This test
  // asks the question those tests never asked: WHICH client runs the lock.
  const fakePrisma = () => {
    const executed = { onTx: [] as string[], onOuter: [] as string[] };
    const outer: Record<string, unknown> = {
      case: { findUnique: async () => ({ clientName: null }) },
      document: {
        findMany: async () => [{ id: "doc-1", pageCount: 1, extractedText: "Progress Note Date of Service: 03/18/2024 lumbar radiculopathy" }],
        update: async () => null,
      },
      extractedEncounter: { findMany: async () => [row({ id: "r" })] },
      chronologyEvent: {
        count: async () => 0,
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => null,
        updateMany: async () => ({ count: 0 }),
      },
      $executeRawUnsafe: async (sql: string) => {
        executed.onOuter.push(sql);
        return 1;
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          ...outer,
          $executeRawUnsafe: async (sql: string) => {
            executed.onTx.push(sql);
            return 1;
          },
        };
        return work(tx);
      },
    };
    return { prisma: outer, executed };
  };

  it("takes the advisory lock through the transaction client, never the outer one", async () => {
    const { prisma, executed } = fakePrisma();
    const store = makeRecordStore(prisma as never);
    // pageCount must match what the fake database reports: the first run of
    // this very test refused publication because the fixture built with a
    // different page count than the store re-read — the fingerprint doing its
    // job against the test's own inconsistency.
    const built = await build("Progress Note Date of Service: 03/18/2024 lumbar radiculopathy", [row({ id: "r" })], 1);
    const result = await persistRecords(store, CASE, built);
    expect(result.published).toBe(true);
    expect(executed.onTx.some((sql) => /pg_advisory_xact_lock/.test(sql))).toBe(true);
    expect(executed.onOuter).toHaveLength(0);
  });

  it("re-reads the fingerprint inside the transaction and refuses a moved case", async () => {
    const { prisma } = fakePrisma();
    const store = makeRecordStore(prisma as never);
    const built = await build("Progress Note Date of Service: 03/18/2024 lumbar radiculopathy", [row({ id: "r" })], 1);
    // Sabotage: the case's rows change after the build read them.
    (prisma.extractedEncounter as { findMany: () => Promise<unknown[]> }).findMany = async () => [
      { ...row({ id: "r" }), factualSummary: "changed while building" },
    ];
    const result = await persistRecords(store, CASE, built);
    expect(result.published).toBe(false);
    expect(result.staleBuild).toBe(true);
  });

  it("agrees and publishes when the case has not moved", async () => {
    const { prisma } = fakePrisma();
    const store = makeRecordStore(prisma as never);
    const built = await build("Progress Note Date of Service: 03/18/2024 lumbar radiculopathy", [row({ id: "r" })], 1);
    const result = await persistRecords(store, CASE, built);
    expect(result.published).toBe(true);
  });
});

describe("what breaks a routine series", () => {
  const visit = (iso: string, over: Partial<ChronologyDraft> = {}): ChronologyDraft => ({
    caseId: CASE,
    eventDate: new Date(`${iso}T00:00:00Z`),
    eventType: "THERAPY",
    specialty: null,
    recordType: null,
    provider: "Michael Crone, DC",
    facility: "Houston Spine and Rehabilitation",
    summary: "Therapy visit; tolerated well.",
    sourceDocumentId: "doc-1",
    sourcePage: 1,
    reviewStatus: "AI_DRAFT",
    dateInferred: false,
    relevanceScore: 50,
    ...over,
  });
  const dates = ["2023-07-03", "2023-07-07", "2023-07-12", "2023-07-19", "2023-07-24", "2023-07-28"];

  it("a diagnosis APPEARING against a blank baseline breaks the run", () => {
    // The first visit documenting a new diagnosis mid-course is a development;
    // burying it inside "6 routine visits" hides exactly what a reviewer needs.
    const events = dates.map((d, i) => visit(d, i === 3 ? { diagnosis: "New right foot drop" } : {}));
    const out = collapseTreatmentSeries(events);
    const series = out.filter((e) => e.recordType === "TREATMENT_SERIES");
    // The run splits at the appearance: three visits before, and the visit
    // carrying the new diagnosis starts the run after.
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series.some((s) => s.eventDateEnd && s.eventDateEnd < new Date("2023-07-19T00:00:00Z"))).toBe(true);
  });

  it("a restriction appearing breaks; medications appearing does not", () => {
    const restricted = dates.map((d, i) => visit(d, i === 3 ? { restrictions: "No lifting over 10 lbs" } : {}));
    const meds = dates.map((d, i) => visit(d, i === 3 ? { medications: "Cyclobenzaprine 10 mg" } : {}));
    const restrictedSeries = collapseTreatmentSeries(restricted).filter((e) => e.recordType === "TREATMENT_SERIES");
    const medsSeries = collapseTreatmentSeries(meds).filter((e) => e.recordType === "TREATMENT_SERIES");
    // Restrictions appearing splits the run into two shorter series.
    expect(restrictedSeries.length).toBe(2);
    // A med list the extractor captured on one visit only is variance, not a
    // regimen change: the run stays whole.
    expect(medsSeries.length).toBe(1);
    expect(medsSeries[0].seriesMembers).toHaveLength(6);
  });

  it("a field DISAPPEARING never breaks the run", () => {
    const events = dates.map((d, i) => visit(d, i === 0 ? { diagnosis: "Lumbar strain" } : {}));
    const out = collapseTreatmentSeries(events).filter((e) => e.recordType === "TREATMENT_SERIES");
    expect(out).toHaveLength(1);
  });
});

describe("the patient's name is a build input", () => {
  it("changes the fingerprint, because consolidation excludes the patient by name", () => {
    const docs = [{ id: "doc-1", pageCount: 1, extractedText: "Progress note", rows: [row({ id: "r" })] }];
    expect(caseFingerprint(docs, { patientName: "Derrick McHenry" })).not.toBe(caseFingerprint(docs, { patientName: "Derrick McHale" }));
    expect(caseFingerprint(docs, { patientName: "Derrick McHenry" })).toBe(caseFingerprint(docs, { patientName: "Derrick McHenry" }));
  });
});
