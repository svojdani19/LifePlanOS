// ─────────────────────────────────────────────────────────────────────────────
// The Records tab's view model.
//
// The page had grown into one list that did three unrelated jobs at once:
// uploading and managing files, working a review queue, and reading extracted
// clinical events. Every document row could expand inline, so opening the
// 625-page production rendered its notes, its fragments and its source
// excerpts into the middle of the same scroll — and the surrounding chrome
// (case header, financial metrics, pipeline, workspace bar) took most of the
// viewport before any of it.
//
// This module holds the DECISIONS — which mode to open, what state a document
// is in, how the filters compose, and what the counts are called — as pure
// functions, so they can be tested without a browser and cannot drift between
// the header, the summary cards and the list.
//
// WHAT THIS MODULE DOES NOT DO, deliberately:
//
//   • It does not classify anything. Every state below is read from fields the
//     server already computed — `attention`, `guidance.kind`, `status`,
//     `extraction.status`, `dateStatus`. Re-deriving a review state in the
//     browser would create a second opinion about whether a record is clean.
//   • It does not filter records out of existence. A filter narrows what is
//     LISTED; nothing here removes a document from the case, and every mode
//     reaches every document.
//   • It invents no relevance ranking. Where the data carries no ordering, the
//     order is the server's.
// ─────────────────────────────────────────────────────────────────────────────

/** The three jobs the Records tab actually does. */
export type RecordsMode = "queue" | "documents" | "encounters";

export const RECORDS_MODES: readonly RecordsMode[] = ["queue", "documents", "encounters"];

export const MODE_LABEL: Record<RecordsMode, string> = {
  queue: "Review Queue",
  documents: "Documents",
  encounters: "Encounters",
};

export const MODE_DESCRIPTION: Record<RecordsMode, string> = {
  queue: "Records that need a review decision, or are ready for one.",
  documents: "Every uploaded file, its processing state, and file management.",
  encounters: "The clinical events extracted from those files.",
};

/**
 * A document as this view model needs it — the subset of `StructuredDocument`
 * plus the `Document` row the page already loads. Kept structural so the
 * module never imports Prisma or the server record builder.
 */
export interface RecordsDoc {
  documentId: string;
  filename: string;
  type: string;
  pageCount?: number | null;
  serviceDate?: string | null;
  serviceDateEnd?: string | null;
  ocrConfidence?: number | null;
  flags?: string | null;
  extraction?: { status?: string | null; truncated?: boolean | null; warnings?: unknown };
  notes?: readonly RecordsNote[];
  encounters?: readonly { id: string; dateStatus?: string | null; status?: string | null }[];
  findings?: readonly { blocking?: boolean; status?: string | null }[];
  pageFindings?: readonly { blocking?: boolean; status?: string | null }[];
}

export interface RecordsNote {
  id: string;
  rowIds?: readonly string[];
  attention?: string | null;
  needsAttention?: boolean | null;
  awaitingAttestation?: boolean | null;
  status?: string | null;
  dateStatus?: string | null;
  guidance?: { kind?: string | null } | null;
  findings?: readonly { blocking?: boolean; status?: string | null }[];
}

// ── Task status ──────────────────────────────────────────────────────────────
//
// The page's only filter was document CATEGORY — Emergency, Diagnostics,
// Financial. That answers "what kind of record is this?", which is never the
// question a reviewer working a queue is asking. Task status is promoted to
// the primary filter and category demoted to secondary; neither changes the
// underlying classification.

export type TaskStatus =
  | "NEEDS_ACTION"
  | "UNDATED"
  | "SOURCE_CONFLICT"
  | "MISSING_PAGES"
  | "PROCESSING_FAILED"
  | "CAUTION"
  | "READY_TO_CONFIRM"
  | "REVIEWED";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "NEEDS_ACTION", "UNDATED", "SOURCE_CONFLICT", "MISSING_PAGES",
  "PROCESSING_FAILED", "CAUTION", "READY_TO_CONFIRM", "REVIEWED",
];

export const TASK_LABEL: Record<TaskStatus, string> = {
  NEEDS_ACTION: "Needs action",
  UNDATED: "Undated",
  SOURCE_CONFLICT: "Source conflicts",
  MISSING_PAGES: "Possible missing pages",
  PROCESSING_FAILED: "Processing failures",
  CAUTION: "Cautions",
  READY_TO_CONFIRM: "Ready to confirm",
  REVIEWED: "Reviewed",
};

/** One sentence, plain language. Shown beside the count, not behind a tooltip. */
export const TASK_DEFINITION: Record<TaskStatus, string> = {
  NEEDS_ACTION: "A reviewer has to correct or dispose of something before this record can be relied on.",
  UNDATED: "A clinical entry whose service date could not be established from the record.",
  SOURCE_CONFLICT: "The extraction and the source disagree, or two readings of the same page disagree.",
  MISSING_PAGES: "The page ledger suggests pages are absent from the production.",
  PROCESSING_FAILED: "OCR or extraction did not complete, so this file's content is not in the case.",
  CAUTION: "Sound as it stands, but carries something to read before signing.",
  READY_TO_CONFIRM: "Clean, and waiting for one human confirmation.",
  REVIEWED: "A person has already decided this one.",
};

/** Findings that are still open. A dispositioned finding is not work. */
const isOpen = (f: { status?: string | null }): boolean =>
  !f.status || !["RESOLVED", "IGNORED", "DISMISSED", "ACCEPTED"].includes(String(f.status));

const openBlocking = (findings: readonly { blocking?: boolean; status?: string | null }[] | undefined): number =>
  (findings ?? []).filter((f) => f.blocking && isOpen(f)).length;

/** Guidance kinds the review surface already uses to mean "pages may be absent". */
const MISSING_PAGE_KINDS = new Set(["MISSING_ENCOUNTER", "PAGE_GAP", "COVERAGE_GAP", "DOCUMENT_INCOMPLETE"]);
/** …and to mean "the readings disagree". */
const CONFLICT_KINDS = new Set(["SOURCE_CONFLICT", "LEGACY_CONFLICT", "CONTRADICTED", "DISPUTED", "UNCORROBORATED"]);

/**
 * Every task status a document currently carries.
 *
 * A document is routinely in several at once — that is the point of composing
 * filters rather than bucketing. Returned as a Set so membership tests are
 * cheap in a list that re-renders per keystroke.
 */
export function taskStatusesOf(doc: RecordsDoc): Set<TaskStatus> {
  const out = new Set<TaskStatus>();
  const notes = doc.notes ?? [];

  const exStatus = String(doc.extraction?.status ?? "NOT_RUN");
  if (exStatus === "EXTRACTION_FAILED" || exStatus === "BLOCKED_OCR") out.add("PROCESSING_FAILED");

  if (openBlocking(doc.findings) > 0 || openBlocking(doc.pageFindings) > 0) out.add("NEEDS_ACTION");

  for (const f of [...(doc.findings ?? []), ...(doc.pageFindings ?? [])]) {
    if (!isOpen(f)) continue;
    const kind = String((f as { type?: string }).type ?? "");
    if (MISSING_PAGE_KINDS.has(kind)) out.add("MISSING_PAGES");
    if (CONFLICT_KINDS.has(kind)) out.add("SOURCE_CONFLICT");
  }

  for (const n of notes) {
    const attention = String(n.attention ?? "");
    const kind = String(n.guidance?.kind ?? "");
    if (attention === "EXCEPTION" || n.needsAttention) out.add("NEEDS_ACTION");
    if (attention === "CAUTION") out.add("CAUTION");
    if (MISSING_PAGE_KINDS.has(kind)) out.add("MISSING_PAGES");
    if (CONFLICT_KINDS.has(kind)) out.add("SOURCE_CONFLICT");
    if (n.dateStatus === "UNKNOWN") out.add("UNDATED");
    // Ready means: nothing owed on it, and a human has not yet signed it.
    if (attention === "CLEAN" && !n.needsAttention && n.awaitingAttestation) out.add("READY_TO_CONFIRM");
    if (["REVIEWED", "VERIFIED", "HUMAN_EDITED"].includes(String(n.status ?? ""))) out.add("REVIEWED");
  }

  // Legacy documents carry rows but no note projection; their undated rows are
  // still real work and must not vanish because the projection is missing.
  if (!notes.length) {
    for (const e of doc.encounters ?? []) {
      if (e.dateStatus === "UNKNOWN") out.add("UNDATED");
      if (["REVIEWED", "VERIFIED", "HUMAN_EDITED"].includes(String(e.status ?? ""))) out.add("REVIEWED");
    }
  }

  return out;
}

/** How many items inside a document are asking for something. */
export function attentionCount(doc: RecordsDoc): number {
  const notes = doc.notes ?? [];
  const fromNotes = notes.filter((n) => n.needsAttention || String(n.attention) === "EXCEPTION").length;
  return fromNotes + openBlocking(doc.findings) + openBlocking(doc.pageFindings);
}

/** Is there any unresolved work anywhere in the case? Decides the default mode. */
export function hasUnresolvedWork(docs: readonly RecordsDoc[]): boolean {
  return docs.some((d) => {
    const s = taskStatusesOf(d);
    return s.has("NEEDS_ACTION") || s.has("PROCESSING_FAILED") || s.has("READY_TO_CONFIRM") || s.has("CAUTION");
  });
}

/**
 * Which mode to open on.
 *
 * An explicit choice in the URL always wins — a reviewer who navigated to
 * Documents and pressed reload must land on Documents, not be re-routed by a
 * heuristic. Otherwise: the queue when there is work, Documents when there
 * is not.
 */
export function defaultMode(docs: readonly RecordsDoc[], requested?: string | null): RecordsMode {
  if (requested && (RECORDS_MODES as readonly string[]).includes(requested)) return requested as RecordsMode;
  return hasUnresolvedWork(docs) ? "queue" : "documents";
}

// ── Filter composition ───────────────────────────────────────────────────────

export interface RecordsFilter {
  /** Task statuses, ANY-of. Empty means no task constraint. */
  tasks: readonly TaskStatus[];
  /** Document category label, or null for all. Secondary by design. */
  category: string | null;
  /** Free text over filename, provider and facility. */
  query: string;
}

export const EMPTY_FILTER: RecordsFilter = { tasks: [], category: null, query: "" };

export const isFilterActive = (f: RecordsFilter): boolean =>
  f.tasks.length > 0 || f.category !== null || f.query.trim().length > 0;

/** Toggle one task status, preserving the rest. */
export function toggleTask(f: RecordsFilter, task: TaskStatus): RecordsFilter {
  const has = f.tasks.includes(task);
  return { ...f, tasks: has ? f.tasks.filter((t) => t !== task) : [...f.tasks, task] };
}

/**
 * Apply a filter.
 *
 * Task statuses compose as ANY-of and category as AND: "show me the undated
 * and the conflicted, among diagnostics". Text matches the fields a reviewer
 * can actually see on the collapsed row.
 */
export function applyFilter(
  docs: readonly RecordsDoc[],
  f: RecordsFilter,
  categoryOf: (doc: RecordsDoc) => string,
  searchTextOf: (doc: RecordsDoc) => string = (d) => d.filename,
): RecordsDoc[] {
  const q = f.query.trim().toLowerCase();
  return docs.filter((d) => {
    if (f.category !== null && categoryOf(d) !== f.category) return false;
    if (f.tasks.length) {
      const s = taskStatusesOf(d);
      if (!f.tasks.some((t) => s.has(t))) return false;
    }
    if (q && !searchTextOf(d).toLowerCase().includes(q)) return false;
    return true;
  });
}

/** How many documents each task status would match, for the filter chips. */
export function taskCounts(docs: readonly RecordsDoc[]): Record<TaskStatus, number> {
  const out = Object.fromEntries(TASK_STATUSES.map((t) => [t, 0])) as Record<TaskStatus, number>;
  for (const d of docs) for (const t of taskStatusesOf(d)) out[t] += 1;
  return out;
}

// ── Counting terminology ─────────────────────────────────────────────────────
//
// The page showed several counts of different GRAINS with no indication that
// they were different things: notes, extraction rows, and claim fragments all
// rendered as bare numbers. A reviewer comparing "23" against "37" against
// "136" had no way to know they were counting three different objects.

export interface GrainCounts {
  /** Canonical notes — the review unit. */
  encounters: number;
  /** Extraction rows the notes were assembled from. */
  entries: number;
  /** Individual cited claims within those rows. */
  fragments: number;
}

export const GRAIN_HELP: Record<keyof GrainCounts, string> = {
  encounters:
    "An encounter is one canonical note — the unit a reviewer decides on. Several extracted entries may be assembled into one.",
  entries:
    "An extracted entry is one row the extractor produced from the source. Entries are evidence beneath a note, and remain individually correctable.",
  fragments:
    "A fragment is one cited claim inside an entry — a field, its value, and the excerpt it came from.",
};

export function grainCountsOf(docs: readonly RecordsDoc[]): GrainCounts {
  let encounters = 0;
  let entries = 0;
  let fragments = 0;
  for (const d of docs) {
    const notes = d.notes ?? [];
    encounters += notes.length;
    entries += d.encounters?.length ?? 0;
    for (const n of notes) fragments += (n as { claimCount?: number }).claimCount ?? 0;
  }
  return { encounters, entries, fragments };
}

/**
 * The sentence that names all three grains at once.
 *
 * Deliberately spelled out rather than left as three adjacent numbers: the
 * whole defect was that unlike objects were being counted with the same word.
 */
export function grainSentence(c: GrainCounts): string {
  const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
  return `${n(c.encounters, "encounter", "encounters")} assembled from ${n(c.entries, "extracted entry", "extracted entries")} and ${n(c.fragments, "source fragment", "source fragments")}.`;
}
