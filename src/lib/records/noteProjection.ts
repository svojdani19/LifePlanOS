// ─────────────────────────────────────────────────────────────────────────────
// The reviewable unit is the canonical NOTE.
//
// A reviewer was being asked one question per extraction row — and rows are
// chunk fragments, so three page-slices of one operative note were three
// signatures. Measured on a real case: 561 rows consolidate into 227 notes,
// 84 of them from more than one row. Well over half the decisions existed only
// because the review surface was finer-grained than the record.
//
// The note is what the chronology cites, what the report prints and what the
// plan is built from, so reviewing it is reviewing the actual assertion. The
// rows stay visible beneath as evidence — every claim, every citation, every
// content hash — because a signature must be inspectable.
//
// Two rules keep consolidation honest:
//   • a note shows the WORST status among its rows, so nothing is laundered;
//   • a note carrying any open entry/claim finding is an exception, not clean.
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalNoteId } from "@/lib/records/reviewBurden";
import { isOpenFinding, type FindingScope } from "@/lib/records/findingScope";
import { guidanceFor, type ReviewGuidance } from "@/lib/records/reviewGuidance";
import type { StructuredEncounter } from "@/lib/records/structuredRecord";

/** Worst-first: a note may never present better than its weakest row. */
const STATUS_RANK: Record<string, number> = {
  GENERATION_LOSS: 0,
  STALE: 1,
  AI_DRAFT: 2,
  AI_AUDIT_PASSED: 3,
  HUMAN_EDITED: 4,
  REVIEWED: 5,
  VERIFIED: 6,
};
const AUDIT_RANK: Record<string, number> = {
  FAILED: 0,
  SOURCE_CONFLICT: 1,
  EXTRACTION_INCOMPLETE: 2,
  NEEDS_HUMAN_REVIEW: 3,
  PASS: 4,
};

export interface NoteFinding {
  id: string;
  scope: FindingScope;
  type: string;
  severity: string;
  blocking: boolean;
  source: string;
  detail: string;
  excerpt?: string | null;
  field?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  encounterId?: string | null;
  claimIndex?: number | null;
  status: string;
}

export interface ReviewableNote {
  /** Stable identity: the document plus the rows this note consolidates. */
  id: string;
  sourceDocumentId: string;
  rowIds: string[];
  /** Every underlying row, in full — evidence, not separate decisions. */
  rows: StructuredEncounter[];
  encounterDate: string | null;
  encounterDateEnd: string | null;
  dateStatus: string;
  /** True when the source documents an explicitly open-ended range. */
  openEndedRange: boolean;
  provider: string | null;
  providerCredentials: string | null;
  facility: string | null;
  encounterType: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** Union of every claim across the note's rows. */
  claims: StructuredEncounter["claims"];
  claimCount: number;
  /** Content hash per row, submitted with a review so nothing is signed unseen. */
  contentHashes: { rowId: string; contentHash: string }[];
  /** The WORST status and audit result among the note's rows. */
  status: string;
  auditResult: string | null;
  /** Findings targeted at this note, its entries or their claims. */
  findings: NoteFinding[];
  /** Copies of this record primarily reviewed under another document. */
  copies: NonNullable<StructuredEncounter["copies"]>;
  /** Set when THIS note is itself a copy reviewed elsewhere. */
  reviewedWith?: { filename: string } | null;
  corroboration?: StructuredEncounter["corroboration"];
  /**
   * Why this record is where it is, and what to do about it. Present on every
   * note — a card that says only "needs review" leaves a reviewer guessing.
   */
  guidance: ReviewGuidance;
  /** An exception needing correction or disposition. */
  needsAttention: boolean;
  /** Clean, and awaiting one human attestation. */
  awaitingAttestation: boolean;
}

const worst = <T extends string>(values: readonly (T | null)[], rank: Record<string, number>, fallback: T): T => {
  let bestKey: T = fallback;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const v of values) {
    if (v == null) continue;
    const r = rank[v] ?? Number.POSITIVE_INFINITY;
    if (r < bestRank) {
      bestRank = r;
      bestKey = v;
    }
  }
  return bestKey;
};

/**
 * Build the reviewable notes for one document.
 *
 * `segments` is what `buildRecords` persisted; a row no segment claims becomes
 * its own single-row note, so consolidation can never make a row unreviewable.
 */
export function projectNotes(
  documentId: string,
  segments: unknown,
  rows: readonly StructuredEncounter[],
  findings: readonly NoteFinding[],
): ReviewableNote[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const claimed = new Set<string>();
  const groups: string[][] = [];

  const segs = Array.isArray(segments) ? (segments as { rowIds?: unknown }[]) : [];
  for (const seg of segs) {
    const ids = Array.isArray(seg?.rowIds) ? (seg.rowIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const live = ids.filter((id) => byId.has(id) && !claimed.has(id));
    if (!live.length) continue;
    for (const id of live) claimed.add(id);
    groups.push(live);
  }
  for (const r of rows) if (!claimed.has(r.id)) groups.push([r.id]);

  const openByEntry = new Map<string, NoteFinding[]>();
  for (const f of findings) {
    if (!f.encounterId) continue;
    openByEntry.set(f.encounterId, [...(openByEntry.get(f.encounterId) ?? []), f]);
  }

  return groups.map((rowIds) => {
    const noteRows = rowIds.map((id) => byId.get(id)!).filter(Boolean);
    const id = canonicalNoteId(documentId, rowIds);
    const noteFindings = [
      ...findings.filter((f) => f.scope === "NOTE" && (f as { canonicalNoteId?: string }).canonicalNoteId === id),
      ...rowIds.flatMap((rid) => openByEntry.get(rid) ?? []),
    ];
    const openFindings = noteFindings.filter((f) => isOpenFinding(f.status));

    const dated = noteRows.find((r) => r.encounterDate) ?? noteRows[0];
    const status = worst(noteRows.map((r) => r.status), STATUS_RANK, "AI_DRAFT");
    const auditResult = worst(
      noteRows.map((r) => (r as { auditResult?: string | null }).auditResult ?? null),
      AUDIT_RANK,
      "PASS",
    );
    const pages = noteRows.flatMap((r) => [r.page, r.pageEnd]).filter((p): p is number => typeof p === "number");

    const guidance = guidanceFor({
      status,
      auditResult,
      // WORST case across the note's fragments, so the explanation and the
      // flag are computed from the same facts. Reading the date off the first
      // dated fragment alone made 27 records display "ready to attest" inside
      // an amber needs-review panel.
      dateStatus: noteRows.some((r) => r.dateStatus === "UNKNOWN") ? "UNKNOWN" : (dated?.dateStatus ?? "UNKNOWN"),
      auditVersion: noteRows.find((r) => (r as { auditVersion?: string | null }).auditVersion)?.auditVersion ?? null,
      // Worst case across the note's rows: one disputed fragment disputes the
      // record, and one contradicted field contradicts it.
      unresolvedDisputes: noteRows.reduce((n, r) => n + ((r as { unresolvedDisputes?: number | null }).unresolvedDisputes ?? 0), 0),
      contradictedFields: [...new Set(noteRows.flatMap((r) => (r as { contradictedFields?: string[] | null }).contradictedFields ?? []))],
      staleReason: noteRows.find((r) => r.staleReason)?.staleReason ?? null,
      corroboration: noteRows.find((r) => r.corroboration)?.corroboration as never,
      findings: openFindings as never,
      // The extractor's own per-claim warnings, carrying the field and page.
      // They are the evidence behind a review flag; without them the card can
      // only say that something, somewhere, was flagged.
      claimWarnings: noteRows.flatMap((r) =>
        r.claims
          .filter((c) => (c as { warning?: string | null }).warning)
          .map((c) => ({ field: c.field ?? null, page: c.page ?? null, warning: (c as { warning?: string | null }).warning ?? null })),
      ),
    });

    // One source of truth: a record is an exception exactly when its
    // explanation says it is. The panel and the flag cannot disagree.
    const needsAttention = openFindings.length > 0 || guidance.kind !== "CLEAN";

    return {
      id,
      sourceDocumentId: documentId,
      rowIds,
      rows: noteRows,
      encounterDate: dated?.encounterDate ?? null,
      encounterDateEnd: dated?.encounterDateEnd ?? null,
      dateStatus: dated?.dateStatus ?? "UNKNOWN",
      openEndedRange: Boolean(dated?.encounterDate && !dated?.encounterDateEnd && (dated as { openEndedRange?: boolean }).openEndedRange),
      provider: noteRows.find((r) => r.provider)?.provider ?? null,
      providerCredentials: noteRows.find((r) => r.providerCredentials)?.providerCredentials ?? null,
      facility: noteRows.find((r) => r.facility)?.facility ?? null,
      encounterType: noteRows.find((r) => r.encounterType)?.encounterType ?? null,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      claims: noteRows.flatMap((r) => r.claims),
      claimCount: noteRows.reduce((n, r) => n + r.claims.length, 0),
      contentHashes: noteRows.map((r) => ({ rowId: r.id, contentHash: r.contentHash })),
      status,
      auditResult,
      findings: noteFindings,
      copies: noteRows.flatMap((r) => r.copies ?? []),
      reviewedWith: noteRows.find((r) => r.reviewedWith)?.reviewedWith ?? null,
      corroboration: noteRows.find((r) => r.corroboration)?.corroboration ?? null,
      guidance,
      needsAttention,
      // Clean means: nothing open, and every row is still a machine draft
      // awaiting the one human decision this note deserves.
      awaitingAttestation: !needsAttention && noteRows.every((r) => r.status === "AI_DRAFT" || r.status === "AI_AUDIT_PASSED"),
    };
  });
}
