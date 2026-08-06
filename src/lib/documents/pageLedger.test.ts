// The page ledger is the evidence behind "every page was processed", so its
// states must be honest: an OCR page with no text is UNREADABLE (not blank),
// a document without page boundaries gets no invented page numbers, and case
// completeness is derived from persisted rows rather than assumed.
// Synthetic text only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pageMarks } from "@/lib/documents/meta";

const db = vi.hoisted(() => {
  const state = {
    upserts: [] as { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }[],
    rows: new Map<string, Record<string, unknown>>(),
    docs: [] as { id: string; flags: string | null }[],
    runs: [] as { sourceDocumentId: string; status: string }[],
  };
  const prisma = {
    sourcePage: {
      upsert: async (arg: { where: { sourceDocumentId_pageNumber: { sourceDocumentId: string; pageNumber: number } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        state.upserts.push(arg);
        const k = `${arg.where.sourceDocumentId_pageNumber.sourceDocumentId}#${arg.where.sourceDocumentId_pageNumber.pageNumber}`;
        const existing = state.rows.get(k);
        state.rows.set(k, existing ? { ...existing, ...arg.update } : { ...arg.create });
        return state.rows.get(k);
      },
    },
    document: { findMany: async () => state.docs },
    recordExtraction: { findMany: async () => state.runs },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

import { buildPageLedger, buildPendingPages, persistPageLedger, caseProcessingFacts } from "./pageLedger";

const doc = (over: Record<string, unknown> = {}) => ({
  id: "doc-1",
  firmId: "firm-1",
  caseId: "case-1",
  filename: "synthetic-record.pdf",
  ocrConfidence: null as number | null,
  pageCount: 3,
  ...over,
});

/** ~250 characters of plausible clinical prose — well past the content floor. */
const body = (label: string) =>
  Array.from({ length: 4 }, (_, i) => `${label}: progress note line ${i} documenting the interval course and examination findings.`).join("\n");

const page = (n: number, content: string) => `Page ${n} of 3\n${content}`;
const ledgerFor = (text: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  buildPageLedger({ doc: doc(over), text, marks: pageMarks(text), ...extra });

beforeEach(() => {
  db.state.upserts = [];
  db.state.rows.clear();
  db.state.docs = [];
  db.state.runs = [];
});

describe("page states", () => {
  it("pages carrying text are READABLE, with server-owned tenancy and real offsets", () => {
    const text = [page(1, body("A")), page(2, body("B")), page(3, body("C"))].join("\n");
    const rows = ledgerFor(text);
    expect(rows.map((r) => r.pageNumber)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.status === "READABLE")).toBe(true);
    for (const r of rows) {
      expect(r.firmId).toBe("firm-1");
      expect(r.caseId).toBe("case-1");
      expect(r.sourceDocumentId).toBe("doc-1");
      expect(r.ocrMethod).toBe("NATIVE_TEXT");
      expect(r.ocrConfidence).toBeNull();
      expect(r.offsetEnd).toBeGreaterThan(r.offsetStart);
      expect(text.slice(r.offsetStart, r.offsetEnd)).toBe(r.text);
      expect(r.contentHash).toHaveLength(64);
      expect(r.note).toBeNull();
    }
  });

  it("an empty page in a NATIVE-text document is BLANK — the PDF itself says so", () => {
    const text = [page(1, body("A")), page(2, ""), page(3, body("C"))].join("\n");
    const rows = ledgerFor(text);
    expect(rows[1].status).toBe("BLANK");
    expect(rows[1].note).toMatch(/text layer carries no content/);
  });

  it("an empty page in an OCR'd document is UNREADABLE, never BLANK", () => {
    // OCR failure and a genuinely blank page produce the same nothing; only a
    // human looking at the scan can tell them apart, so the state says so.
    const text = [page(1, body("A")), page(2, ""), page(3, body("C"))].join("\n");
    const rows = ledgerFor(text, { ocrConfidence: 0.95 });
    expect(rows[1].status).toBe("UNREADABLE");
    expect(rows[1].note).toMatch(/may be blank or unreadable/);
    expect(rows[1].ocrMethod).toBe("OCR");
  });

  it("a long page marker is furniture, not content — the page is still empty", () => {
    // "Page 100 of 4212" is 16 characters; counting it as text would make a
    // blank page in a large record look processed.
    const text = ["Page 100 of 4212", page(2, body("B"))].join("\n");
    const rows = ledgerFor(text);
    const p100 = rows.find((r) => r.pageNumber === 100)!;
    expect(p100.status).toBe("BLANK");
  });

  it("pages inside a failed chunk range are FAILED and carry the reason", () => {
    const text = [page(1, body("A")), page(2, body("B")), page(3, body("C"))].join("\n");
    const rows = ledgerFor(text, {}, { failedRanges: [{ pageStart: 2, pageEnd: 3, reason: "provider unavailable after retries" }] });
    expect(rows.map((r) => r.status)).toEqual(["READABLE", "FAILED", "FAILED"]);
    expect(rows[1].note).toMatch(/provider unavailable/);
  });

  it("a failed range with no page bound never poisons pages it cannot name", () => {
    const text = [page(1, body("A")), page(2, body("B"))].join("\n");
    const rows = ledgerFor(text, {}, { failedRanges: [{ pageStart: null, pageEnd: null, reason: "unpaginated section" }] });
    expect(rows.every((r) => r.status === "READABLE")).toBe(true);
  });

  it("a repeated page is DUPLICATE and names the page it repeats", () => {
    const repeated = body("A");
    const text = [page(1, repeated), page(2, body("B")), page(3, repeated)].join("\n");
    const rows = ledgerFor(text);
    expect(rows[2].status).toBe("DUPLICATE");
    expect(rows[2].note).toMatch(/identical to page 1/);
    expect(rows[0].status).toBe("READABLE"); // the first occurrence is the real one
  });

  it("low OCR confidence marks pages for verification against the scan", () => {
    const text = [page(1, body("A")), page(2, body("B"))].join("\n");
    const rows = ledgerFor(text, { ocrConfidence: 0.42 });
    expect(rows.every((r) => r.status === "LOW_CONFIDENCE")).toBe(true);
    expect(rows[0].note).toMatch(/42%/);
    expect(rows[0].ocrConfidence).toBe(0.42);
  });

  it("a clipped source flags only the last page as truncated", () => {
    const text = [page(1, body("A")), page(2, body("B"))].join("\n");
    const rows = ledgerFor(text, {}, { sourceClipped: true });
    expect(rows.map((r) => r.truncated)).toEqual([false, true]);
  });

  it("a document without page boundaries gets NO rows — page numbers are never invented", () => {
    const rows = buildPageLedger({ doc: doc(), text: body("A"), marks: [], failedRanges: [] });
    expect(rows).toEqual([]);
  });

  it("text before the first marker belongs to that marker's page, not a phantom page 0", () => {
    const text = [body("preamble"), page(1, body("A")), page(2, body("B"))].join("\n");
    const rows = ledgerFor(text);
    expect(rows.map((r) => r.pageNumber)).toEqual([1, 2]);
    expect(rows[0].offsetStart).toBe(0);
  });
});

describe("documents awaiting OCR", () => {
  it("pending and failed OCR produce one honest row per known page", () => {
    const pending = buildPendingPages(doc({ pageCount: 3 }), "PENDING_OCR");
    expect(pending.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(pending.every((p) => p.status === "PENDING_OCR" && p.ocrMethod === "NONE" && p.text === "")).toBe(true);
    const failed = buildPendingPages(doc({ pageCount: 2 }), "OCR_FAILED");
    expect(failed.every((p) => p.status === "OCR_FAILED")).toBe(true);
    expect(failed[0].note).toMatch(/OCR failed/);
  });

  it("an unknown or implausible page count produces no rows rather than a fabricated ledger", () => {
    expect(buildPendingPages(doc({ pageCount: null }), "PENDING_OCR")).toEqual([]);
    expect(buildPendingPages(doc({ pageCount: 0 }), "PENDING_OCR")).toEqual([]);
    expect(buildPendingPages(doc({ pageCount: 99_999 }), "PENDING_OCR")).toEqual([]);
  });
});

describe("persistence is idempotent", () => {
  it("re-running an extraction rewrites the same pages instead of duplicating them", async () => {
    const text = [page(1, body("A")), page(2, body("B"))].join("\n");
    await persistPageLedger(ledgerFor(text));
    await persistPageLedger(ledgerFor(text));
    expect(db.state.rows.size).toBe(2); // upsert keyed on (document, page)
    expect(db.state.upserts).toHaveLength(4);
    for (const u of db.state.upserts) expect(u.where).toHaveProperty("sourceDocumentId_pageNumber");
  });

  it("a re-run changes only the state of pages whose state changed", async () => {
    const text = [page(1, body("A")), page(2, body("B"))].join("\n");
    await persistPageLedger(ledgerFor(text));
    expect(db.state.rows.get("doc-1#2")!.status).toBe("READABLE");
    await persistPageLedger(ledgerFor(text, {}, { failedRanges: [{ pageStart: 2, pageEnd: 2, reason: "provider unavailable" }] }));
    expect(db.state.rows.get("doc-1#1")!.status).toBe("READABLE");
    expect(db.state.rows.get("doc-1#2")!.status).toBe("FAILED");
  });
});

describe("case processing facts are derived, never assumed", () => {
  const facts = () => caseProcessingFacts("case-1", "firm-1");

  it("a document with no extraction run means the case is NOT fully processed", async () => {
    db.state.docs = [{ id: "d1", flags: null }, { id: "d2", flags: null }];
    db.state.runs = [{ sourceDocumentId: "d1", status: "COMPLETE" }];
    expect(await facts()).toEqual({ allDocumentsProcessed: false, failedExtractions: 0 });
  });

  it("failed and OCR-blocked runs are counted as failures", async () => {
    db.state.docs = [{ id: "d1", flags: null }, { id: "d2", flags: null }, { id: "d3", flags: null }];
    db.state.runs = [
      { sourceDocumentId: "d1", status: "COMPLETE" },
      { sourceDocumentId: "d2", status: "EXTRACTION_FAILED" },
      { sourceDocumentId: "d3", status: "BLOCKED_OCR" },
    ];
    expect(await facts()).toEqual({ allDocumentsProcessed: false, failedExtractions: 2 });
  });

  it("only the LATEST run per document counts — a repaired document is not permanently failed", async () => {
    db.state.docs = [{ id: "d1", flags: null }];
    // findMany is ordered createdAt desc, so the newest run is first.
    db.state.runs = [
      { sourceDocumentId: "d1", status: "COMPLETE" },
      { sourceDocumentId: "d1", status: "EXTRACTION_FAILED" },
    ];
    expect(await facts()).toEqual({ allDocumentsProcessed: true, failedExtractions: 0 });
  });

  it("a document still awaiting OCR blocks completeness even when its run succeeded", async () => {
    db.state.docs = [{ id: "d1", flags: "OCR in progress" }];
    db.state.runs = [{ sourceDocumentId: "d1", status: "COMPLETE" }];
    expect((await facts()).allDocumentsProcessed).toBe(false);
  });

  it("every document processed with no failures is the only path to complete", async () => {
    db.state.docs = [{ id: "d1", flags: null }, { id: "d2", flags: "" }];
    db.state.runs = [
      { sourceDocumentId: "d1", status: "COMPLETE" },
      { sourceDocumentId: "d2", status: "COMPLETE" },
    ];
    expect(await facts()).toEqual({ allDocumentsProcessed: true, failedExtractions: 0 });
  });
});
