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
};

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
  /** Why this record is passed over WITHOUT being a decision of its own. */
  heldReasons: { code: string; reason: string }[];
}

export interface BatchConfirmationPlan {
  encounters: BatchEncounterDecision[];
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
    /** Exceptions that stay in the individual path. Each is one decision. */
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
  /** Why encounters were skipped, by code — shown before the click. */
  skippedByReason: Record<string, number>;
  /** Why encounters were held without being a decision, by code. */
  heldByReason: Record<string, number>;
  /** Why chronology drafts were held back, by code. */
  heldEventsByReason: Record<string, number>;
  /** Which cautions this confirmation would cover, by kind — disclosed. */
  cautionsByKind: Record<string, number>;
  /** How each covered encounter's membership was established, for the record. */
  basisCounts: Record<string, number>;
  /**
   * Deterministic identity of EXACTLY what is being confirmed: every row with
   * the content hash it was displayed as, and every event with the state it
   * was displayed in. The browser sends this back; the server recomputes it
   * and refuses the whole batch if anything moved in between.
   */
  manifestHash: string;
}

/** The complete confirmation as it was DISPLAYED, for hashing. */
export interface ManifestInput {
  /** Every canonical decision shown, eligible or not. */
  encounters: readonly BatchEncounterDecision[];
  /** Every covered row with the content hash it was displayed as. */
  rows: readonly { id: string; contentHash: string; status: string }[];
  /** Every covered chronology draft, by full content. */
  events: readonly ConfirmableEvent[];
  counts: BatchConfirmationPlan["counts"];
  cautionsByKind: Record<string, number>;
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
 * So the manifest is the whole plan: which canonical encounter each row
 * belongs to, how that membership was established, what was decided about it
 * and why, the counts, the cautions and the skipped reasons — plus the full
 * content of every covered row and event.
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
  const rowPart = [...input.rows]
    .map((r) => `${r.id} ${r.contentHash} ${r.status}`)
    .sort()
    .join("\n");
  // Full content, not id-and-status: a chronology event has no `updatedAt` to
  // compare-and-set against, so its content IS the version being confirmed.
  const eventPart = [...input.events]
    .map((e) => `${e.id} ${chronologyEventContentHash(e)}`)
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
        "rows",
        rowPart,
        "events",
        eventPart,
        "counts",
        countPart,
        "cautions",
        tally(input.cautionsByKind),
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
}): BatchConfirmationPlan {
  const encounters: BatchEncounterDecision[] = [];
  const skippedByReason: Record<string, number> = {};
  const heldByReason: Record<string, number> = {};
  const heldEventsByReason: Record<string, number> = {};
  const cautionsByKind: Record<string, number> = {};
  const basisCounts: Record<string, number> = {};

  for (const note of input.notes) {
    const reasons: { code: string; reason: string }[] = [];
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
    const held = [...new Map(heldReasons.map((r) => [`${r.code} ${r.reason}`, r])).values()];
    const eligible = decisions.length === 0 && held.length === 0 && confirmRowIds.length > 0;
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
      heldReasons: held,
    });

    if (decisions.length) {
      // One encounter, one reason line: the most specific reason it carries,
      // so the skipped counts add up to the skipped encounters instead of
      // over-reporting the same record under several headings.
      skippedByReason[decisions[0].code] = (skippedByReason[decisions[0].code] ?? 0) + 1;
    } else if (held.length) {
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
  const supportedDays = new Set<string>();
  const contestedDays = new Set<string>();
  for (const decision of encounters) {
    const note = input.notes.find((n) => n.id === decision.noteId);
    const day = isoDay(note?.encounterDate ?? null);
    if (!day) continue;
    const key = `${decision.documentId} ${day}`;
    if (decision.reasons.length || decision.heldReasons.length) contestedDays.add(key);
    // Settled by THIS confirmation, or settled already by a person.
    else if (decision.eligible || note?.rows.every((r) => humanAuthoritative(r))) supportedDays.add(key);
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
    const day = isoDay(event.eventDate ?? null);
    if (!event.sourceDocumentId || !day) {
      holdEvent("NO_SOURCE_CITATION");
      continue;
    }
    const key = `${event.sourceDocumentId} ${day}`;
    // An exception on the linked document and date holds the event, even when
    // another record on that day is fine: one unresolved record holds its own
    // day in its own document, and never the case's whole timeline.
    if (contestedDays.has(key)) {
      holdEvent("RECORD_IN_QUESTION");
      continue;
    }
    if (!supportedDays.has(key)) {
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
  const rowsById = new Map(input.notes.flatMap((n) => n.rows.map((r) => [r.id, r] as const)));
  const manifestRows = rowIds
    .map((id) => rowsById.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((row) => ({ id: row.id, contentHash: row.contentHash, status: row.status }));

  for (const decision of covered) {
    basisCounts[decision.basis] = (basisCounts[decision.basis] ?? 0) + 1;
    if (decision.level === "CAUTION") {
      const note = input.notes.find((n) => n.id === decision.noteId);
      const kind = note?.guidance.kind ?? decision.guidanceKind;
      cautionsByKind[kind] = (cautionsByKind[kind] ?? 0) + 1;
    }
  }

  const counts = {
    canonicalEncounters: encounters.length,
    eligibleEncounters: covered.length,
    cleanEncounters: covered.filter((e) => e.level === "CLEAN").length,
    cautionEncounters: covered.filter((e) => e.level === "CAUTION").length,
    alreadyReviewedEncounters: encounters.filter((e) => !e.reasons.length && !e.heldReasons.length && !e.confirmRowIds.length).length,
    skippedEncounters: encounters.filter((e) => e.reasons.length > 0).length,
    heldEncounters: encounters.filter((e) => !e.reasons.length && e.heldReasons.length > 0).length,
    rows: rowIds.length,
    events: eligibleEvents.length,
    heldEvents,
  };

  return {
    encounters,
    rowIds,
    eventIds: eligibleEvents.map((e) => e.id).sort(),
    counts,
    skippedByReason,
    heldByReason,
    heldEventsByReason,
    cautionsByKind,
    basisCounts,
    manifestHash: manifestHashOf({
      encounters,
      rows: manifestRows,
      events: eligibleEvents,
      counts,
      cautionsByKind,
      skippedByReason,
      heldByReason,
      heldEventsByReason,
      basisCounts,
    }),
  };
}
