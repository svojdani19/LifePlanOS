import { describe, it, expect } from "vitest";
import {
  defaultMode,
  hasUnresolvedWork,
  taskStatusesOf,
  attentionCount,
  applyFilter,
  toggleTask,
  taskCounts,
  isFilterActive,
  grainCountsOf,
  grainSentence,
  EMPTY_FILTER,
  TASK_STATUSES,
  TASK_LABEL,
  TASK_DEFINITION,
  RECORDS_MODES,
  MODE_LABEL,
  type RecordsDoc,
  type RecordsFilter,
} from "@/lib/records/recordsView";

// ─────────────────────────────────────────────────────────────────────────────
// The Records tab's decisions, pinned.
//
// The binding constraint on this module is that it must not form a SECOND
// OPINION about review state. Every status below is read from a field the
// server already computed; a browser that re-derived "is this clean?" would be
// able to disagree with the batch-confirmation plan, and the reviewer would
// have no way to tell which one was right.
// ─────────────────────────────────────────────────────────────────────────────

const note = (over: Partial<RecordsDoc["notes"] extends readonly (infer N)[] | undefined ? N : never> = {}) =>
  ({ id: "n1", attention: "CLEAN", needsAttention: false, awaitingAttestation: true, status: "AI_DRAFT", dateStatus: "DOCUMENTED", guidance: { kind: "READY" }, findings: [], ...over }) as never;

const doc = (over: Partial<RecordsDoc> = {}): RecordsDoc => ({
  documentId: "d1",
  filename: "records.pdf",
  type: "MEDICAL_RECORD",
  pageCount: 10,
  extraction: { status: "COMPLETE" },
  notes: [note()],
  encounters: [],
  findings: [],
  pageFindings: [],
  ...over,
});

describe("mode selection", () => {
  it("opens the Review Queue when there is unresolved work", () => {
    expect(defaultMode([doc()])).toBe("queue");
  });

  it("opens Documents when nothing is outstanding", () => {
    const done = doc({ notes: [note({ status: "REVIEWED", awaitingAttestation: false })] });
    expect(hasUnresolvedWork([done])).toBe(false);
    expect(defaultMode([done])).toBe("documents");
  });

  it("opens Documents for a case with no documents at all", () => {
    expect(defaultMode([])).toBe("documents");
  });

  // A reviewer who navigated somewhere and pressed reload must land where they
  // were, not be re-routed by a heuristic that happens to disagree.
  it("an explicit request always wins over the heuristic", () => {
    for (const mode of RECORDS_MODES) {
      expect(defaultMode([doc()], mode)).toBe(mode);
    }
  });

  it("ignores an unknown mode rather than rendering nothing", () => {
    expect(defaultMode([doc()], "nonsense")).toBe("queue");
    expect(defaultMode([doc()], "")).toBe("queue");
    expect(defaultMode([doc()], null)).toBe("queue");
  });

  it("names every mode", () => {
    for (const m of RECORDS_MODES) expect(MODE_LABEL[m].length).toBeGreaterThan(0);
  });
});

describe("task status is read from the server's classification, never re-derived", () => {
  it("a clean unsigned note is ready to confirm", () => {
    expect([...taskStatusesOf(doc())]).toEqual(["READY_TO_CONFIRM"]);
  });

  it("an exception needs action and is NOT ready to confirm", () => {
    const s = taskStatusesOf(doc({ notes: [note({ attention: "EXCEPTION", needsAttention: true })] }));
    expect(s.has("NEEDS_ACTION")).toBe(true);
    expect(s.has("READY_TO_CONFIRM")).toBe(false);
  });

  it("a caution is its own status, not an exception", () => {
    const s = taskStatusesOf(doc({ notes: [note({ attention: "CAUTION" })] }));
    expect(s.has("CAUTION")).toBe(true);
    expect(s.has("NEEDS_ACTION")).toBe(false);
    // …and a caution is not ready to confirm either.
    expect(s.has("READY_TO_CONFIRM")).toBe(false);
  });

  it("an already-decided note reads as reviewed", () => {
    for (const status of ["REVIEWED", "VERIFIED", "HUMAN_EDITED"]) {
      const s = taskStatusesOf(doc({ notes: [note({ status, awaitingAttestation: false })] }));
      expect(s.has("REVIEWED"), status).toBe(true);
      expect(s.has("READY_TO_CONFIRM"), status).toBe(false);
    }
  });

  it("an undated clinical entry is flagged undated", () => {
    expect(taskStatusesOf(doc({ notes: [note({ dateStatus: "UNKNOWN" })] })).has("UNDATED")).toBe(true);
  });

  it("failed OCR or extraction is a processing failure", () => {
    for (const status of ["EXTRACTION_FAILED", "BLOCKED_OCR"]) {
      expect(taskStatusesOf(doc({ extraction: { status } })).has("PROCESSING_FAILED"), status).toBe(true);
    }
    expect(taskStatusesOf(doc({ extraction: { status: "COMPLETE" } })).has("PROCESSING_FAILED")).toBe(false);
  });

  it("an open blocking document finding needs action", () => {
    const s = taskStatusesOf(doc({ findings: [{ blocking: true, status: "OPEN" }] }));
    expect(s.has("NEEDS_ACTION")).toBe(true);
  });

  it("a dispositioned finding is not work any more", () => {
    for (const status of ["RESOLVED", "IGNORED", "DISMISSED", "ACCEPTED"]) {
      const s = taskStatusesOf(doc({ findings: [{ blocking: true, status }] }));
      expect(s.has("NEEDS_ACTION"), status).toBe(false);
    }
  });

  it("recognises missing-page and conflict findings by their own kinds", () => {
    const missing = taskStatusesOf(doc({ notes: [note({ guidance: { kind: "MISSING_ENCOUNTER" } })] }));
    expect(missing.has("MISSING_PAGES")).toBe(true);
    const conflict = taskStatusesOf(doc({ notes: [note({ guidance: { kind: "SOURCE_CONFLICT" } })] }));
    expect(conflict.has("SOURCE_CONFLICT")).toBe(true);
  });

  it("a document can carry several statuses at once", () => {
    const s = taskStatusesOf(doc({
      extraction: { status: "COMPLETE" },
      notes: [note({ attention: "EXCEPTION", needsAttention: true, dateStatus: "UNKNOWN" }), note({ id: "n2" })],
    }));
    expect(s.has("NEEDS_ACTION")).toBe(true);
    expect(s.has("UNDATED")).toBe(true);
    expect(s.has("READY_TO_CONFIRM")).toBe(true);
  });

  // Legacy rows have no note projection. Their work must not disappear.
  it("falls back to extraction rows when a document has no notes", () => {
    const legacy = doc({ notes: [], encounters: [{ id: "e1", dateStatus: "UNKNOWN", status: "AI_DRAFT" }] });
    expect(taskStatusesOf(legacy).has("UNDATED")).toBe(true);
  });

  it("names and defines every status", () => {
    for (const t of TASK_STATUSES) {
      expect(TASK_LABEL[t].length).toBeGreaterThan(0);
      expect(TASK_DEFINITION[t].length).toBeGreaterThan(20);
    }
  });
});

describe("attentionCount", () => {
  it("counts notes asking for something plus open blocking findings", () => {
    const d = doc({
      notes: [note({ needsAttention: true }), note({ id: "n2", attention: "EXCEPTION" }), note({ id: "n3" })],
      findings: [{ blocking: true, status: "OPEN" }, { blocking: false, status: "OPEN" }],
    });
    expect(attentionCount(d)).toBe(3);
  });

  it("is zero for a clean document", () => {
    expect(attentionCount(doc())).toBe(0);
  });
});

describe("filters compose predictably", () => {
  const category = (d: RecordsDoc) => (d.type === "BILLING_RECORD" ? "Financial" : "Clinical");
  const docs = [
    doc({ documentId: "a", filename: "a.pdf", notes: [note({ attention: "EXCEPTION", needsAttention: true })] }),
    doc({ documentId: "b", filename: "b.pdf", notes: [note({ dateStatus: "UNKNOWN" })] }),
    doc({ documentId: "c", filename: "c.pdf", type: "BILLING_RECORD" }),
  ];

  it("no filter returns everything", () => {
    expect(applyFilter(docs, EMPTY_FILTER, category)).toHaveLength(3);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("task statuses compose as ANY-of", () => {
    const f = { ...EMPTY_FILTER, tasks: ["NEEDS_ACTION", "UNDATED"] as never };
    expect(applyFilter(docs, f, category).map((d) => d.documentId)).toEqual(["a", "b"]);
  });

  it("category composes as AND with task status", () => {
    const f = { ...EMPTY_FILTER, tasks: ["READY_TO_CONFIRM"] as never, category: "Financial" };
    expect(applyFilter(docs, f, category).map((d) => d.documentId)).toEqual(["c"]);
  });

  it("text search narrows further still", () => {
    const f = { ...EMPTY_FILTER, query: "b.pdf" };
    expect(applyFilter(docs, f, category).map((d) => d.documentId)).toEqual(["b"]);
  });

  it("an impossible combination returns nothing rather than ignoring a filter", () => {
    const f = { ...EMPTY_FILTER, tasks: ["NEEDS_ACTION"] as never, category: "Financial" };
    expect(applyFilter(docs, f, category)).toEqual([]);
  });

  it("toggling a task adds then removes it, leaving the rest alone", () => {
    let f: RecordsFilter = { ...EMPTY_FILTER, category: "Financial", query: "x" };
    f = toggleTask(f, "UNDATED");
    expect(f.tasks).toEqual(["UNDATED"]);
    f = toggleTask(f, "CAUTION");
    expect(f.tasks).toEqual(["UNDATED", "CAUTION"]);
    f = toggleTask(f, "UNDATED");
    expect(f.tasks).toEqual(["CAUTION"]);
    // Untouched.
    expect(f.category).toBe("Financial");
    expect(f.query).toBe("x");
  });

  it("reports whether anything is filtering, so the reset control can say so", () => {
    expect(isFilterActive({ ...EMPTY_FILTER, tasks: ["UNDATED"] as never })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, category: "Financial" })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, query: " " })).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, query: "a" })).toBe(true);
  });

  it("counts each status across the case for the chips", () => {
    const counts = taskCounts(docs);
    expect(counts.NEEDS_ACTION).toBe(1);
    expect(counts.UNDATED).toBe(1);
    expect(counts.READY_TO_CONFIRM).toBe(2);
  });

  // Filtering is a VIEW. It must never be able to lose a record.
  it("every document is reachable from some task filter or from no filter", () => {
    for (const d of docs) {
      expect(applyFilter(docs, EMPTY_FILTER, category)).toContain(d);
    }
  });
});

describe("counting terminology", () => {
  it("counts the three grains separately", () => {
    // `note()` is typed `never` for terseness elsewhere; here the claim count
    // matters, so the fixtures are written out.
    const withClaims = (id: string, claimCount: number) =>
      ({ id, attention: "CLEAN", awaitingAttestation: true, status: "AI_DRAFT", claimCount }) as never;
    const docs = [
      doc({ notes: [withClaims("n1", 4), withClaims("n2", 2)], encounters: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] }),
      doc({ documentId: "d2", notes: [withClaims("n3", 1)], encounters: [{ id: "e4" }] }),
    ];
    expect(grainCountsOf(docs)).toEqual({ encounters: 3, entries: 4, fragments: 7 });
  });

  it("names each grain rather than printing three bare numbers", () => {
    expect(grainSentence({ encounters: 17, entries: 37, fragments: 136 }))
      .toBe("17 encounters assembled from 37 extracted entries and 136 source fragments.");
  });

  it("reads correctly in the singular", () => {
    expect(grainSentence({ encounters: 1, entries: 1, fragments: 1 }))
      .toBe("1 encounter assembled from 1 extracted entry and 1 source fragment.");
  });
});
