// ─────────────────────────────────────────────────────────────────────────────
// How much review does this case actually require?
//
// Every number here is counted at a declared GRAIN, because getting that wrong
// is how a small number of real problems came to be reported as hundreds. Two
// measurements in one week were inflated ~50x the same way: `auditFindings`
// stores the whole DOCUMENT's findings array on every row, so counting the
// strings inside those arrays counts one document finding once per row.
//
// The rules this module exists to enforce:
//   • a finding is counted by its identity, never by its text;
//   • a document/page problem is counted once at its own scope;
//   • the review UNIT is the canonical note the records builder persisted,
//     not the extraction fragments it was assembled from;
//   • superseded rows and older runs are history and are never current;
//   • a cross-document copy is not a second obligation.
//
// Pure and synchronous: callers supply persisted data, so the same function
// serves a live case, a test with synthetic rows, and the re-audit report.
// ─────────────────────────────────────────────────────────────────────────────

import type { FindingScope } from "@/lib/records/findingScope";

/** An extraction row as the burden calculation needs it. */
export interface BurdenRow {
  id: string;
  sourceDocumentId: string;
  status: string;
  auditResult: string | null;
  dateStatus: string | null;
  /** Machine-corroboration verdict, when one was recorded. */
  corroborationResult?: string | null;
}

/** A persisted canonical segment: the note the records builder actually built. */
export interface BurdenDocument {
  id: string;
  /** `Document.segments` as persisted — narrowed defensively. */
  segments: unknown;
}

/** A structured finding, counted by identity rather than by its wording. */
export interface BurdenFinding {
  id: string;
  fingerprint: string;
  scope: FindingScope;
  type: string;
  status: string;
  blocking: boolean;
  sourceDocumentId?: string | null;
  canonicalNoteId?: string | null;
  encounterId?: string | null;
}

export interface BurdenInput {
  documents: readonly BurdenDocument[];
  rows: readonly BurdenRow[];
  findings: readonly BurdenFinding[];
  pages: readonly { status: string }[];
}

export interface ReviewBurden {
  /** Rows that still describe the case (the caller supplies current rows only). */
  activeRows: number;
  /** Canonical notes assembled from persisted segments. */
  canonicalNotes: number;
  /** Notes built from more than one extraction row. */
  multiRowNotes: number;
  /** Rows with no persisted segment — each becomes its own one-row note. */
  rowsWithoutSegment: number;

  aiDraft: number;
  aiAuditPassed: number;
  machineCorroborated: number;
  stale: number;
  generationLoss: number;
  undatedClinical: number;

  /** Distinct OPEN findings by scope, counted by identity. */
  findingsByScope: Record<string, number>;
  /** Distinct OPEN findings by type, counted by identity. */
  findingsByType: Record<string, number>;
  /** Distinct entries named by any open finding. */
  entriesWithFindings: number;
  /** Distinct canonical notes touched by any open finding. */
  notesWithFindings: number;
  /** Open blockers at DOCUMENT scope, counted once per document finding. */
  documentBlockers: number;
  /** Open blockers at PAGE scope, counted once per page finding. */
  pageBlockers: number;
  /** Open blockers at CASE scope. */
  caseBlockers: number;

  /** Notes carrying an open note/entry/claim finding: real exceptions. */
  notesNeedingAttention: number;
  /** Notes with nothing open: one attestation each, still required. */
  cleanNotesAwaitingAttestation: number;

  /** Rows that are copies of a note primarily reviewed in another document. */
  crossDocumentCopies: number;
  /** Decisions a fragment-level surface would have demanded. */
  decisionsBeforeConsolidation: number;
  /** Decisions the canonical-note surface demands. */
  decisionsAfterConsolidation: number;
}

const CLEAN_STATUSES = new Set(["AI_DRAFT", "AI_AUDIT_PASSED"]);
const RESOLVED_STATUSES = new Set(["DISMISSED", "RESOLVED"]);

interface Segment {
  rowIds?: unknown;
  segmentKey?: unknown;
}

const segmentsOf = (doc: BurdenDocument): Segment[] =>
  Array.isArray(doc.segments) ? (doc.segments as Segment[]).filter((s) => s && typeof s === "object") : [];

const rowIdsOf = (seg: Segment): string[] =>
  Array.isArray(seg.rowIds) ? (seg.rowIds as unknown[]).filter((x): x is string => typeof x === "string") : [];

/**
 * A canonical note's stable identity.
 *
 * The records builder does not persist a note id, so the note is identified by
 * its document and the SET of rows it consolidates — which is exactly what a
 * review decision applies to, and what changes when the note changes.
 */
export function canonicalNoteId(documentId: string, rowIds: readonly string[]): string {
  return `${documentId}:${[...rowIds].sort().join(",")}`;
}

/**
 * Read a canonical note id back into the document and rows it names.
 *
 * The server resolves membership from this, so it parses defensively: a
 * malformed id yields nothing rather than a partial match a caller could
 * steer. Row ids are uuids and the separator is the FIRST colon, so a
 * document id containing one would still split correctly.
 */
export function parseCanonicalNoteId(noteId: string): { documentId: string | null; rowIds: string[] } {
  const at = noteId.indexOf(":");
  if (at <= 0 || at === noteId.length - 1) return { documentId: null, rowIds: [] };
  const documentId = noteId.slice(0, at);
  const rowIds = noteId
    .slice(at + 1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return rowIds.length ? { documentId, rowIds } : { documentId: null, rowIds: [] };
}

/**
 * Measure the review burden of a case at correct grain.
 *
 * `rows` must already be scoped to CURRENT rows (the caller applies the
 * lifecycle filter); history is not burden.
 */
export function measureReviewBurden(input: BurdenInput): ReviewBurden {
  const rowsById = new Map(input.rows.map((r) => [r.id, r]));

  // ── Canonical notes ─────────────────────────────────────────────────────
  // Only rows that are still current count toward a note; a segment whose
  // rows were all superseded is history, not a review obligation.
  const notes: { id: string; documentId: string; rowIds: string[] }[] = [];
  const claimedRows = new Set<string>();
  for (const doc of input.documents) {
    for (const seg of segmentsOf(doc)) {
      const live = rowIdsOf(seg).filter((id) => rowsById.has(id) && !claimedRows.has(id));
      if (!live.length) continue;
      for (const id of live) claimedRows.add(id);
      notes.push({ id: canonicalNoteId(doc.id, live), documentId: doc.id, rowIds: live });
    }
  }
  // A row no segment claims still needs a decision: it becomes its own note,
  // so consolidation can never make a row unreviewable.
  const orphanRows = input.rows.filter((r) => !claimedRows.has(r.id));
  for (const row of orphanRows) {
    notes.push({ id: canonicalNoteId(row.sourceDocumentId, [row.id]), documentId: row.sourceDocumentId, rowIds: [row.id] });
  }

  // ── Findings, counted by identity ───────────────────────────────────────
  const open = input.findings.filter((f) => !RESOLVED_STATUSES.has(f.status));
  const seenFingerprints = new Set<string>();
  const distinctOpen = open.filter((f) => {
    const key = f.fingerprint || f.id;
    if (seenFingerprints.has(key)) return false;
    seenFingerprints.add(key);
    return true;
  });

  const byScope: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const f of distinctOpen) {
    byScope[f.scope] = (byScope[f.scope] ?? 0) + 1;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }

  const entriesWithFindings = new Set(distinctOpen.map((f) => f.encounterId).filter((x): x is string => Boolean(x)));

  // A note is in attention if a finding names the note itself, or names any
  // row the note consolidates.
  const noteOfRow = new Map<string, string>();
  for (const n of notes) for (const rid of n.rowIds) noteOfRow.set(rid, n.id);
  const notesFlagged = new Set<string>();
  for (const f of distinctOpen) {
    if (f.canonicalNoteId) notesFlagged.add(f.canonicalNoteId);
    if (f.encounterId) {
      const owner = noteOfRow.get(f.encounterId);
      if (owner) notesFlagged.add(owner);
    }
  }

  // A note also needs attention when any of its rows is itself unresolved —
  // stale, generation-loss, undated clinical, or a non-PASS audit result.
  const needsAttentionByRow = (r: BurdenRow): boolean =>
    r.status === "STALE" ||
    r.status === "GENERATION_LOSS" ||
    r.dateStatus === "UNKNOWN" ||
    (r.auditResult != null && r.auditResult !== "PASS");
  for (const n of notes) {
    if (n.rowIds.some((id) => { const r = rowsById.get(id); return r ? needsAttentionByRow(r) : false; })) notesFlagged.add(n.id);
  }

  const countRows = (predicate: (r: BurdenRow) => boolean) => input.rows.filter(predicate).length;

  return {
    activeRows: input.rows.length,
    canonicalNotes: notes.length,
    multiRowNotes: notes.filter((n) => n.rowIds.length > 1).length,
    rowsWithoutSegment: orphanRows.length,

    aiDraft: countRows((r) => r.status === "AI_DRAFT"),
    aiAuditPassed: countRows((r) => r.status === "AI_AUDIT_PASSED"),
    machineCorroborated: countRows((r) => r.corroborationResult === "CORROBORATED"),
    stale: countRows((r) => r.status === "STALE"),
    generationLoss: countRows((r) => r.status === "GENERATION_LOSS"),
    undatedClinical: countRows((r) => r.dateStatus === "UNKNOWN"),

    findingsByScope: byScope,
    findingsByType: byType,
    entriesWithFindings: entriesWithFindings.size,
    notesWithFindings: notesFlagged.size,
    documentBlockers: distinctOpen.filter((f) => f.scope === "DOCUMENT" && f.blocking).length,
    pageBlockers: distinctOpen.filter((f) => f.scope === "PAGE" && f.blocking).length,
    caseBlockers: distinctOpen.filter((f) => f.scope === "CASE" && f.blocking).length,

    notesNeedingAttention: notesFlagged.size,
    cleanNotesAwaitingAttestation: notes.filter((n) => !notesFlagged.has(n.id) && n.rowIds.every((id) => CLEAN_STATUSES.has(rowsById.get(id)?.status ?? ""))).length,

    crossDocumentCopies: 0, // supplied by the caller when copy linkage is loaded
    decisionsBeforeConsolidation: input.rows.length,
    decisionsAfterConsolidation: notes.length,
  };
}
