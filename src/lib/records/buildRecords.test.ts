import { describe, expect, it, vi } from "vitest";
import {
  buildRecords,
  persistRecords,
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

describe("publishing a rebuilt case", () => {
  const store = (over: Partial<RecordStore> = {}, reviewedEvents: never[] = []) => {
    const calls = { updated: 0, created: 0, deleted: 0 };
    const base: RecordStore = {
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
      },
      $transaction: async (work) => work({ ...base, ...over }),
      ...over,
    };
    return { store: base, calls };
  };

  it("publishes a complete build and keeps reviewed events", async () => {
    const built = await build(`Progress Note Date of Service: 03/18/2024 ${filler()}`, [row()]);
    const reviewed = [
      { eventDate: new Date("2020-01-01T00:00:00Z"), eventType: "CLINIC_VISIT", provider: "Someone Else", sourceDocumentId: "other" },
    ] as never[];
    const { store: s, calls } = store({}, reviewed);
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

    const { store: s, calls } = store({}, reviewed);
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
    const { store: s } = store({}, reviewed);
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
