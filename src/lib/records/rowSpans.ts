// ─────────────────────────────────────────────────────────────────────────────
// Where each extracted row actually sits in its document.
//
// Merging on (document, date) collapsed 4,395 rows to 1,111 entries against the
// ~250 records a planner indexes for the same case file. The residue is not a
// merge-rule problem. It is that a date is a coarse proxy for "the same
// record": one hospital admission day legitimately carries several distinct
// notes, and date inheritance concentrates still more rows onto it, so a
// group had to be split by a blunt claim count that cuts real records in half.
//
// The rows themselves know better. Every claim carries a verbatim excerpt the
// extractor already verified against the document, so a row's true position is
// recoverable: locate its excerpts and take the span they occupy. Rows drawn
// from the same passage overlap; rows drawn from different notes do not. That
// is a record boundary the document states rather than one we infer.
//
// The same offsets fix the citation. Page attribution was so unreliable that a
// 56-page packet recorded every row on "page 1" and the writer had to suppress
// citations entirely; an offset resolved against the document's own "Page N"
// markers gives the page the text is actually on.
// ─────────────────────────────────────────────────────────────────────────────

import { pageForOffset, pageMarks } from "@/lib/documents/meta";
import { locateSpan, prepareDocumentText } from "@/lib/records/sectionLedger";

export interface RowSpan {
  start: number;
  end: number;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface SpannableRow {
  id: string;
  claims: readonly { excerpt: string }[];
}

/** A document prepared once, for locating every row drawn from it. */
export interface PreparedDocument {
  text: string;
  marks: { offset: number; page: number }[];
}

export function prepareDocument(rawText: string): PreparedDocument {
  const text = prepareDocumentText(rawText);
  return { text, marks: pageMarks(text) };
}

/**
 * The span a row occupies, and the pages that span covers.
 *
 * Located from the row's own claim excerpts with no padding: padding is right
 * for the section ledger, which needs to see the heading ABOVE a quoted line,
 * and wrong here, where an inflated span would make neighbouring records
 * appear to overlap and merge two notes into one.
 */
export function spanOf(doc: PreparedDocument, row: SpannableRow): RowSpan | null {
  const located = locateSpan(doc.text, row.claims.map((c) => c.excerpt ?? ""), 0);
  if (!located) return null;
  return {
    start: located.start,
    end: located.end,
    pageStart: pageForOffset(located.start, doc.marks),
    pageEnd: pageForOffset(located.end, doc.marks),
  };
}

/**
 * How close two spans may sit and still be one record.
 *
 * Chunks of one note overlap or abut; the gap between two notes in a packet is
 * a page of header, signature block and footer. A couple of thousand
 * characters is comfortably inside one note and comfortably short of the next.
 */
export const SAME_RECORD_GAP = 2_000;

export function spansAreSameRecord(a: RowSpan, b: RowSpan): boolean {
  if (a.start <= b.end && b.start <= a.end) return true;
  return Math.max(a.start, b.start) - Math.min(a.end, b.end) <= SAME_RECORD_GAP;
}

/**
 * Group rows into records by where their text sits.
 *
 * Rows whose span could not be located keep their own group: with no position
 * in hand there is no evidence they belong with anything, and guessing would
 * merge unrelated notes. Returned in document order, so a record's parts are
 * assembled the way the record reads.
 */
export function groupBySpan<T extends SpannableRow>(
  doc: PreparedDocument,
  rows: readonly T[],
): { rows: T[]; span: RowSpan | null }[] {
  const located: { row: T; span: RowSpan }[] = [];
  const unlocated: T[] = [];
  for (const row of rows) {
    const span = spanOf(doc, row);
    if (span) located.push({ row, span });
    else unlocated.push(row);
  }
  located.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);

  const groups: { rows: T[]; span: RowSpan | null }[] = [];
  for (const { row, span } of located) {
    const open = groups.at(-1);
    if (open?.span && spansAreSameRecord(open.span, span)) {
      open.rows.push(row);
      open.span = {
        start: Math.min(open.span.start, span.start),
        end: Math.max(open.span.end, span.end),
        pageStart: minPage(open.span.pageStart, span.pageStart),
        pageEnd: maxPage(open.span.pageEnd, span.pageEnd),
      };
      continue;
    }
    groups.push({ rows: [row], span: { ...span } });
  }
  for (const row of unlocated) groups.push({ rows: [row], span: null });
  return groups;
}

function minPage(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxPage(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}
