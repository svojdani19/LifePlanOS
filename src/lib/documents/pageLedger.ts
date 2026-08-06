// ─────────────────────────────────────────────────────────────────────────────
// Page-coverage ledger: the PROOF behind "every page was processed".
//
// Whole-record processing is a claim about pages, so the claim is recorded at
// page granularity: one durable SourcePage row per source page, carrying the
// page's text hash, how its text was obtained, what state it ended in, and —
// when something went wrong — why. Completeness is then DERIVED from these
// persisted facts; it is never asserted from the absence of an error.
//
// Two honesty rules govern the states:
//   • Empty OCR output is NOT a blank page. A native-text page with no text is
//     BLANK (the PDF itself says so); an OCR'd page with no text is UNREADABLE
//     until a human looks at the scan — OCR failure and blankness are
//     indistinguishable from the text alone.
//   • Documents without stable page boundaries get NO page rows. Inventing
//     page numbers to make a ledger look complete would defeat its purpose;
//     such documents are represented honestly at document level.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";

export type PageState = "READABLE" | "BLANK" | "LOW_CONFIDENCE" | "UNREADABLE" | "FAILED" | "DUPLICATE" | "PENDING_OCR" | "OCR_FAILED";

export interface PageLedgerRow {
  firmId: string;
  caseId: string;
  sourceDocumentId: string;
  filename: string;
  pageNumber: number;
  text: string;
  offsetStart: number;
  offsetEnd: number;
  ocrMethod: "NATIVE_TEXT" | "OCR" | "NONE";
  ocrConfidence: number | null;
  contentHash: string;
  status: PageState;
  truncated: boolean;
  note: string | null;
}

export interface PageLedgerInput {
  doc: { id: string; firmId: string; caseId: string; filename: string; ocrConfidence: number | null; pageCount?: number | null };
  /** The processed (furniture-stripped) text the pipeline actually read. */
  text: string;
  /** Page marks located in that text; empty = no stable page boundaries. */
  marks: { offset: number; page: number }[];
  /** Page ranges of chunks that failed processing, with reasons. */
  failedRanges?: { pageStart: number | null; pageEnd: number | null; reason: string }[];
  /** The source text arrived clipped at the storage cap. */
  sourceClipped?: boolean;
  /**
   * Pages this invocation actually accounted for. When a run pauses at its
   * chunk budget, the pages it never reached get NO row — the absence of a row
   * is the honest record of "not yet accounted for", and the resumed run fills
   * them in. Omit (or null) when the whole document was processed.
   */
  coveredPages?: Set<number> | null;
}

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Minimum characters for a page to count as carrying text. */
const MIN_PAGE_TEXT = 25;

/** Leading page furniture ("Page 4 of 212"), excluded from content. */
const PAGE_MARKER = /^page\s+\d+(?:\s+of\s+\d+)?\s*/i;

/**
 * Build the ledger rows for one document — pure, so every state rule is unit
 * testable. Returns [] for documents without stable page boundaries.
 */
export function buildPageLedger(input: PageLedgerInput): PageLedgerRow[] {
  const { doc, text, marks } = input;
  if (marks.length === 0) return []; // no invented page numbers

  const method: PageLedgerRow["ocrMethod"] = doc.ocrConfidence != null ? "OCR" : "NATIVE_TEXT";
  const sorted = [...marks].sort((a, b) => a.offset - b.offset);
  const slices: { page: number; start: number; end: number }[] = [];
  if (sorted[0].offset > 0) slices.push({ page: sorted[0].page, start: 0, end: sorted[0].offset });
  for (let i = 0; i < sorted.length; i++) {
    slices.push({ page: sorted[i].page, start: sorted[i].offset, end: i + 1 < sorted.length ? sorted[i + 1].offset : text.length });
  }
  // A page number can appear in two slices (header remnants); merge by page.
  const byPage = new Map<number, { start: number; end: number }>();
  for (const s of slices) {
    const cur = byPage.get(s.page);
    if (!cur) byPage.set(s.page, { start: s.start, end: s.end });
    else {
      cur.start = Math.min(cur.start, s.start);
      cur.end = Math.max(cur.end, s.end);
    }
  }

  const inFailedRange = (page: number): string | null => {
    for (const r of input.failedRanges ?? []) {
      if (r.pageStart == null) continue;
      if (page >= r.pageStart && page <= (r.pageEnd ?? r.pageStart)) return r.reason;
    }
    return null;
  };

  const rows: PageLedgerRow[] = [];
  const seenHashes = new Map<string, number>();
  const lastPage = Math.max(...byPage.keys());
  for (const [page, span] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (input.coveredPages && !input.coveredPages.has(page)) continue;
    const body = text.slice(span.start, span.end);
    // The page marker itself is furniture, not content: a page carrying only
    // "Page 12 of 300" is empty, and two identical faxed pages must hash the
    // same even though their markers differ.
    const trimmed = body.replace(/\s+/g, " ").trim().replace(PAGE_MARKER, "").trim();
    const contentHash = hash(trimmed);
    let status: PageState;
    let note: string | null = null;

    const failReason = inFailedRange(page);
    if (failReason) {
      status = "FAILED";
      note = failReason.slice(0, 300);
    } else if (trimmed.length < MIN_PAGE_TEXT) {
      if (method === "OCR") {
        // Empty OCR output is ambiguous: a truly blank page and an unreadable
        // scan produce the same nothing. Only a human looking at the image can
        // tell them apart — so the state demands that look.
        status = "UNREADABLE";
        note = "OCR returned no text for this page — it may be blank or unreadable; distinguish against the source scan.";
      } else {
        status = "BLANK";
        note = "The document's own text layer carries no content on this page.";
      }
    } else if (seenHashes.has(contentHash) && trimmed.length > 100) {
      status = "DUPLICATE";
      note = `Content is identical to page ${seenHashes.get(contentHash)}.`;
    } else if (doc.ocrConfidence != null && doc.ocrConfidence < 0.6) {
      status = "LOW_CONFIDENCE";
      note = `OCR confidence ${Math.round(doc.ocrConfidence * 100)}% — extracted facts require verification against the source scan.`;
    } else {
      status = "READABLE";
    }
    if (!seenHashes.has(contentHash) && trimmed.length > 100) seenHashes.set(contentHash, page);

    rows.push({
      firmId: doc.firmId, // server-owned tenancy on every row
      caseId: doc.caseId,
      sourceDocumentId: doc.id,
      filename: doc.filename,
      pageNumber: page,
      text: body,
      offsetStart: span.start,
      offsetEnd: span.end,
      ocrMethod: method,
      ocrConfidence: doc.ocrConfidence ?? null,
      contentHash,
      status,
      truncated: !!input.sourceClipped && page === lastPage,
      note,
    });
  }
  return rows;
}

/** Rows for a document still waiting on (or failed at) OCR. */
export function buildPendingPages(
  doc: { id: string; firmId: string; caseId: string; filename: string; pageCount?: number | null },
  state: "PENDING_OCR" | "OCR_FAILED",
): PageLedgerRow[] {
  const n = doc.pageCount ?? 0;
  if (n <= 0 || n > 5000) return [];
  return Array.from({ length: n }, (_, i) => ({
    firmId: doc.firmId,
    caseId: doc.caseId,
    sourceDocumentId: doc.id,
    filename: doc.filename,
    pageNumber: i + 1,
    text: "",
    offsetStart: 0,
    offsetEnd: 0,
    ocrMethod: "NONE" as const,
    ocrConfidence: null,
    contentHash: hash(""),
    status: state,
    truncated: false,
    note: state === "PENDING_OCR" ? "Awaiting OCR — content not yet readable." : "OCR failed — content could not be read.",
  }));
}

/**
 * Idempotent persistence: upsert on (document, pageNumber). Re-running a
 * completed extraction rewrites identical rows; a resumed run only changes the
 * pages whose state actually changed.
 */
export async function persistPageLedger(rows: PageLedgerRow[]): Promise<void> {
  for (const row of rows) {
    await prisma.sourcePage.upsert({
      where: { sourceDocumentId_pageNumber: { sourceDocumentId: row.sourceDocumentId, pageNumber: row.pageNumber } },
      create: row,
      update: {
        text: row.text,
        offsetStart: row.offsetStart,
        offsetEnd: row.offsetEnd,
        ocrMethod: row.ocrMethod,
        ocrConfidence: row.ocrConfidence,
        contentHash: row.contentHash,
        status: row.status,
        truncated: row.truncated,
        note: row.note,
      },
    });
  }
}

/**
 * Case-level processing facts, DERIVED from persisted state — the honest
 * inputs the audit consumes instead of hardcoded assumptions.
 */
export async function caseProcessingFacts(
  caseId: string,
  firmId: string,
  /**
   * The in-flight document: a run computing these facts has not yet written
   * its own outcome, so it states it here rather than reading a row that does
   * not exist yet. Every other document is read from what is persisted.
   */
  inFlight?: { documentId: string; processed: boolean },
): Promise<{ allDocumentsProcessed: boolean; failedExtractions: number }> {
  const docs = await prisma.document.findMany({ where: { caseId, firmId }, select: { id: true, flags: true } });
  const pendingOcr = docs.filter((d) => /OCR queued|OCR in progress|OCR failed/i.test(d.flags ?? "")).length;
  const runs = await prisma.recordExtraction.findMany({
    where: { caseId, firmId },
    orderBy: { createdAt: "desc" },
    select: { sourceDocumentId: true, status: true },
  });
  const latest = new Map<string, string>();
  for (const r of runs) if (!latest.has(r.sourceDocumentId)) latest.set(r.sourceDocumentId, r.status);
  let failed = 0;
  let unprocessed = 0;
  for (const d of docs) {
    if (inFlight && d.id === inFlight.documentId) {
      if (!inFlight.processed) unprocessed++;
      continue;
    }
    const status = latest.get(d.id);
    // An unfinished run (RUNNING/PAUSED) is not a processed document, and a
    // document with no run at all has never been read.
    if (!status || status === "RUNNING" || status === "PAUSED" || status === "PENDING" || status === "ABANDONED") unprocessed++;
    else if (status === "EXTRACTION_FAILED" || status === "BLOCKED_OCR") failed++;
  }
  return { allDocumentsProcessed: pendingOcr === 0 && unprocessed === 0 && failed === 0, failedExtractions: failed };
}
