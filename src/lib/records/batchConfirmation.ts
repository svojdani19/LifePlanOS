// ─────────────────────────────────────────────────────────────────────────────
// One human confirmation over the clean part of a case.
//
// The canonical grouping cut the number of review UNITS. It did not cut the
// number of clicks, because every clean encounter still needed its own, and
// the final-export gate still refused to release a report while any machine
// draft was unreviewed. So the metric could say "0 required decisions" while a
// reviewer still had to sign every card to export. A number that disagrees
// with the work is worse than no number.
//
// This is the missing half: ONE explicit human act, over an exactly-named set
// of genuinely clean records, recorded with everything needed to audit it.
//
// WHAT IT IS NOT:
//
//   • Not automatic. Nothing here runs on its own; a person clicks, having
//     been shown the counts and the cautions first.
//   • Not a verification. It writes REVIEWED — a factual records review under
//     `records.verify` — never VERIFIED, and never a professional attestation.
//   • Not a way past an exception. Anything that cannot be attested as it
//     stands is SKIPPED and stays in the individual correction path, reported
//     by count and reason.
//   • Not a content change. It writes review status and review metadata only.
//     No claim, excerpt, citation, summary, date, provider, facility,
//     classification, canonical membership or chronology sentence is touched,
//     rewritten, merged, deduplicated or dropped by any of this.
//
// Eligibility is NOT re-derived from scratch. It reads the canonical notes the
// review surface itself produces — same grouping, same guidance, same
// CLEAN / CAUTION / EXCEPTION verdict — and then re-checks every row's
// integrity directly with the same `attestationBlockers` the individual
// endpoint enforces. The surface's verdict is a courtesy; the row check is the
// safeguard, and both must agree before anything is written.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { requiresDate } from "@/lib/documents/analysisClass";
import { chronologyEventContentHash, type ChronologyContentRow } from "@/lib/records/chronologyContent";
import { isOpenFinding } from "@/lib/records/findingScope";
import { attestationBlockers, humanAuthoritative } from "@/lib/records/reviewIntegrity";
import { weighNote, type RiskWeight } from "@/lib/records/riskWeight";
import type { ReviewableNote } from "@/lib/records/noteProjection";

/**
 * The only row states this confirmation may write over.
 *
 * A machine draft is what a human confirmation is FOR. Anything already
 * carrying human work is left exactly as it is — a batch action must never
 * overwrite, downgrade or re-date somebody else's decision.
 */
export const CONFIRMABLE_ROW_STATES: readonly string[] = ["AI_DRAFT", "AI_AUDIT_PASSED"];

/**
 * A chronology draft, as eligibility needs it.
 *
 * Every content field the report can render is carried, because the manifest
 * binds them: an event has no `updatedAt` to compare-and-set against, so its
 * CONTENT is the version it is confirmed at.
 */
export type ConfirmableEvent = ChronologyContentRow & {
  id: string;
  reviewStatus: string;
  edited: boolean;
  sourceDocumentId?: string | null;
  eventDate?: Date | string | null;
  /** The exact ExtractedEncounter ids the builder used. See eventLineage. */
  sourceRowIds?: unknown;
  summary?: string | null;
  sourcePage?: number | null;
};

/**
 * The exact source rows an event was built from.
 *
 * Defensively narrowed: the column is JSON, it is nullable by design, and an
 * event written before it existed has nothing there. An empty result means
 * "this event names no extracted row" — never "this event has no source" — and
 * it holds the event OUT of batch confirmation rather than falling back to the
 * document-plus-date key, which cannot tell two same-day encounters apart.
 */
export function eventLineage(event: { sourceRowIds?: unknown }): string[] {
  if (!Array.isArray(event.sourceRowIds)) return [];
  return [...new Set((event.sourceRowIds as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0))];
}

export interface BatchEncounterDecision {
  noteId: string;
  documentId: string;
  rowIds: string[];
  /** The rows this confirmation would actually write. Never a human's row. */
  confirmRowIds: string[];
  eligible: boolean;
  /** The review surface's own verdict on this record. */
  level: "CLEAN" | "CAUTION" | "EXCEPTION";
  /** The guidance kind, so a caution can be named rather than merely counted. */
  guidanceKind: string;
  /** How this record's membership was established. Bound into the manifest. */
  basis: string;
  /**
   * A required decision this record carries. Empty when it is not one.
   *
   * Kept apart from `heldReasons` because they are different statements: a
   * reason here is work somebody owes; a reason there is work somebody else's
   * decision will release.
   */
  reasons: { code: string; reason: string }[];
  /**
   * A caution this record carries: work, but NOT an exception.
   *
   * Kept out of `reasons` because putting it there made every caution a
   * "skipped exception" — the panel then reported the same records twice, once
   * as N cautions and again as N exceptions, and the zero-eligible state called
   * them exceptions outright. A caution is a sound record with something to
   * read first; an exception is a record that cannot be attested as it stands.
   */
  cautionReasons: { code: string; reason: string }[];
  /** Why this record is passed over WITHOUT being a decision of its own. */
  heldReasons: { code: string; reason: string }[];
}

/**
 * One row this confirmation will mark human-reviewed — with ITS OWN assertion.
 *
 * The first version rendered one line per canonical note, taking the summary
 * and citation from `primaryRow` — the first row of the note's document. But
 * `confirmRowIds` routinely holds several rows, and a canonical note can mix an
 * already-human-reviewed row with an AI draft. So the reviewer could be shown
 * one already-reviewed sentence while the click wrote REVIEWED onto a different
 * row whose summary they never saw, and `humanAuthoritative()` would then treat
 * that row as something a person read.
 *
 * Every row being written gets its own line, carrying its own factual summary
 * and its own document and page. None is omitted and none is represented by
 * another row.
 */
export interface ManifestRowLine {
  rowId: string;
  /** THIS row's factual summary — the assertion being confirmed. */
  summary: string;
  /** THIS row's own document, which may differ from the note's (a copy). */
  documentId: string;
  filename: string;
  page: number | null;
  pageEnd: number | null;
  /** The content identity of the row as displayed. */
  contentHash: string;
  status: string;
}

/**
 * One canonical note, with every row this click writes nested beneath it.
 *
 * Grouping is preserved — a canonical note is still ONE decision, which is the
 * whole point of the review model. What changed is that the disclosure inside
 * that decision is complete.
 */
export interface ManifestRecordLine {
  noteId: string;
  documentId: string;
  filename: string;
  encounterDate: string | null;
  provider: string | null;
  facility: string | null;
  /** How this note's membership was established. */
  basis: string;
  /** EXACTLY the rows this confirmation writes, each with its own assertion. */
  rows: ManifestRowLine[];
  /**
   * Which of these clean records still warrant opening the cited page.
   *
   * Triage only: this never changes what the click writes, who it is written
   * by, or which records the batch covers. It orders the reviewer's attention
   * within a set that already qualified. Because it is RENDERED, it is hashed
   * with everything else below — a batch whose risk framing changed while the
   * reviewer read it is a different manifest.
   */
  risk: RiskWeight;
}

/** One chronology entry that will become human-reviewed. */
export interface ManifestEventLine {
  eventId: string;
  eventDate: string | null;
  summary: string;
  documentId: string | null;
  filename: string | null;
  page: number | null;
  /** The exact source rows this event was built from. */
  sourceRowIds: string[];
  /** How the event was tied to a confirmed record. */
  linkage: "EXACT_LINEAGE";
}

export interface BatchConfirmationPlan {
  encounters: BatchEncounterDecision[];
  /** EXACTLY the records this confirmation will mark reviewed, itemized. */
  manifestRecords: ManifestRecordLine[];
  /** EXACTLY the chronology entries it will mark reviewed, itemized. */
  manifestEvents: ManifestEventLine[];
  /** Exactly the rows to mark REVIEWED, sorted. Server-derived, always. */
  rowIds: string[];
  /** Exactly the chronology drafts to mark REVIEWED, sorted. */
  eventIds: string[];
  counts: {
    canonicalEncounters: number;
    /** Encounters this one confirmation covers. */
    eligibleEncounters: number;
    cleanEncounters: number;
    /** Eligible, but carrying something the reviewer is told to read first. */
    cautionEncounters: number;
    /** Nothing to do: a person has already decided these. */
    alreadyReviewedEncounters: number;
    /**
     * Exceptions that stay in the individual path. Each is one decision.
     *
     * Cautions are NOT counted here. They were, which made the panel report
     * the same records twice — "N cautions" and "N exceptions" — and inflated
     * the apparent review burden by exactly the number of cautions.
     */
    skippedEncounters: number;
    /**
     * Passed over without being a decision: a record waiting on somebody
     * else's — the anchor of its ambiguity cluster, or another appearance of
     * one of its rows.
     */
    heldEncounters: number;
    rows: number;
    events: number;
    /** Chronology drafts held back: unlinked, or on a date still in question. */
    heldEvents: number;
  };
  /** Why encounters were skipped, by code — shown before the click. TRUE
   *  exceptions only: a caution is reported separately, because it is not one. */
  skippedByReason: Record<string, number>;
  /** The requirement each cautioned record carries, by guidance kind. */
  cautionsByReason: Record<string, number>;
  /** Why encounters were held without being a decision, by code. */
  heldByReason: Record<string, number>;
  /** Why chronology drafts were held back, by code. */
  heldEventsByReason: Record<string, number>;
  /** Which cautions this confirmation would cover, by kind — disclosed. */
  cautionsByKind: Record<string, number>;
  /** How each covered encounter's membership was established, for the record. */
  basisCounts: Record<string, number>;
  /**
   * Deterministic identity of EXACTLY what is being confirmed.
   *
   * Computed over `manifestRecords` and `manifestEvents` THEMSELVES — the same
   * arrays the panel renders — plus the full persisted content behind each
   * event and the whole plan around them. Not a parallel projection of the
   * manifest: hashing a different shape from the one on screen is how "the
   * exact displayed manifest" becomes an inference instead of a fact.
   *
   * The browser sends this back; the server recomputes it under the case's own
   * lock, inside the write transaction, and refuses the whole batch if
   * anything a reviewer read has moved in between.
   */
  manifestHash: string;
}

/** The complete confirmation as it was DISPLAYED, for hashing. */
export interface ManifestInput {
  /** Every canonical decision shown, eligible or not. */
  encounters: readonly BatchEncounterDecision[];
  /**
   * The manifest lines EXACTLY as rendered. Not a parallel projection of them:
   * hashing a different shape from the one on screen is how "the exact
   * displayed manifest" becomes an inference rather than a fact.
   */
  records: readonly ManifestRecordLine[];
  /** Every covered chronology draft, exactly as rendered. */
  events: readonly ManifestEventLine[];
  /** The full persisted content of those drafts, which the lines summarise. */
  eventContent: readonly ConfirmableEvent[];
  counts: BatchConfirmationPlan["counts"];
  cautionsByKind: Record<string, number>;
  cautionsByReason: Record<string, number>;
  skippedByReason: Record<string, number>;
  heldByReason: Record<string, number>;
  heldEventsByReason: Record<string, number>;
  basisCounts: Record<string, number>;
}

const tally = (t: Record<string, number>) =>
  Object.entries(t)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(",");

/**
 * The identity of exactly what the reviewer was shown.
 *
 * The first version hashed row ids, content hashes and a little event
 * metadata. That binds the SET of rows and their content — and nothing else a
 * person actually read. A regrouping that redistributed the same rows across
 * different canonical encounters, a record moving from eligible to skipped, a
 * caution appearing, the counts changing: every one of those changes the
 * dialog and left the hash alone, so a reviewer could confirm figures that had
 * been replaced while they read them.
 *
 * The second version bound the whole plan but still hashed rows as
 * `id contentHash status`, which is the row's CONTENT and not the citation
 * printed beside it — a filename correction, a re-paged document or a changed
 * membership basis all altered what the reviewer read and left the hash alone.
 *
 * So this hashes the LITERAL manifest lines: every string the panel renders,
 * per row and per chronology entry, plus the full persisted content behind each
 * event and the plan that produced them. When the comment above says "every
 * displayed field", the input to this function is that field.
 *
 * Order-independent throughout: every list is sorted before hashing.
 */
export function manifestHashOf(input: ManifestInput): string {
  const encounterPart = [...input.encounters]
    .map((e) =>
      [
        e.noteId,
        e.documentId,
        e.basis,
        [...e.rowIds].sort().join(","),
        [...e.confirmRowIds].sort().join(","),
        e.eligible ? "eligible" : "not-eligible",
        e.level,
        e.guidanceKind,
        e.reasons.map((r) => r.code).sort().join("+"),
        e.heldReasons.map((r) => r.code).sort().join("+"),
      ].join(" "),
    )
    .sort()
    .join("\n");
  // EVERY FIELD THAT IS RENDERED. The previous version hashed
  // `id contentHash status` per row, which binds the row's content but not the
  // citation printed beside it: a filename correction, a re-paged document or
  // a changed membership basis all altered what the reviewer read and left the
  // hash alone. The literal displayed strings are hashed instead, so "the
  // exact manifest displayed is the exact manifest confirmed" is a fact about
  // this function rather than a claim about it.
  const recordPart = [...input.records]
    .map((r) =>
      [
        r.noteId,
        r.documentId,
        r.filename,
        r.encounterDate ?? "",
        r.provider ?? "",
        r.facility ?? "",
        r.basis,
        // The risk tier and its reasons are on screen beside the record, so
        // they are bound like every other displayed field.
        r.risk.tier,
        r.risk.signals.map((sig) => sig.code).sort().join("+"),
        // Every row line, in full: its own assertion and its own citation.
        [...r.rows]
          .map((row) => [row.rowId, row.contentHash, row.status, row.documentId, row.filename, row.page ?? "", row.pageEnd ?? "", row.summary].join("\u0001"))
          .sort()
          .join("\u0002"),
      ].join("\u0003"),
    )
    .sort()
    .join("\n");
  // Chronology lines: the displayed fields…
  const eventLinePart = [...input.events]
    .map((e) =>
      [e.eventId, e.eventDate ?? "", e.summary, e.documentId ?? "", e.filename ?? "", e.page ?? "", [...e.sourceRowIds].sort().join(","), e.linkage].join("\u0001"),
    )
    .sort()
    .join("\n");
  // …and the FULL persisted content behind them. A chronology event has no
  // `updatedAt` to compare-and-set against, so its content IS the version
  // being confirmed, and the line above shows only part of it.
  //
  // The LINEAGE is bound in both places. Without it, a rebuild that
  // re-attributed an event to a different encounter — same id, same prose,
  // same date — left the hash alone, and the reviewer's confirmation would
  // carry over to a record they never saw it attached to.
  const eventPart = [...input.eventContent]
    .map((e) => `${e.id} ${chronologyEventContentHash(e)} ${eventLineage(e).sort().join(",")}`)
    .sort()
    .join("\n");
  const countPart = Object.entries(input.counts)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(",");

  return createHash("sha256")
    .update(
      [
        "encounters",
        encounterPart,
        "records",
        recordPart,
        "eventLines",
        eventLinePart,
        "events",
        eventPart,
        "counts",
        countPart,
        "cautions",
        tally(input.cautionsByKind),
        "cautionReasons",
        tally(input.cautionsByReason),
        "skipped",
        tally(input.skippedByReason),
        "held",
        tally(input.heldByReason),
        "heldEvents",
        tally(input.heldEventsByReason),
        "basis",
        tally(input.basisCounts),
      ].join("\n"),
    )
    .digest("hex");
}

const isoDay = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

/**
 * Decide, for one case, exactly what a single human confirmation may cover.
 *
 * `notes` must be the canonical notes of the REVIEW scope, straight from the
 * structured record — that is what makes this and the screen agree about what
 * a record is before they agree about whether it is clean.
 */
export function planBatchConfirmation(input: {
  notes: readonly ReviewableNote[];
  events: readonly ConfirmableEvent[];
  /**
   * documentId → filename, for the manifest's citations. Optional: a caller
   * that omits it gets lines carrying the document id, which still identifies
   * the record; it just reads worse.
   */
  filenames?: ReadonlyMap<string, string>;
}): BatchConfirmationPlan {
  const encounters: BatchEncounterDecision[] = [];
  const skippedByReason: Record<string, number> = {};
  const cautionsByReason: Record<string, number> = {};
  const heldByReason: Record<string, number> = {};
  const heldEventsByReason: Record<string, number> = {};
  const cautionsByKind: Record<string, number> = {};
  const basisCounts: Record<string, number> = {};

  for (const note of input.notes) {
    const reasons: { code: string; reason: string }[] = [];
    const cautionReasons: { code: string; reason: string }[] = [];
    const heldReasons: { code: string; reason: string }[] = [];

    // 1. The review surface's own verdict. An EXCEPTION is a record that
    //    cannot be attested as it stands — ambiguous membership, a
    //    contradicted or disagreeing date, stale human work, generation loss,
    //    an unresolved dispute, an integrity failure, an entry the factual
    //    audit never graded, a record no independent re-reading reproduced,
    //    or a date that is required and missing. Each keeps its own guidance
    //    and its own individual path.
    if (note.attention === "EXCEPTION" || note.needsAttention) {
      reasons.push({ code: note.guidance.kind, reason: note.guidance.requirement });
    }

    // 2. An open BLOCKING finding against this record or its entries. Judged
    //    at ENCOUNTER grain: a document- or page-scoped finding is not among
    //    these and is never multiplied across the notes sitting inside it. It
    //    blocks the FINAL export once, at its own scope, where it belongs.
    const blockingFindings = note.findings.filter((f) => f.blocking && isOpenFinding(f.status));
    if (blockingFindings.length) {
      reasons.push({
        code: "BLOCKING_FINDING",
        reason: `${blockingFindings.length} unresolved finding(s) must be dispositioned first`,
      });
    }

    // 3. Each row's integrity, checked DIRECTLY — the same function the
    //    individual endpoint enforces. A screen state is a courtesy; this is
    //    the safeguard, and it must agree with the verdict above before
    //    anything is written.
    for (const row of note.rows) {
      for (const problem of attestationBlockers(row as never)) reasons.push(problem);
    }

    // 4. A record whose KIND requires a service date and has none never enters
    //    the dated chronology, so confirming it would attest a record the
    //    timeline cannot place.
    if (note.rows.some((r) => r.dateStatus === "UNKNOWN" && requiresDate((r.analysisClass ?? null) as never))) {
      reasons.push({ code: "UNDATED_CLINICAL", reason: "a service date is required and none is established" });
    }

    // 4b. A CAUTION is not clean.
    //
    //     The panel said "N encounters are clean and can be confirmed in one
    //     review. M of those carry a caution to read first" — and then included
    //     all N in the same click. So the caution was disclosed as a count and
    //     confirmed as though it had been read, in one act, with nothing
    //     distinguishing the reviewer who read it from the one who did not.
    //
    //     A caution is a statement that this record needs something looked at.
    //     It goes to its own document-grain acknowledgement path, where the
    //     actual caution and the affected items are visible, and it is not
    //     eligible here.
    if (note.attention === "CAUTION") {
      cautionReasons.push({ code: note.guidance.kind, reason: note.guidance.requirement });
    }

    // 5. The one decision an unresolved ambiguity cluster carries.
    if (note.ambiguousAssignment) {
      reasons.push({ code: "AMBIGUOUS_ASSIGNMENT", reason: "this record's extent is unresolved" });
    }

    // 6. …and the rest of that cluster. NOT a decision — the question is asked
    //    once, on the anchor — but not clean either. If the open question is
    //    whether these four fragments are one encounter or four, then no
    //    member is a settled record until somebody answers it, and sweeping
    //    three of them into a batch as "clean" answers it by default, in the
    //    direction nobody chose. They are released by the anchor's decision.
    if (note.ambiguityAwaitingAnchor) {
      heldReasons.push({
        code: "AWAITING_ASSIGNMENT_DECISION",
        reason: "another record in this group carries an unresolved assignment decision that covers this one too",
      });
    }

    const confirmRowIds = note.rows
      .filter((r) => CONFIRMABLE_ROW_STATES.includes(r.status) && !humanAuthoritative(r))
      .map((r) => r.id)
      .sort();

    const decisions = [...new Map(reasons.map((r) => [`${r.code} ${r.reason}`, r])).values()];
    const cautions = [...new Map(cautionReasons.map((r) => [`${r.code} ${r.reason}`, r])).values()];
    const held = [...new Map(heldReasons.map((r) => [`${r.code} ${r.reason}`, r])).values()];
    // A caution still bars the clean batch — it just is not an exception.
    const eligible = decisions.length === 0 && cautions.length === 0 && held.length === 0 && confirmRowIds.length > 0;
    encounters.push({
      noteId: note.id,
      documentId: note.sourceDocumentId,
      rowIds: [...note.rowIds],
      confirmRowIds,
      eligible,
      level: note.attention,
      guidanceKind: note.guidance.kind,
      basis: note.membershipBasis,
      reasons: decisions,
      cautionReasons: cautions,
      heldReasons: held,
    });

    if (decisions.length) {
      // One encounter, one reason line: the most specific reason it carries,
      // so the skipped counts add up to the skipped encounters instead of
      // over-reporting the same record under several headings.
      skippedByReason[decisions[0].code] = (skippedByReason[decisions[0].code] ?? 0) + 1;
    } else if (cautions.length) {
      cautionsByReason[cautions[0].code] = (cautionsByReason[cautions[0].code] ?? 0) + 1;
    } else if (held.length){
      heldByReason[held[0].code] = (heldByReason[held[0].code] ?? 0) + 1;
    }
  }

  // ── One bad appearance vetoes the row everywhere ─────────────────────────
  // A cross-document copy is a member of the primary record's note AND the
  // subject of a note in its own production. Those two decisions are taken
  // independently — a finding, a stale sibling or an ambiguity can land on one
  // appearance and not the other — and unioning the rows of the eligible
  // decisions alone would let the clean appearance carry a row its other
  // appearance says is not clean.
  //
  // So a row named by ANY decision that is not eligible is blocked outright.
  // Counts stay at canonical/decision grain: the veto changes which rows are
  // written, never how many problems are reported.
  const blockedRows = new Set<string>();
  for (const decision of encounters) {
    if (decision.eligible) continue;
    for (const id of decision.rowIds) blockedRows.add(id);
  }

  const covered: BatchEncounterDecision[] = [];
  for (const decision of encounters) {
    if (!decision.eligible) continue;
    const conflicted = decision.confirmRowIds.filter((id) => blockedRows.has(id));
    if (!conflicted.length) {
      covered.push(decision);
      continue;
    }
    // Demoted here rather than earlier, because it only becomes true once
    // every decision is known.
    decision.eligible = false;
    decision.heldReasons.push({
      code: "ROW_BLOCKED_ELSEWHERE",
      reason: "another appearance of this record is not confirmable, so its rows are not confirmed here either",
    });
    heldByReason.ROW_BLOCKED_ELSEWHERE = (heldByReason.ROW_BLOCKED_ELSEWHERE ?? 0) + 1;
  }

  // ── Chronology ───────────────────────────────────────────────────────────
  // An AI draft is confirmable only when it can be TIED to a canonical record
  // this confirmation is also settling, or to one a person has already
  // settled. The previous rule was the other way round — include everything
  // unedited unless a same-document, same-date exception existed — so an event
  // with no source document, or one whose document and date carry no record at
  // all, was swept in by default. An event nothing supports is not a clean
  // event; it is an unexplained one, and it goes to individual review.
  //
  // The link is the strongest deterministic one the data actually carries:
  // source document plus service date. (`sourceFingerprint` fingerprints the
  // builder's merged claim set and cannot be reproduced from a persisted row,
  // so it cannot serve as the key.)
  // ── EXACT lineage, not document-plus-date ────────────────────────────────
  // The previous key was `${sourceDocumentId} ${isoDay(eventDate)}`. A
  // production with two encounters on the same day in the same document — an
  // ER record, a therapy chart, any same-day follow-up — makes that key
  // ambiguous: confirming ONE of those encounters marked the whole day
  // supported, and every event on it was written REVIEWED, including events
  // built from the encounter nobody confirmed.
  //
  // So the question is now asked of ROWS. An event is covered when every row
  // it was actually built from is a row this confirmation is writing (or one a
  // person has already settled), and it is held when any of those rows is in
  // question. An event naming no rows is held: it predates the lineage column
  // or came from the regex path, and guessing which record it belongs to is
  // precisely what went wrong.
  const settledRows = new Set<string>();
  const contestedRows = new Set<string>();
  for (const decision of encounters) {
    const note = input.notes.find((n) => n.id === decision.noteId);
    // A caution counts as contested here even though it is not an exception:
    // the record has something a person must read, so an event built from it
    // is in question too, and "no confirmed record" would understate why.
    const contested = decision.reasons.length > 0 || decision.cautionReasons.length > 0 || decision.heldReasons.length > 0;
    for (const rowId of decision.rowIds) {
      if (contested) contestedRows.add(rowId);
    }
    if (contested) continue;
    // Settled by THIS confirmation…
    if (decision.eligible) {
      for (const rowId of decision.confirmRowIds) settledRows.add(rowId);
    }
    // …or settled already by a person.
    if (note) {
      for (const row of note.rows) if (humanAuthoritative(row)) settledRows.add(row.id);
    }
  }

  const eligibleEvents: ConfirmableEvent[] = [];
  let heldEvents = 0;
  const holdEvent = (code: string) => {
    heldEvents++;
    heldEventsByReason[code] = (heldEventsByReason[code] ?? 0) + 1;
  };
  for (const event of input.events) {
    // Only a current, untouched machine draft. STALE, SUPERSEDED and anything
    // a person has edited or already decided is left exactly as it is.
    if (event.reviewStatus !== "AI_DRAFT" || event.edited) continue;
    const lineage = eventLineage(event);
    if (!lineage.length) {
      // No exact lineage. A legacy event, or one the regex path produced from
      // document text with no encounter row behind it. Individual review.
      holdEvent("NO_EXACT_LINEAGE");
      continue;
    }
    // One row in question holds the whole event: a merged event or a series
    // rests on ALL its members, and confirming it while one member is disputed
    // would attest content nobody settled.
    if (lineage.some((rowId) => contestedRows.has(rowId))) {
      holdEvent("RECORD_IN_QUESTION");
      continue;
    }
    // Subset, strictly. Every row, not merely some.
    if (!lineage.every((rowId) => settledRows.has(rowId))) {
      holdEvent("NO_CONFIRMED_RECORD");
      continue;
    }
    eligibleEvents.push(event);
  }

  // DEDUPED on purpose. A cross-document copy is a member of the primary
  // record's note AND the subject of a note in its own production, so it
  // legitimately appears twice among the covered encounters. One decision
  // covers every copy — naming the row twice would make the re-check on the
  // server count a row it could only load once and refuse the whole batch.
  const rowIds = [...new Set(covered.flatMap((e) => e.confirmRowIds))].sort();
  for (const decision of covered) {
    basisCounts[decision.basis] = (basisCounts[decision.basis] ?? 0) + 1;
  }
  // Cautions are counted across ALL notes now, not across the covered ones —
  // they are no longer covered. The count tells a reviewer how much work is
  // waiting on the separate acknowledgement path, which is what they need to
  // know once it is not riding along with this click.
  for (const decision of encounters) {
    if (!decision.cautionReasons.length) continue;
    const note = input.notes.find((n) => n.id === decision.noteId);
    const kind = note?.guidance.kind ?? decision.guidanceKind;
    cautionsByKind[kind] = (cautionsByKind[kind] ?? 0) + 1;
  }

  // ── The itemized manifest ────────────────────────────────────────────────
  // Exactly the records this click will mark human-reviewed, each with the
  // sentence being confirmed and the citation to find it. The counts above
  // summarise this list; they no longer stand in for it.
  const notesById = new Map(input.notes.map((n) => [n.id, n]));
  const nameOf = (documentId: string) => input.filenames?.get(documentId) ?? "";
  const manifestRecords: ManifestRecordLine[] = covered
    .map((decision) => {
      const note = notesById.get(decision.noteId);
      const byId = new Map((note?.rows ?? []).map((r) => [r.id, r]));
      // ONE LINE PER ROW BEING WRITTEN. A row with no loadable record still
      // gets a line — an empty summary is a visible gap a reviewer can refuse,
      // whereas silently dropping it would confirm a row that was never shown.
      const rows: ManifestRowLine[] = [...decision.confirmRowIds]
        .sort()
        .map((rowId) => {
          const row = byId.get(rowId);
          const documentId = row?.sourceDocumentId ?? decision.documentId;
          return {
            rowId,
            summary: row?.factualSummary ?? "",
            documentId,
            filename: nameOf(documentId),
            page: row?.page ?? null,
            pageEnd: row?.pageEnd ?? null,
            contentHash: row?.contentHash ?? "",
            status: row?.status ?? "",
          };
        });
      // The note header is derived from the rows BEING CONFIRMED, never from a
      // row outside that set: a header taken from an already-reviewed sibling
      // would describe the batch using content the batch is not writing.
      const confirmRows = rows.map((r) => byId.get(r.rowId)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      return {
        noteId: decision.noteId,
        documentId: decision.documentId,
        filename: nameOf(decision.documentId),
        encounterDate: confirmRows.find((r) => r.encounterDate)?.encounterDate ?? null,
        provider: confirmRows.find((r) => r.provider)?.provider ?? null,
        facility: confirmRows.find((r) => r.facility)?.facility ?? null,
        basis: decision.basis,
        rows,
        // Weighed from the note, which carries the extraction confidence, page
        // quality and assembly signals the row lines do not.
        risk: weighNote({
          id: decision.noteId,
          rowIds: decision.confirmRowIds,
          claims: (note?.claims ?? []) as never,
          claimCount: note?.claimCount ?? null,
          rows: confirmRows as never,
          crossDocumentMembers: note?.crossDocumentMembers ?? [],
          copies: note?.copies ?? [],
          corroboration: note?.corroboration ?? null,
          fragmentDisagreement: note?.fragmentDisagreement ?? [],
          membershipBasis: note?.membershipBasis ?? null,
          awaitingAttestation: note?.awaitingAttestation ?? null,
          attention: note?.attention ?? null,
        }),
      };
    })
    .sort((a, b) => a.noteId.localeCompare(b.noteId));

  const manifestEvents: ManifestEventLine[] = eligibleEvents
    .map((event) => ({
      eventId: event.id,
      eventDate: isoDay(event.eventDate ?? null),
      summary: typeof event.summary === "string" ? event.summary : "",
      documentId: event.sourceDocumentId ?? null,
      filename: event.sourceDocumentId ? (input.filenames?.get(event.sourceDocumentId) ?? null) : null,
      page: typeof event.sourcePage === "number" ? event.sourcePage : null,
      sourceRowIds: [...eventLineage(event)].sort(),
      linkage: "EXACT_LINEAGE" as const,
    }))
    .sort((a, b) => a.eventId.localeCompare(b.eventId));

  const counts = {
    canonicalEncounters: encounters.length,
    eligibleEncounters: covered.length,
    cleanEncounters: covered.filter((e) => e.level === "CLEAN").length,
    /** Notes carrying a caution. NOT covered, and NOT an exception. */
    cautionEncounters: encounters.filter((e) => e.cautionReasons.length > 0).length,
    alreadyReviewedEncounters: encounters.filter((e) => !e.reasons.length && !e.heldReasons.length && !e.confirmRowIds.length).length,
    skippedEncounters: encounters.filter((e) => e.reasons.length > 0).length,
    heldEncounters: encounters.filter((e) => !e.reasons.length && !e.cautionReasons.length && e.heldReasons.length > 0).length,
    rows: rowIds.length,
    events: eligibleEvents.length,
    heldEvents,
  };

  return {
    encounters,
    manifestRecords,
    manifestEvents,
    rowIds,
    eventIds: eligibleEvents.map((e) => e.id).sort(),
    counts,
    skippedByReason,
    cautionsByReason,
    heldByReason,
    heldEventsByReason,
    cautionsByKind,
    basisCounts,
    manifestHash: manifestHashOf({
      encounters,
      records: manifestRecords,
      events: manifestEvents,
      eventContent: eligibleEvents,
      counts,
      cautionsByKind,
      cautionsByReason,
      skippedByReason,
      heldByReason,
      heldEventsByReason,
      basisCounts,
    }),
  };
}
