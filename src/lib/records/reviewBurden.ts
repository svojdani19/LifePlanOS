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
//   • the review UNIT is the canonical encounter — resolved by the ONE shared
//     grouping mechanism the review surface uses, never by a second
//     approximation of it that can drift;
//   • superseded rows and older runs are history and are never current;
//   • a cross-document copy is not a second obligation;
//   • a REQUIRED decision is an EXCEPTION. A clean, well-supported encounter
//     stays visible and auditable and is covered by the case-level final
//     confirmation; counting it as a mandatory click made a case of hundreds
//     of sound records look like hundreds of unanswered questions.
//
// Pure and synchronous: callers supply persisted data, so the same function
// serves a live case, a test with synthetic rows, and the re-audit report.
// ─────────────────────────────────────────────────────────────────────────────

import { requiresDate } from "@/lib/documents/analysisClass";
import { groupCanonicalEncounters, type CanonicalRow } from "@/lib/records/canonicalEncounters";
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

  // ── Identity-bearing fields ───────────────────────────────────────────────
  // Supplied so this measurement and the review surface resolve membership
  // from the SAME facts. All optional: a caller that supplies less gets fewer
  // merges, never different ones — but a caller comparing its numbers against
  // the Records page must supply them, or the two are counting different
  // groupings of the same rows.
  encounterDate?: string | Date | null;
  provider?: string | null;
  facility?: string | null;
  segmentKey?: string | null;
  page?: number | null;
  pageEnd?: number | null;
  substanceClass?: string | null;
  claims?: readonly { field: string; value: string; excerpt?: string | null; page?: number | null }[];
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
  /**
   * Canonical encounters, from the shared grouping mechanism. A VISIBILITY
   * number: this is how many real records the case contains, not how many
   * decisions it demands.
   */
  canonicalNotes: number;
  /** Notes built from more than one extraction row. */
  multiRowNotes: number;
  /** Rows with no persisted segment — each becomes its own one-row note. */
  rowsWithoutSegment: number;
  /**
   * Encounters whose membership the compatibility fallback derived, because
   * their document carries no enriched row membership at all.
   */
  fallbackNotes: number;
  /**
   * Encounters carrying an unresolved assignment question — counted ONCE per
   * ambiguity cluster, never once per fragment inside it.
   */
  ambiguousAssignments: number;

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
   * Distinct CURRENT canonical notes named by an open finding, blocking or
   * advisory, each finding resolving to at most one note. STRICTLY the
   * findings question and a VISIBILITY number — `notesNeedingAttention` is
   * the obligation one: it is seeded from blocking findings only, and also
   * includes notes that are unresolved with no finding attached.
   */
  notesWithFindings: number;
  /** Open blockers at DOCUMENT scope, counted once per document finding. */
  documentBlockers: number;
  /** Open blockers at PAGE scope, counted once per page finding. */
  pageBlockers: number;
  /** Open blockers at CASE scope. */
  caseBlockers: number;

  /**
   * Encounters needing a human: those with a finding, those whose own rows are
   * stale, generation-loss, non-PASS or undated where a date is required, and
   * those whose membership could not be resolved.
   */
  notesNeedingAttention: number;
  /**
   * Notes a reviewer may attest once they have read a caution: a sound entry
   * inside an incomplete document, text carried forward from an earlier note,
   * or an old grade whose reason was never recorded.
   */
  notesCarryingCaution: number;
  /**
   * Encounters with nothing open.
   *
   * They remain visible and auditable, and the case-level final gate still
   * requires a human before a final export — but each of them is NOT a
   * separate mandatory obligation, and this number is deliberately absent from
   * `requiredDecisions`.
   */
  cleanNotesAwaitingAttestation: number;

  /**
   * The number this module exists to get right: MATERIAL EXCEPTIONS a person
   * must answer, each counted once at its own scope.
   *
   *   • encounters that cannot be attested as they stand — including those
   *     whose assignment is unresolved, counted once per ambiguity cluster;
   *   • blocking CASE, DOCUMENT and PAGE findings, once each at their scope.
   *
   * Clean encounters and cautions are excluded: a caution is read, not
   * corrected, and a clean record is covered by the case-level confirmation.
   */
  requiredDecisions: number;
  /**
   * The obligations above, broken out. `ambiguousAssignments` is a SUBSET of
   * `encounterExceptions`, not an addend — the total is the encounter
   * exceptions plus the three scoped blocker counts.
   */
  requiredDecisionsByKind: {
    encounterExceptions: number;
    ambiguousAssignments: number;
    caseBlockers: number;
    documentBlockers: number;
    pageBlockers: number;
  };

  /**
   * Rows a canonical note consolidates from ANOTHER document — the copies one
   * decision now covers instead of each demanding its own.
   */
  crossDocumentCopies: number;
  /**
   * Review UNITS before and after consolidation — the fragment-level surface
   * against the canonical-encounter one. A consolidation-savings comparison,
   * NOT the obligation count: `requiredDecisions` is that.
   */
  decisionsBeforeConsolidation: number;
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

  // ── Canonical encounters, from the ONE shared mechanism ─────────────────
  // Not re-derived here. This measurement and the Records surface must agree
  // about what a record IS before they can disagree usefully about anything
  // else, and two implementations of "which rows are one note" would have
  // drifted apart the first time either was corrected.
  //
  // Only rows that are still current are passed in (the caller applies the
  // lifecycle filter), so a segment whose rows were all superseded resolves to
  // nothing and is history rather than a review obligation.
  const grouped = groupCanonicalEncounters({
    documents: input.documents.map((d) => ({ id: d.id, segments: d.segments })),
    rows: input.rows as readonly CanonicalRow[],
  });
  const notes = grouped.map((g) => ({
    id: canonicalNoteId(g.documentId, g.rowIds),
    documentId: g.documentId,
    rowIds: g.rowIds,
    basis: g.basis,
    ambiguousAssignment: g.ambiguousAssignment,
  }));
  // "No persisted segment" is a fact about the ROWS, so it is still counted
  // from the rows rather than from the groups the fallback then built out of
  // them — otherwise consolidating legacy rows would make the gap that caused
  // the consolidation disappear from the report.
  const claimedByPersistedSegment = new Set<string>();
  for (const doc of input.documents) {
    for (const seg of segmentsOf(doc)) {
      for (const id of rowIdsOf(seg)) if (rowsById.has(id)) claimedByPersistedSegment.add(id);
    }
  }
  const orphanRows = input.rows.filter((r) => !claimedByPersistedSegment.has(r.id));

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

  // (1) Notes a finding actually names — at most ONE current note each.
  //
  // The previous version added BOTH the stored `canonicalNoteId` and the note
  // its `encounterId` currently belongs to. A stored id is a snapshot of a
  // grouping, and grouping changes: a finding written while a legacy row was
  // a note of one carries that singleton id, and once the compatibility path
  // folds that row into a real encounter the two disagree. One problem then
  // counted as two obligations — or, when the row is gone entirely, as an
  // obligation against a note nobody can open.
  //
  // So each finding resolves to at most one CURRENT note: the owner of the
  // row it names, and only failing that a stored id that still exists.
  const noteOfRow = new Map<string, string>();
  for (const n of notes) for (const rid of n.rowIds) noteOfRow.set(rid, n.id);
  const currentNoteIds = new Set(notes.map((n) => n.id));
  const currentNoteOf = (f: BurdenFinding): string | null => {
    const owner = f.encounterId ? noteOfRow.get(f.encounterId) : undefined;
    if (owner) return owner;
    // A stored id is accepted only as a fallback, and only when it still names
    // a note this grouping produced. A stale one names nothing and is dropped
    // rather than invented — the finding remains counted by scope and type.
    if (f.canonicalNoteId && currentNoteIds.has(f.canonicalNoteId)) return f.canonicalNoteId;
    return null;
  };
  const notesWithFindings = new Set<string>();
  for (const f of distinctOpen) {
    const note = currentNoteOf(f);
    if (note) notesWithFindings.add(note);
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

  // Seeded from BLOCKING findings only. `notesWithFindings` answers "what has
  // a finding been raised against?" and counts advisory ones too, because a
  // reviewer should see them; an obligation is a different question. A
  // non-blocking finding is a CAUTION — which is exactly what the review
  // surface calls it, and the metric said otherwise about the same note.
  const notesFlagged = new Set<string>();
  for (const f of distinctOpen) {
    if (!f.blocking) continue;
    const note = currentNoteOf(f);
    if (note) notesFlagged.add(note);
  }
  for (const n of notes) {
    if (n.rowIds.some((id) => { const r = rowsById.get(id); return r ? isException(r) : false; })) notesFlagged.add(n.id);
    // An unresolved assignment question IS an exception about this encounter:
    // its membership was neither proven nor disproven, so a person has to
    // settle it. It is raised once per ambiguity cluster, not once per
    // fragment, and it joins the same set so an encounter that is ALSO stale
    // or contradicted is still one obligation rather than two.
    if (n.ambiguousAssignment) notesFlagged.add(n.id);
  }
  const notesCarryingCaution = new Set<string>();
  for (const n of notes) {
    if (notesFlagged.has(n.id)) continue;
    if (n.rowIds.some((id) => { const r = rowsById.get(id); return r ? isCaution(r) : false; })) notesCarryingCaution.add(n.id);
  }
  // An advisory finding is something to read before attesting, not something
  // to correct — the same reading `noteProjection` gives it.
  for (const f of distinctOpen) {
    if (f.blocking) continue;
    const note = currentNoteOf(f);
    if (note && !notesFlagged.has(note)) notesCarryingCaution.add(note);
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

  // ── Required decisions: EXCEPTIONS ONLY, each at its own scope ───────────
  // A clean encounter is not here. It stays visible, it stays auditable, and
  // the case-level final gate still refuses to release a report over an
  // unreviewed record — but it is not an item in a queue a person is being
  // asked to work through, and counting it as one is what made a well-extracted
  // case read as hundreds of unanswered questions.
  //
  // Nor is a CAUTION here: a caution is something to read before attesting,
  // not something to correct. It has its own number.
  //
  // A document- or page-scoped blocker appears ONCE, at its own scope — never
  // once per encounter that happens to sit inside it. That is the same rule
  // the finding model already enforces, applied to the obligation count.
  const documentBlockers = distinctOpen.filter((f) => f.scope === "DOCUMENT" && f.blocking).length;
  const pageBlockers = distinctOpen.filter((f) => f.scope === "PAGE" && f.blocking).length;
  const caseBlockers = distinctOpen.filter((f) => f.scope === "CASE" && f.blocking).length;
  // Ambiguous assignments are already inside `notesFlagged`; reported here as
  // a BREAKDOWN of that set, so the parts never double-count the whole.
  const ambiguousAssignments = notes.filter((n) => n.ambiguousAssignment).length;
  const requiredDecisionsByKind = {
    encounterExceptions: notesFlagged.size,
    ambiguousAssignments,
    caseBlockers,
    documentBlockers,
    pageBlockers,
  };

  return {
    activeRows: input.rows.length,
    canonicalNotes: notes.length,
    multiRowNotes: notes.filter((n) => n.rowIds.length > 1).length,
    rowsWithoutSegment: orphanRows.length,
    fallbackNotes: notes.filter((n) => n.basis === "COMPATIBILITY_FALLBACK").length,
    ambiguousAssignments,

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
    documentBlockers,
    pageBlockers,
    caseBlockers,

    notesNeedingAttention: notesFlagged.size,
    notesCarryingCaution: notesCarryingCaution.size,
    cleanNotesAwaitingAttestation: notes.filter((n) => !notesFlagged.has(n.id) && n.rowIds.every((id) => CLEAN_STATUSES.has(rowsById.get(id)?.status ?? ""))).length,

    // `ambiguousAssignments` is deliberately NOT added: it is a subset of
    // `encounterExceptions`, and adding it would count the same question twice.
    requiredDecisions:
      requiredDecisionsByKind.encounterExceptions +
      requiredDecisionsByKind.caseBlockers +
      requiredDecisionsByKind.documentBlockers +
      requiredDecisionsByKind.pageBlockers,
    requiredDecisionsByKind,

    crossDocumentCopies,
    decisionsBeforeConsolidation: input.rows.length,
    decisionsAfterConsolidation: notes.length,
  };
}
