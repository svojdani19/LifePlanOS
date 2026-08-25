"use client";

import { FileText, CalendarDays } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// What a reviewer is about to sign, itemized.
//
// The panel used to show counts and a button:
//
//     "23 canonical encounters and 41 chronology entries are clean and can be
//      confirmed in one review."
//
// A reviewer clicking that had seen a NUMBER, not a record — and
// `humanAuthoritative()` then treats every row that click writes as something
// a person read. An aggregate cannot establish human authority over items
// nobody displayed, so the items are displayed.
//
// TWO refinements the first version got wrong:
//
//   • It rendered ONE line per canonical note, taking the summary from the
//     first row of the note's document. `confirmRowIds` routinely holds
//     several rows, and a note can mix an already-reviewed row with an AI
//     draft — so the sentence shown could belong to a row the click was not
//     writing. Every row being written now carries its own line, nested under
//     its note so the canonical one-decision model is unchanged.
//
//   • Chronology lines showed a date, a page and a count. The API was already
//     sending the filename and it was dropped on the floor here, so the
//     citation a reviewer needs to check the entry was not on screen.
//
// Citations are VISIBLE TEXT, not a tooltip or an icon: this list is meant to
// be printable, and a title attribute does not survive Cmd-P.
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestRowLine {
  rowId: string;
  summary: string;
  documentId: string;
  filename: string;
  page: number | null;
  pageEnd: number | null;
}

export interface ManifestRecordLine {
  noteId: string;
  documentId: string;
  filename: string;
  encounterDate: string | null;
  provider: string | null;
  facility: string | null;
  basis: string;
  rows: ManifestRowLine[];
}

export interface ManifestEventLine {
  eventId: string;
  eventDate: string | null;
  summary: string;
  documentId: string | null;
  filename: string | null;
  page: number | null;
  sourceRowIds: string[];
  linkage: string;
}

const pageText = (start: number | null, end: number | null): string => {
  if (start == null) return "";
  return end != null && end !== start ? `pp. ${start}–${end}` : `p. ${start}`;
};

/**
 * The citation, as readable text plus a case-scoped link.
 *
 * The route enforces tenant and case scope; the filename and page are printed
 * whether or not the link is followed.
 */
function Citation({
  caseId,
  documentId,
  filename,
  page,
  pageEnd,
}: {
  caseId: string;
  documentId: string | null;
  filename: string | null;
  page: number | null;
  pageEnd?: number | null;
}) {
  const pages = pageText(page, pageEnd ?? null);
  const label = `${filename || documentId || "source record"}${pages ? `, ${pages}` : ""}`;
  if (!documentId) return <span className="italic text-ink-400">No source document recorded</span>;
  return (
    <a
      href={`/api/cases/${caseId}/documents/${documentId}/view`}
      target="_blank"
      rel="noopener noreferrer"
      className="focusable rounded font-medium text-brand-700 underline"
    >
      {label}
    </a>
  );
}

export function BatchManifest({
  caseId,
  records,
  events,
  defaultOpen = false,
}: {
  caseId: string;
  records: ManifestRecordLine[];
  events: ManifestEventLine[];
  defaultOpen?: boolean;
}) {
  const rowCount = records.reduce((n, r) => n + r.rows.length, 0);
  const total = rowCount + events.length;
  if (!total) return null;

  return (
    <details open={defaultOpen} className="mt-2 rounded border border-teal-300 bg-white">
      <summary className="focusable cursor-pointer rounded px-2 py-1.5 text-[11px] font-semibold text-teal-900">
        Review the {total} item{total === 1 ? "" : "s"} this will mark as reviewed
      </summary>
      <div className="max-h-96 overflow-y-auto border-t border-teal-200 px-2 py-1.5">
        {records.length > 0 && (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              Records — {rowCount} entr{rowCount === 1 ? "y" : "ies"} in {records.length} note{records.length === 1 ? "" : "s"}
            </p>
            <ol className="mt-1 space-y-2">
              {records.map((r) => (
                <li key={r.noteId} className="border-b border-ink-100 pb-2 last:border-0">
                  <p className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-ink-500">
                    <FileText aria-hidden="true" className="h-3 w-3 shrink-0" />
                    <Citation caseId={caseId} documentId={r.documentId} filename={r.filename} page={null} />
                    {r.encounterDate && <span>· {r.encounterDate}</span>}
                    {r.provider && <span>· {r.provider}</span>}
                    {r.facility && <span>· {r.facility}</span>}
                    <span className="text-ink-400">· membership: {r.basis.replace(/_/g, " ").toLowerCase()}</span>
                  </p>
                  {/* EVERY row this click writes, each with its own assertion
                      and its own citation. Nested, so one canonical note is
                      still one decision. */}
                  <ol className="mt-1 space-y-1 pl-3">
                    {r.rows.map((row) => (
                      <li key={row.rowId} className="border-l-2 border-ink-200 pl-2">
                        <p className="text-[11px] text-ink-800">
                          {row.summary || <span className="italic text-ink-400">No factual summary recorded for this entry.</span>}
                        </p>
                        <p className="mt-0.5 text-[10px] text-ink-500">
                          <Citation caseId={caseId} documentId={row.documentId} filename={row.filename} page={row.page} pageEnd={row.pageEnd} />
                        </p>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </>
        )}
        {events.length > 0 && (
          <>
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              Chronology entries ({events.length})
            </p>
            <ol className="mt-1 space-y-1.5">
              {events.map((e) => (
                <li key={e.eventId} className="border-b border-ink-100 pb-1.5 last:border-0">
                  <p className="text-[11px] text-ink-800">{e.summary || <span className="italic text-ink-400">No summary recorded.</span>}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-ink-500">
                    <CalendarDays aria-hidden="true" className="h-3 w-3 shrink-0" />
                    {e.eventDate && <span className="font-medium">{e.eventDate}</span>}
                    <span>·</span>
                    <Citation caseId={caseId} documentId={e.documentId} filename={e.filename} page={e.page} />
                    {/* The exact source lineage — the reason this entry may be
                        covered at all. */}
                    <span className="text-ink-400">
                      · built from {e.sourceRowIds.length} confirmed record entr{e.sourceRowIds.length === 1 ? "y" : "ies"}
                    </span>
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </details>
  );
}
