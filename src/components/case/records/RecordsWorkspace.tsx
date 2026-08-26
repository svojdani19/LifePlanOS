"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, MoreHorizontal, Trash2, Pencil, X,
  AlertTriangle, CheckCircle2, Info, Search, FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { TYPE_LABEL, TYPE_GROUP, DOC_TYPE_GROUPS } from "@/lib/documents/taxonomy";
import { iconForType, GROUP_ICON } from "@/components/case/records/documentIcons";
import {
  type RecordsDoc, type TaskStatus, type RecordsFilter,
  TASK_STATUSES, TASK_LABEL, TASK_DEFINITION,
  taskStatusesOf, attentionCount, toggleTask, isFilterActive, EMPTY_FILTER,
  GRAIN_HELP, grainCountsOf, grainSentence,
} from "@/lib/records/recordsView";

// ─────────────────────────────────────────────────────────────────────────────
// The Records tab's presentation layer.
//
// Everything here is a VIEW over data the server already computed. No component
// in this file forms an opinion about whether a record is clean, decides what a
// count means, or mutates a review decision — those stay where they were, so a
// presentation change cannot alter review semantics or the audit trail.
//
// The two structural problems it solves:
//
//   • Every document row could expand INLINE. Opening the 625-page production
//     rendered its notes, its fragments and its source excerpts into the middle
//     of the same scroll, and the list you were working disappeared above it.
//     Detail now opens in a side pane that leaves the list in place, and its
//     long lists are paginated rather than dumped.
//
//   • The only filter was document CATEGORY, which answers "what kind of record
//     is this?" — never the question a reviewer working a queue is asking. Task
//     status is primary now; category is still there, secondary.
// ─────────────────────────────────────────────────────────────────────────────

type AnyRec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PAGE_SIZE = 25;
const EXCERPTS_SHOWN = 3;

// ── Help text ────────────────────────────────────────────────────────────────

/** A definition available on demand, without stealing space from the count. */
export function HelpTip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={`What does "${label}" mean?`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="focusable rounded-full text-ink-400 hover:text-ink-700"
      >
        <Info aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-5 z-30 w-64 rounded-md border border-ink-200 bg-white p-2 text-[11px] leading-relaxed text-ink-700 shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ── Action summary ───────────────────────────────────────────────────────────

export interface ActionSummaryCard {
  key: string;
  label: string;
  count: number;
  definition: string;
  /** The full explanation, available on demand. */
  detail?: string;
  tone: "danger" | "warning" | "success" | "neutral";
  /** Opens the corresponding filtered queue. */
  onOpen?: () => void;
}

const TONE_RING: Record<ActionSummaryCard["tone"], string> = {
  danger: "border-red-200 bg-red-50/60",
  warning: "border-amber-200 bg-amber-50/60",
  success: "border-emerald-200 bg-emerald-50/60",
  neutral: "border-ink-200 bg-white",
};
const TONE_TEXT: Record<ActionSummaryCard["tone"], string> = {
  danger: "text-red-900",
  warning: "text-amber-900",
  success: "text-emerald-900",
  neutral: "text-ink-900",
};

/**
 * Four counts, each with a one-sentence definition and a way in.
 *
 * Replaces several paragraphs of dense prose that carried the same numbers.
 * The prose was accurate and nobody read it; the counts are the same counts,
 * computed by the same server plan.
 */
export function ActionSummary({ cards }: { cards: ActionSummaryCard[] }) {
  const shown = cards.filter((c) => c.count > 0 || c.key === "ready");
  if (!shown.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {shown.map((c) => (
        // The card is a GROUP, not a control. Making the whole card a button
        // put the help toggle inside it — a nested <button>, which is invalid
        // HTML, produces a hydration error, and gives assistive technology one
        // control where there are two.
        <div key={c.key} className={cn("rounded-lg border p-3", TONE_RING[c.tone])}>
          <div className="flex items-baseline gap-2">
            <span className={cn("text-2xl font-bold tabular-nums", TONE_TEXT[c.tone])}>{c.count}</span>
            <h4 className={cn("text-sm font-semibold", TONE_TEXT[c.tone])}>{c.label}</h4>
            {c.detail && <HelpTip label={c.label} text={c.detail} />}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{c.definition}</p>
          {c.onOpen && (
            <button
              type="button"
              onClick={c.onOpen}
              aria-label={`Show the ${c.count} ${c.label.toLowerCase()}`}
              className="focusable mt-1.5 inline-flex items-center gap-0.5 rounded text-[11px] font-medium text-brand-700 hover:underline"
            >
              Open queue <ChevronRight aria-hidden="true" className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * Task status first, document category second.
 *
 * Both are toggles with `aria-pressed`, both compose, and the active state is
 * stated in text as well as colour — a filter set you cannot read back is a
 * filter set you cannot trust.
 */
export function TaskFilterBar({
  filter,
  onChange,
  taskCounts,
  categoryCounts,
}: {
  filter: RecordsFilter;
  onChange: (f: RecordsFilter) => void;
  taskCounts: Record<TaskStatus, number>;
  categoryCounts: Record<string, number>;
}) {
  const active = isFilterActive(filter);
  const categories = DOC_TYPE_GROUPS.filter((g) => (categoryCounts[g.label] ?? 0) > 0);
  const activeNames = [
    ...filter.tasks.map((t) => TASK_LABEL[t]),
    filter.category,
    filter.query.trim() ? `matching “${filter.query.trim()}”` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <input
            className="input w-56 py-1.5 pl-7 text-sm"
            placeholder="Search records…"
            aria-label="Search records by filename, provider or facility"
            value={filter.query}
            onChange={(e) => onChange({ ...filter, query: e.target.value })}
          />
        </label>
        {active && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTER)}
            className="focusable rounded-md px-2 py-1 text-xs font-medium text-ink-600 underline hover:text-ink-900"
          >
            Clear filters
          </button>
        )}
        <span aria-live="polite" className="text-[11px] text-ink-500">
          {active ? `Filtered by ${activeNames.join(" · ")}` : "No filters applied"}
        </span>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">Task status</p>
        <div className="flex flex-wrap gap-1.5">
          {TASK_STATUSES.filter((t) => taskCounts[t] > 0).map((t) => {
            const on = filter.tasks.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                aria-label={`${TASK_LABEL[t]}, ${taskCounts[t]} record${taskCounts[t] === 1 ? "" : "s"}. ${TASK_DEFINITION[t]}`}
                title={TASK_DEFINITION[t]}
                onClick={() => onChange(toggleTask(filter, t))}
                className={cn(
                  "focusable inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  on ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-700 hover:bg-ink-200",
                )}
              >
                {TASK_LABEL[t]}
                <span aria-hidden="true" className={cn("rounded-full px-1.5 text-[10px] font-semibold", on ? "bg-white/20" : "bg-white text-ink-500")}>
                  {taskCounts[t]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {categories.length > 0 && (
        <details>
          <summary className="focusable inline-block cursor-pointer rounded text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            Record category{filter.category ? ` · ${filter.category}` : ""}
          </summary>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {categories.map((g) => {
              const on = filter.category === g.label;
              const Icon = GROUP_ICON[g.label];
              return (
                <button
                  key={g.label}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${g.label}, ${categoryCounts[g.label]} record${categoryCounts[g.label] === 1 ? "" : "s"}`}
                  onClick={() => onChange({ ...filter, category: on ? null : g.label })}
                  className={cn(
                    "focusable inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    on ? "bg-ink-800 text-white" : "bg-ink-50 text-ink-600 hover:bg-ink-100",
                  )}
                >
                  {Icon && <Icon aria-hidden="true" className="h-3 w-3" />}
                  {g.label}
                  <span aria-hidden="true" className="opacity-70">{categoryCounts[g.label]}</span>
                </button>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Document row ─────────────────────────────────────────────────────────────

/** Only what a reviewer needs to choose a row. Everything else is in detail. */
export function DocumentRow({
  doc,
  raw,
  selected,
  onOpen,
  actions,
  dateRange,
}: {
  doc: RecordsDoc;
  raw: AnyRec;
  selected: boolean;
  onOpen: () => void;
  actions: React.ReactNode;
  dateRange: string | null;
}) {
  const Icon = iconForType(doc.type);
  const attention = attentionCount(doc);
  const statuses = taskStatusesOf(doc);
  const failed = statuses.has("PROCESSING_FAILED");
  const reviewed = statuses.has("REVIEWED") && attention === 0 && !statuses.has("READY_TO_CONFIRM");

  // Provider and facility are shown ONLY when the extraction settled them. A
  // contradicted or low-confidence value is reported as needing review rather
  // than printed as though it were established.
  const contested = statuses.has("SOURCE_CONFLICT");
  const provider = !contested ? (raw.provider as string | null) : null;
  const facility = !contested ? (raw.facility as string | null) : null;

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-l-2 px-3 py-2.5 transition-colors",
        selected ? "border-brand-500 bg-brand-50/50" : "border-transparent hover:bg-ink-50/70",
      )}
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-600">
        <Icon aria-hidden="true" className="h-4 w-4" />
        <span className="sr-only">Record type: {TYPE_LABEL[doc.type] ?? doc.type.replace(/_/g, " ")}</span>
      </span>

      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className="focusable min-w-0 flex-1 rounded text-left"
      >
        <span className="block truncate text-sm font-medium text-ink-900">{doc.filename}</span>
        <span className="mt-0.5 block truncate text-xs text-ink-500">
          {[dateRange, provider, facility, doc.pageCount ? `${doc.pageCount} pp.` : null]
            .filter(Boolean)
            .join(" · ") || "No metadata extracted yet"}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {/* One semantic treatment per status, and never colour alone. */}
          {failed && <Badge tone="danger">processing failed</Badge>}
          {attention > 0 && (
            <Badge tone="warning">
              {attention} need{attention === 1 ? "s" : ""} attention
            </Badge>
          )}
          {statuses.has("READY_TO_CONFIRM") && attention === 0 && <Badge tone="info">ready to confirm</Badge>}
          {reviewed && <Badge tone="success">reviewed</Badge>}
          {contested && <Badge tone="warning">provider/facility needs review</Badge>}
        </span>
      </button>

      <div className="shrink-0">{actions}</div>
    </div>
  );
}

/**
 * Open / Rename / Reclassify / Remove, behind one labelled control.
 *
 * Remove is separated by a rule and styled as destructive, and it keeps the
 * existing two-step confirmation — a menu must not make deletion easier to
 * reach by accident than it was.
 */
export function DocumentActions({
  filename,
  viewHref,
  canEdit,
  onReclassify,
  onRename,
  onRemove,
}: {
  filename: string;
  viewHref: string;
  canEdit: boolean;
  onReclassify?: () => void;
  onRename?: () => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setConfirming(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setConfirming(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${filename}`}
        onClick={() => setOpen((v) => !v)}
        className="focusable rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-800"
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-ink-200 bg-white py-1 shadow-lg">
          <a
            role="menuitem"
            href={viewHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${filename} in a new tab`}
            className="focusable flex items-center gap-2 px-3 py-1.5 text-xs text-ink-800 hover:bg-ink-50"
            onClick={() => setOpen(false)}
          >
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /> Open the source file
          </a>
          {canEdit && onReclassify && (
            <button role="menuitem" type="button" aria-label={`Change the record type of ${filename}`} onClick={() => { setOpen(false); onReclassify(); }} className="focusable flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-800 hover:bg-ink-50">
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" /> Change record type
            </button>
          )}
          {canEdit && onRename && (
            <button role="menuitem" type="button" onClick={() => { setOpen(false); onRename(); }} className="focusable flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-800 hover:bg-ink-50">
              <FileText aria-hidden="true" className="h-3.5 w-3.5" /> Rename
            </button>
          )}
          {canEdit && onRemove && (
            <>
              {/* Separated deliberately: a destructive action must not sit flush
                  against the ordinary ones in a menu that opens under the cursor. */}
              <div className="my-1 border-t border-ink-100" />
              {confirming ? (
                <div className="px-3 py-1.5">
                  <p className="text-[11px] text-red-800">Remove {filename} and everything extracted from it?</p>
                  <div className="mt-1.5 flex gap-2">
                    <button type="button" className="focusable rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700" onClick={() => { setOpen(false); setConfirming(false); onRemove(); }}>
                      Confirm remove
                    </button>
                    <button type="button" className="focusable rounded px-1 text-[11px] font-medium text-ink-600 hover:underline" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button role="menuitem" type="button" onClick={() => setConfirming(true)} className="focusable flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-700 hover:bg-red-50">
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" /> Remove record…
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page coverage ────────────────────────────────────────────────────────────

export interface CoverageLine {
  label: string;
  /** null renders as "Not measured" — never as zero. */
  value: number | null;
  note?: string;
}

/**
 * What can honestly be said about a document's pages.
 *
 * A metric the client cannot compute says "Not measured". The previous copy
 * ("Confirm no missing pages") asked a reviewer to attest to something the
 * data never established.
 */
export function PageCoverage({ lines, findings }: { lines: CoverageLine[]; findings: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200">
        {lines.map((l) => (
          <div key={l.label} className="bg-white px-3 py-2">
            <dt className="text-[11px] text-ink-500">{l.label}</dt>
            <dd className={cn("text-sm font-semibold", l.value === null ? "text-ink-400" : "text-ink-900")}>
              {l.value === null ? "Not measured" : l.value.toLocaleString()}
            </dd>
            {l.note && <p className="text-[10px] text-ink-400">{l.note}</p>}
          </div>
        ))}
      </dl>
      {findings}
    </div>
  );
}

// ── Excerpt list ─────────────────────────────────────────────────────────────

export interface Excerpt {
  id: string;
  text: string;
  field?: string | null;
  page?: number | null;
}

/**
 * The first few source excerpts, then the rest on request.
 *
 * Labelled "first source excerpts" rather than "best": the payload carries no
 * ranking, and calling an arbitrary slice the best ones would be a claim the
 * data does not support.
 */
export function ExcerptList({ excerpts, label = "source excerpts" }: { excerpts: Excerpt[]; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const matching = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return excerpts;
    return excerpts.filter((e) => e.text.toLowerCase().includes(needle) || (e.field ?? "").toLowerCase().includes(needle));
  }, [excerpts, q]);

  if (!excerpts.length) return <p className="text-[11px] text-ink-400">No source excerpts recorded.</p>;

  const shown = expanded ? matching.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : excerpts.slice(0, EXCERPTS_SHOWN);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));

  return (
    <div className="space-y-1.5">
      {expanded && (
        <input
          className="input w-full py-1 text-xs"
          placeholder={`Search ${excerpts.length} excerpts…`}
          aria-label={`Search ${excerpts.length} source excerpts`}
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
        />
      )}
      <ul className="space-y-1">
        {shown.map((e) => (
          <li key={e.id} className="border-l-2 border-ink-200 pl-2 text-[11px]">
            <p className="text-ink-700">&ldquo;{e.text}&rdquo;</p>
            {(e.field || e.page != null) && (
              <p className="text-[10px] text-ink-400">
                {[e.field, e.page != null ? `p. ${e.page}` : null].filter(Boolean).join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>
      {expanded && matching.length === 0 && <p className="text-[11px] text-ink-400">No excerpt matches that search.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {!expanded && excerpts.length > EXCERPTS_SHOWN && (
          <button type="button" onClick={() => setExpanded(true)} className="focusable rounded text-[11px] font-medium text-brand-700 hover:underline">
            View all {excerpts.length} {label}
          </button>
        )}
        {expanded && (
          <>
            <button type="button" onClick={() => { setExpanded(false); setQ(""); setPage(0); }} className="focusable rounded text-[11px] font-medium text-ink-600 hover:underline">
              Show fewer
            </button>
            {pages > 1 && (
              <span className="flex items-center gap-1.5 text-[11px] text-ink-500">
                <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="focusable rounded px-1 font-medium text-brand-700 disabled:text-ink-300">Previous</button>
                <span aria-live="polite">Page {page + 1} of {pages}</span>
                <button type="button" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} className="focusable rounded px-1 font-medium text-brand-700 disabled:text-ink-300">Next</button>
              </span>
            )}
          </>
        )}
        {!expanded && excerpts.length > EXCERPTS_SHOWN && (
          <span className="text-[10px] text-ink-400">Showing the first {Math.min(EXCERPTS_SHOWN, excerpts.length)} of {excerpts.length}; these are the first excerpts on file, not a ranking.</span>
        )}
      </div>
    </div>
  );
}

// ── Paginated list ───────────────────────────────────────────────────────────

/**
 * A window over a long list.
 *
 * The 625-page production assembles into hundreds of notes. Rendering them all
 * is what made the page unusable; rendering a page of them at a time keeps
 * every one reachable.
 */
export function Paginated<T>({
  items,
  pageSize = PAGE_SIZE,
  children,
  emptyLabel = "Nothing here.",
  itemLabel = "items",
}: {
  items: readonly T[];
  pageSize?: number;
  children: (item: T, index: number) => React.ReactNode;
  emptyLabel?: string;
  itemLabel?: string;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const clamped = Math.min(page, pages - 1);
  const slice = items.slice(clamped * pageSize, clamped * pageSize + pageSize);

  if (!items.length) return <p className="py-6 text-center text-xs text-ink-400">{emptyLabel}</p>;

  return (
    <div className="space-y-2">
      <div className="space-y-2">{slice.map((item, i) => children(item, clamped * pageSize + i))}</div>
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-ink-100 pt-2 text-[11px] text-ink-600">
          <span aria-live="polite">
            Showing {clamped * pageSize + 1}–{Math.min(items.length, clamped * pageSize + pageSize)} of {items.length} {itemLabel}
          </span>
          <span className="flex items-center gap-2">
            <button type="button" disabled={clamped === 0} onClick={() => setPage(clamped - 1)} className="focusable rounded px-1.5 py-0.5 font-medium text-brand-700 disabled:text-ink-300">Previous</button>
            <button type="button" disabled={clamped >= pages - 1} onClick={() => setPage(clamped + 1)} className="focusable rounded px-1.5 py-0.5 font-medium text-brand-700 disabled:text-ink-300">Next</button>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Grain counts ─────────────────────────────────────────────────────────────

/** "17 encounters assembled from 37 extracted entries and 136 source fragments." */
export function GrainLine({ docs }: { docs: readonly RecordsDoc[] }) {
  const counts = grainCountsOf(docs);
  if (!counts.encounters && !counts.entries) return null;
  return (
    <p className="flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
      {grainSentence(counts)}
      <HelpTip label="encounter" text={GRAIN_HELP.encounters} />
      <HelpTip label="extracted entry" text={GRAIN_HELP.entries} />
      <HelpTip label="source fragment" text={GRAIN_HELP.fragments} />
    </p>
  );
}

// ── Detail pane shell ────────────────────────────────────────────────────────

export type DetailTab = "overview" | "encounters" | "review" | "coverage" | "excerpts";

export const DETAIL_TAB_LABEL: Record<DetailTab, string> = {
  overview: "Overview",
  encounters: "Encounters",
  review: "Needs review",
  coverage: "Page coverage",
  excerpts: "Source excerpts",
};

/**
 * The document detail surface.
 *
 * A side pane on desktop so the list stays in context, and a full-screen panel
 * below `lg` with an explicit Close — the list's scroll and filter state live
 * in the parent, so closing returns to exactly where the reviewer was.
 */
export function DetailPane({
  title,
  subtitle,
  tab,
  onTab,
  reviewCount,
  onClose,
  children,
}: {
  title: string;
  subtitle: string | null;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  reviewCount: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={`Details for ${title}`}
      className="flex h-full flex-col overflow-hidden rounded-lg border border-ink-200 bg-white max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:rounded-none"
    >
      <header className="flex items-start gap-2 border-b border-ink-200 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-ink-900">{title}</h3>
          {subtitle && <p className="truncate text-[11px] text-ink-500">{subtitle}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close document details" className="focusable rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-800">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>
      <nav aria-label="Document sections" className="flex gap-1 overflow-x-auto border-b border-ink-200 px-2 py-1.5">
        {(Object.keys(DETAIL_TAB_LABEL) as DetailTab[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? "page" : undefined}
            onClick={() => onTab(t)}
            className={cn(
              "focusable shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              tab === t ? "bg-brand-50 text-brand-800" : "text-ink-600 hover:bg-ink-50",
            )}
          >
            {DETAIL_TAB_LABEL[t]}
            {t === "review" && reviewCount > 0 && (
              <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800">{reviewCount}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

/** Loading / empty / error, said explicitly rather than left blank. */
export function StateNote({ kind, children }: { kind: "loading" | "empty" | "error"; children: React.ReactNode }) {
  const Icon = kind === "error" ? AlertTriangle : kind === "empty" ? Info : CheckCircle2;
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-1.5 py-6 text-center text-xs",
        kind === "error" ? "text-red-700" : "text-ink-400",
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

export { ChevronDown, TYPE_GROUP };
