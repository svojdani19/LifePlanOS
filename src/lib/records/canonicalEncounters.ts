// ─────────────────────────────────────────────────────────────────────────────
// ONE canonical encounter, however many extraction fragments produced it.
//
// The review surface, the burden metric and the server's own membership
// derivation all have to answer the same question — "which rows are this one
// real note?" — and each of them was answering it separately. Two of them read
// `Document.segments[].rowIds` and treated an unclaimed row as a note of one;
// the third re-derived membership from the request. So a document whose
// segments still carry the INGEST-time shape (dates, pages, offsets and a
// summary, written before any extraction row existed and therefore carrying no
// rowIds) presented every fragment as its own signature: hundreds of decisions
// for a chart that documents dozens of visits.
//
// This module is that question, asked once. It is pure, deterministic and
// order-independent, and it reuses the records builder's own identity
// primitives rather than approximating them — `identityFactsOf` for what
// identity is read from, `groupByIdentity`/`decideIdentity` for the decision.
// A second, looser copy of "same document, same date" is exactly the drift
// this exists to prevent: a date is not an identity, and two notes in one
// production on one day are two notes.
//
// THE RULES, in the order they apply:
//
//   1. VALID PERSISTED ROW IDS ARE AUTHORITATIVE. A segment the records
//      builder enriched already encodes the builder's full reasoning — note
//      structure, splitting, cross-document dedupe, adjudication. Nothing here
//      re-litigates it, and nothing here writes anything back.
//
//   2. THE FALLBACK IS FOR DOCUMENTS THAT HAVE NO SUCH MEMBERSHIP AT ALL.
//      Not "some rows are unclaimed" — a document with one enriched segment
//      keeps the builder's answer, and its unclaimed rows stay notes of one,
//      exactly as before.
//
//   3. THE FALLBACK NEVER LEAVES ITS DOCUMENT. Cross-document copies are
//      folded only by the proven persisted linkage; identity within one
//      production is all this decides. A fallback that reached across
//      documents would be a scope widening dressed as a convenience.
//
//   4. AMBIGUITY IS NOT GUESSED. Fragments the identity rules can neither join
//      nor separate stay separate and say so — ONCE, for the whole cluster
//      they are unsure about, not once per fragment. One unresolved question
//      is one decision.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";
import { groupByIdentity } from "@/lib/records/encounterIdentity";
import { identityFactsOf, type MergeableRow } from "@/lib/records/entryMerge";

/**
 * A row as canonical grouping needs it.
 *
 * Every identity-bearing field is OPTIONAL so a thin caller degrades safely:
 * a missing field is UNKNOWN to the identity rules, and unknown never reads as
 * agreement. A caller that supplies less gets FEWER merges, never wrong ones.
 */
export interface CanonicalRow {
  id: string;
  sourceDocumentId: string;
  /** ISO "YYYY-MM-DD" or a Date; null when the row carries no date. */
  encounterDate?: string | Date | null;
  /** DOCUMENTED | INFERRED | UNKNOWN | DISPUTED. */
  dateStatus?: string | null;
  analysisClass?: string | null;
  provider?: string | null;
  facility?: string | null;
  page?: number | null;
  pageEnd?: number | null;
  substanceClass?: string | null;
  /** Stable identity of the sub-document a row came from, when known. */
  segmentKey?: string | null;
  claims?: readonly { field: string; value: string; excerpt?: string | null; page?: number | null }[];
}

/** Where a group's membership came from — carried so a decision can be audited. */
export type MembershipBasis =
  /** The records builder's own persisted rowIds. Authoritative. */
  | "PERSISTED_SEGMENT"
  /** A row no enriched segment claimed, in a document that has enriched ones. */
  | "PERSISTED_SEGMENT_ORPHAN"
  /** Derived here, because the document has no enriched row membership at all. */
  | "COMPATIBILITY_FALLBACK"
  /**
   * A row whose document the caller did not supply. Nothing can be proven
   * about its membership, so it stays a note of one.
   */
  | "SINGLETON_UNKNOWN_DOCUMENT";

export interface CanonicalEncounterGroup {
  documentId: string;
  /** In the order the persisted segment named them, or document row order. */
  rowIds: string[];
  basis: MembershipBasis;
  /**
   * True on the ONE group that carries an unresolved assignment question for
   * its whole cluster. The other groups in the cluster are not separate
   * obligations — the question is asked once.
   */
  ambiguousAssignment: boolean;
  /** Rows this group was neither proven to include nor proven to exclude. */
  ambiguousWith: string[];
}

export interface CanonicalGroupingInput {
  documents: readonly { id: string; segments: unknown }[];
  /**
   * The rows in scope. The CALLER is responsible for tenant/case/lifecycle
   * filtering — this module never widens what it was given, and a row whose
   * document is not in `documents` never forms a group.
   */
  rows: readonly CanonicalRow[];
  /**
   * Extra row ids a persisted segment may legitimately name — a cross-document
   * copy the caller resolved from elsewhere in the case.
   *
   * MEMBERSHIP ONLY. Such a row can join a persisted segment (which is how the
   * builder recorded the copy in the first place) but is never a candidate for
   * the compatibility fallback, so the fallback cannot reach outside the rows
   * the caller supplied.
   */
  alsoResolvable?: (rowId: string) => boolean;
}

interface Segment {
  rowIds?: unknown;
}

const segmentsOf = (segments: unknown): Segment[] =>
  Array.isArray(segments) ? (segments as Segment[]).filter((s) => s && typeof s === "object") : [];

const rowIdsOf = (seg: Segment): string[] =>
  Array.isArray(seg.rowIds) ? (seg.rowIds as unknown[]).filter((x): x is string => typeof x === "string") : [];

/**
 * Does this document carry enriched row membership the builder wrote?
 *
 * The test is a rowId that RESOLVES, not merely a rowId that is present: a
 * segment naming only superseded rows describes a state the case has left, and
 * treating it as membership would freeze the document on history.
 */
export function hasEnrichedRowMembership(segments: unknown, resolves: (rowId: string) => boolean): boolean {
  return segmentsOf(segments).some((seg) => rowIdsOf(seg).some(resolves));
}

/**
 * The identity facts of a row, read through the builder's own reader.
 *
 * Deliberately routed through `identityFactsOf` rather than rebuilt here.
 * There is exactly one definition of what identity is decided from, and a
 * second one — however faithful on the day it was written — is a divergence
 * waiting to happen.
 *
 * `span` is null: this path has no document text to locate a row in, so span
 * comparison stays UNKNOWN. Unknown is not agreement, so the absence costs
 * merges rather than causing wrong ones.
 */
const factsOf = (row: CanonicalRow) => identityFactsOf(toMergeableRow(row), null);

function toMergeableRow(row: CanonicalRow): MergeableRow {
  const date =
    row.encounterDate instanceof Date
      ? row.encounterDate
      : typeof row.encounterDate === "string" && row.encounterDate
        ? new Date(`${row.encounterDate.slice(0, 10)}T00:00:00Z`)
        : null;
  return {
    id: row.id,
    sourceDocumentId: row.sourceDocumentId,
    analysisClass: (row.analysisClass ?? null) as AnalysisClass | null,
    encounterDate: date && Number.isFinite(date.getTime()) ? date : null,
    provider: row.provider ?? null,
    facility: row.facility ?? null,
    page: row.page ?? null,
    pageEnd: row.pageEnd ?? null,
    substanceClass: row.substanceClass ?? null,
    dateStatus: row.dateStatus ?? null,
    segmentKey: row.segmentKey ?? null,
    claims: (row.claims ?? []).map((c) => ({
      field: c.field,
      value: c.value,
      excerpt: c.excerpt ?? "",
      page: c.page ?? null,
    })),
  };
}

/**
 * Resolve a case's rows into canonical encounters.
 *
 * Returns groups in a stable order: for each document in the order given, its
 * persisted segments first, then whatever the fallback or the orphan rule
 * produced from that document's remaining rows.
 */
export function groupCanonicalEncounters(input: CanonicalGroupingInput): CanonicalEncounterGroup[] {
  const rowsById = new Map(input.rows.map((r) => [r.id, r]));
  const resolves = (id: string): boolean => rowsById.has(id) || Boolean(input.alsoResolvable?.(id));

  const claimed = new Set<string>();
  const groups: CanonicalEncounterGroup[] = [];
  const enrichedDocuments = new Set<string>();

  // ── Pass 1: the builder's own answer, unchanged ──────────────────────────
  // Consumed for EVERY document before any fallback runs, so a row a segment
  // in one document legitimately claims can never also be pulled into another
  // document's fallback.
  for (const doc of input.documents) {
    if (!hasEnrichedRowMembership(doc.segments, resolves)) continue;
    enrichedDocuments.add(doc.id);
    for (const seg of segmentsOf(doc.segments)) {
      const live = rowIdsOf(seg).filter((id) => resolves(id) && !claimed.has(id));
      if (!live.length) continue;
      for (const id of live) claimed.add(id);
      groups.push({ documentId: doc.id, rowIds: live, basis: "PERSISTED_SEGMENT", ambiguousAssignment: false, ambiguousWith: [] });
    }
  }

  // ── Pass 2: what is left, per document ──────────────────────────────────
  for (const doc of input.documents) {
    const remaining = input.rows.filter((r) => r.sourceDocumentId === doc.id && !claimed.has(r.id));
    if (!remaining.length) continue;
    for (const r of remaining) claimed.add(r.id);

    // A document the builder DID enrich keeps its answer. An unclaimed row
    // there is a row the builder saw and left out, and it stays a note of one
    // so consolidation can never make a row unreviewable.
    if (enrichedDocuments.has(doc.id)) {
      for (const r of remaining) {
        groups.push({ documentId: doc.id, rowIds: [r.id], basis: "PERSISTED_SEGMENT_ORPHAN", ambiguousAssignment: false, ambiguousWith: [] });
      }
      continue;
    }

    groups.push(...fallbackGroups(doc.id, remaining));
  }

  // ── Pass 3: a row whose document the caller did not supply ──────────────
  // Its persisted membership is unknown rather than absent, so the fallback
  // must not run over it — it stays a note of one, which is what it was
  // before. Nothing is looked up to fill the gap: this module answers only
  // about what it was given, and that is what keeps a compatibility path from
  // widening a query.
  for (const row of input.rows) {
    if (claimed.has(row.id)) continue;
    claimed.add(row.id);
    groups.push({
      documentId: row.sourceDocumentId,
      rowIds: [row.id],
      basis: "SINGLETON_UNKNOWN_DOCUMENT",
      ambiguousAssignment: false,
      ambiguousWith: [],
    });
  }

  return groups;
}

/**
 * Group one document's rows by proven identity alone.
 *
 * `groupByIdentity` merges only on evidence `decideIdentity` calls decisive —
 * a shared segment key inside the document, an overlapping source span, a
 * matching record identifier, a specific procedure both sides name on one
 * date, or distinctive clinical agreement on a shared date. A shared date on
 * its own merges nothing, an undated pair merges only on exact stored note
 * identity, and any conflict (different provider, facility, time, clinical
 * class, segment key) keeps the rows apart.
 */
function fallbackGroups(documentId: string, rows: readonly CanonicalRow[]): CanonicalEncounterGroup[] {
  const identified = groupByIdentity(rows, factsOf);
  const groups: CanonicalEncounterGroup[] = identified.map((g) => ({
    documentId,
    rowIds: g.members.map((m) => m.id),
    basis: "COMPATIBILITY_FALLBACK" as const,
    ambiguousAssignment: false,
    ambiguousWith: [] as string[],
  }));

  // ── One question, asked once ────────────────────────────────────────────
  // A fragment the rules could neither join to a group nor separate from it is
  // recorded against BOTH sides, so raising an exception per group would raise
  // one per fragment — the very inflation this module exists to remove. The
  // unsure relations are transitively closed into clusters, and each cluster
  // raises a single exception on one anchor group. The anchor is the cluster's
  // lowest-indexed group, and `groupByIdentity` orders deterministically, so
  // the anchor is stable across runs.
  const groupOfRow = new Map<string, number>();
  groups.forEach((g, at) => g.rowIds.forEach((id) => groupOfRow.set(id, at)));

  const parent = groups.map((_, at) => at);
  const find = (at: number): number => {
    let root = at;
    while (parent[root] !== root) root = parent[root];
    for (let cur = at; parent[cur] !== root; ) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  let anyUnsure = false;
  identified.forEach((g, at) => {
    for (const rowId of g.possibleDuplicateOf) {
      const other = groupOfRow.get(rowId);
      if (other == null || other === at) continue;
      anyUnsure = true;
      union(at, other);
    }
  });
  if (!anyUnsure) return groups;

  const clusters = new Map<number, number[]>();
  groups.forEach((_, at) => {
    const root = find(at);
    clusters.set(root, [...(clusters.get(root) ?? []), at]);
  });
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    const anchor = groups[root];
    anchor.ambiguousAssignment = true;
    anchor.ambiguousWith = members
      .filter((at) => at !== root)
      .flatMap((at) => groups[at].rowIds)
      .sort();
  }
  return groups;
}
