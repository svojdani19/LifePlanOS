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

import { requiresDate } from "@/lib/documents/analysisClass";
import type { FindingScope } from "@/lib/records/findingScope";

/**
 * Is this row a real dating gap, or material that never carries a date?
 *
 * A legacy row with no recorded kind is treated as needing one: the
 * conservative reading keeps a genuine gap visible rather than excusing it.
 */
const isUndatedAndShouldBeDated = (r: BurdenRow): boolean =>
  r.dateStatus === "UNKNOWN" && requiresDate((r.analysisClass ?? null) as never);

/** An extraction row as the burden calculation needs it. */
export interface BurdenRow {
  id: string;
  sourceDocumentId: string;
  status: string;
  auditResult: string | null;
  dateStatus: string | null;
  /**
   * The KIND of material this row came from.
   *
   * Without it, `undatedClinical` counted every dateless row — including the
   * fee schedules, consent pages and records-request letters the Records page
   * itself tells the user require no action. The metric contradicted the
   * screen it was measuring.
   */
  analysisClass?: string | null;
  /**
   * The audit version that graded this row. Null means the run predated
   * dispute columns and recorded no reason for its grade — a caution to check,
   * not a defect to correct.
   */
  auditVersion?: string | null;
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
  /** Undated rows whose KIND requires a service date: a real gap to close. */
  undatedClinical: number;
  /** Undated rows that never needed one — fee schedules, letters, consents. */
  undatedDatelessByDesign: number;

  /** Distinct OPEN findings by scope, counted by identity. */
  findingsByScope: Record<string, number>;
  /** Distinct OPEN findings by type, counted by identity. */
  findingsByType: Record<string, number>;
  /** Distinct entries named by any open finding. */
  entriesWithFindings: number;
  /**
   * Distinct canonical notes named by an open finding. STRICTLY the findings
   * question — `notesNeedingAttention` is the broader one and includes rows
   * that are unresolved without any finding attached.
   */
  notesWithFindings: number;
  /** Open blockers at DOCUMENT scope, counted once per document finding. */
  documentBlockers: number;
  /** Open blockers at PAGE scope, counted once per page finding. */
  pageBlockers: number;
  /** Open blockers at CASE scope. */
  caseBlockers: number;

  /**
   * Notes needing a human: those with a finding, plus those whose own rows are
   * stale, generation-loss, non-PASS, or undated where a date is required.
   */
  notesNeedingAttention: number;
  /**
   * Notes a reviewer may attest once they have read a caution: a sound entry
   * inside an incomplete document, text carried forward from an earlier note,
   * or an old grade whose reason was never recorded.
   */
  notesCarryingCaution: number;
  /** Notes with nothing open: one attestation each, still required. */
  cleanNotesAwaitingAttestation: number;

  /**
   * Rows a canonical note consolidates from ANOTHER document — the copies one
   * decision now covers instead of each demanding its own.
   */
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

  // ── Two DIFFERENT questions, kept apart ─────────────────────────────────
  // "How many notes has a finding been raised against?" and "how many notes
  // need a human?" are not the same number, and returning one Set for both
  // made them aliases that could never disagree — a metric that cannot be
  // wrong about anything is not measuring anything.

  // (1) Notes a finding actually names.
  const noteOfRow = new Map<string, string>();
  for (const n of notes) for (const rid of n.rowIds) noteOfRow.set(rid, n.id);
  const notesWithFindings = new Set<string>();
  for (const f of distinctOpen) {
    if (f.canonicalNoteId) notesWithFindings.add(f.canonicalNoteId);
    if (f.encounterId) {
      const owner = noteOfRow.get(f.encounterId);
      if (owner) notesWithFindings.add(owner);
    }
  }

  // (2) Notes needing a human: the above, PLUS notes whose own rows cannot be
  // attested as they stand.
  //
  // "Not PASS" was too coarse and made this number contradict the screen it
  // measures. EXTRACTION_INCOMPLETE is a fact about the DOCUMENT, inherited by
  // sound entries; NEEDS_HUMAN_REVIEW is a caution to read; and a
  // SOURCE_CONFLICT from a run that recorded no reason gives a reviewer
  // nothing to correct. Those are counted separately as cautions.
  const isException = (r: BurdenRow): boolean =>
    r.status === "STALE" ||
    r.status === "GENERATION_LOSS" ||
    isUndatedAndShouldBeDated(r) ||
    r.auditResult === "FAILED" ||
    (r.auditResult === "SOURCE_CONFLICT" && r.auditVersion != null);
  const isCaution = (r: BurdenRow): boolean =>
    !isException(r) &&
    (r.auditResult === "EXTRACTION_INCOMPLETE" ||
      r.auditResult === "NEEDS_HUMAN_REVIEW" ||
      (r.auditResult === "SOURCE_CONFLICT" && r.auditVersion == null));

  const notesFlagged = new Set(notesWithFindings);
  for (const n of notes) {
    if (n.rowIds.some((id) => { const r = rowsById.get(id); return r ? isException(r) : false; })) notesFlagged.add(n.id);
  }
  const notesCarryingCaution = new Set<string>();
  for (const n of notes) {
    if (notesFlagged.has(n.id)) continue;
    if (n.rowIds.some((id) => { const r = rowsById.get(id); return r ? isCaution(r) : false; })) notesCarryingCaution.add(n.id);
  }

  // ── Cross-document copies, counted from the persisted linkage ───────────
  // A note assembled from rows in more than one document IS the duplicate
  // linkage; every member beyond the note's own document is a copy that this
  // consolidation spared a separate decision. Hard-coding zero reported the
  // saving as nothing.
  const crossDocumentCopies = notes.reduce(
    (n, note) => n + note.rowIds.filter((id) => (rowsById.get(id)?.sourceDocumentId ?? note.documentId) !== note.documentId).length,
    0,
  );

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
    // Only material that is SUPPOSED to carry a service date. A fee schedule,
    // a consent page and a records-request letter are legitimately dateless,
    // and counting them here contradicted the Records page's own disclosure
    // that such material requires no action.
    undatedClinical: countRows(isUndatedAndShouldBeDated),
    undatedDatelessByDesign: countRows((r) => r.dateStatus === "UNKNOWN" && !isUndatedAndShouldBeDated(r)),

    findingsByScope: byScope,
    findingsByType: byType,
    entriesWithFindings: entriesWithFindings.size,
    notesWithFindings: notesWithFindings.size,
    documentBlockers: distinctOpen.filter((f) => f.scope === "DOCUMENT" && f.blocking).length,
    pageBlockers: distinctOpen.filter((f) => f.scope === "PAGE" && f.blocking).length,
    caseBlockers: distinctOpen.filter((f) => f.scope === "CASE" && f.blocking).length,

    notesNeedingAttention: notesFlagged.size,
    notesCarryingCaution: notesCarryingCaution.size,
    cleanNotesAwaitingAttestation: notes.filter((n) => !notesFlagged.has(n.id) && n.rowIds.every((id) => CLEAN_STATUSES.has(rowsById.get(id)?.status ?? ""))).length,

    crossDocumentCopies,
    decisionsBeforeConsolidation: input.rows.length,
    decisionsAfterConsolidation: notes.length,
  };
}
