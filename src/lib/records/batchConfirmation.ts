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

/** A chronology draft, as eligibility needs it. */
export interface ConfirmableEvent {
  id: string;
  reviewStatus: string;
  edited: boolean;
  sourceDocumentId: string | null;
  eventDate: Date | string;
  sourceFingerprint?: string | null;
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
  /** Why it was skipped. Empty when eligible. */
  reasons: { code: string; reason: string }[];
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
    /** Exceptions that stay in the individual path. */
    skippedEncounters: number;
    rows: number;
    events: number;
    /** Chronology drafts held back because their date is still in question. */
    heldEvents: number;
  };
  /** Why encounters were skipped, by code — shown before the click. */
  skippedByReason: Record<string, number>;
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

/** Stable, order-independent, and sensitive to anything that would change the decision. */
export function manifestHashOf(
  rows: readonly { id: string; contentHash: string; status: string }[],
  events: readonly ConfirmableEvent[],
): string {
  const rowPart = [...rows]
    .map((r) => `${r.id} ${r.contentHash} ${r.status}`)
    .sort()
    .join("\n");
  const eventPart = [...events]
    .map((e) => {
      const date = e.eventDate instanceof Date ? e.eventDate.toISOString() : String(e.eventDate);
      return `${e.id} ${e.reviewStatus} ${e.edited ? "1" : "0"} ${date} ${e.sourceFingerprint ?? ""}`;
    })
    .sort()
    .join("\n");
  return createHash("sha256").update(`rows\n${rowPart}\nevents\n${eventPart}`).digest("hex");
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
  const cautionsByKind: Record<string, number> = {};
  const basisCounts: Record<string, number> = {};

  for (const note of input.notes) {
    const reasons: { code: string; reason: string }[] = [];

    // 1. The review surface's own verdict. An EXCEPTION is a record that
    //    cannot be attested as it stands — ambiguous membership, a
    //    contradicted or disagreeing date, stale human work, generation loss,
    //    an unresolved dispute, an integrity failure, a record no independent
    //    re-reading reproduced, or a date that is required and missing. Each
    //    keeps its own guidance and its own individual path.
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

    // 5. Membership nobody could settle. Re-checked explicitly rather than
    //    trusted to the verdict above, because it is the one exception the
    //    compatibility grouping itself introduces.
    if (note.ambiguousAssignment) {
      reasons.push({ code: "AMBIGUOUS_ASSIGNMENT", reason: "this record's extent is unresolved" });
    }

    const confirmRowIds = note.rows
      .filter((r) => CONFIRMABLE_ROW_STATES.includes(r.status) && !humanAuthoritative(r))
      .map((r) => r.id)
      .sort();

    const deduped = [...new Map(reasons.map((r) => [`${r.code} ${r.reason}`, r])).values()];
    const eligible = deduped.length === 0 && confirmRowIds.length > 0;
    encounters.push({
      noteId: note.id,
      documentId: note.sourceDocumentId,
      rowIds: [...note.rowIds],
      confirmRowIds,
      eligible,
      level: note.attention,
      guidanceKind: note.guidance.kind,
      reasons: deduped,
    });

    if (deduped.length) {
      // One encounter, one reason line: the most specific reason it carries,
      // so the skipped counts add up to the skipped encounters instead of
      // over-reporting the same record under several headings.
      const code = deduped[0].code;
      skippedByReason[code] = (skippedByReason[code] ?? 0) + 1;
    } else if (eligible) {
      basisCounts[note.membershipBasis] = (basisCounts[note.membershipBasis] ?? 0) + 1;
      if (note.attention === "CAUTION") {
        cautionsByKind[note.guidance.kind] = (cautionsByKind[note.guidance.kind] ?? 0) + 1;
      }
    }
  }

  // ── Chronology ───────────────────────────────────────────────────────────
  // A draft nobody has edited, on a date whose records this confirmation is
  // also covering. An event on a document-and-date that still carries an
  // unresolved record is held back: confirming the timeline entry for a visit
  // whose own record is in question would attest the one through the other.
  //
  // Deliberately conservative, and deliberately NOT case-wide: one exception
  // holds its own date in its own document, never the whole timeline.
  const contestedDays = new Set<string>();
  for (const decision of encounters) {
    if (!decision.reasons.length) continue;
    const note = input.notes.find((n) => n.id === decision.noteId);
    const day = isoDay(note?.encounterDate ?? null);
    if (day) contestedDays.add(`${decision.documentId} ${day}`);
  }

  const eligibleEvents: ConfirmableEvent[] = [];
  let heldEvents = 0;
  for (const event of input.events) {
    // Only a current, untouched machine draft. STALE, SUPERSEDED and anything
    // a person has edited or already decided is left exactly as it is.
    if (event.reviewStatus !== "AI_DRAFT" || event.edited) continue;
    const day = isoDay(event.eventDate);
    if (day && event.sourceDocumentId && contestedDays.has(`${event.sourceDocumentId} ${day}`)) {
      heldEvents++;
      continue;
    }
    eligibleEvents.push(event);
  }

  const covered = encounters.filter((e) => e.eligible);
  // DEDUPED on purpose. A cross-document copy is a member of the primary
  // record's note AND the subject of a note in its own production, so it
  // legitimately appears twice among the covered encounters. One decision
  // covers every copy — naming the row twice would make the re-check below
  // count a row it could only load once and refuse the whole batch.
  const rowIds = [...new Set(covered.flatMap((e) => e.confirmRowIds))].sort();
  const rowsById = new Map(input.notes.flatMap((n) => n.rows.map((r) => [r.id, r] as const)));
  const manifestRows = rowIds
    .map((id) => rowsById.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((row) => ({ id: row.id, contentHash: row.contentHash, status: row.status }));

  return {
    encounters,
    rowIds,
    eventIds: eligibleEvents.map((e) => e.id).sort(),
    counts: {
      canonicalEncounters: encounters.length,
      eligibleEncounters: covered.length,
      cleanEncounters: covered.filter((e) => e.level === "CLEAN").length,
      cautionEncounters: covered.filter((e) => e.level === "CAUTION").length,
      alreadyReviewedEncounters: encounters.filter((e) => !e.reasons.length && !e.confirmRowIds.length).length,
      skippedEncounters: encounters.filter((e) => e.reasons.length > 0).length,
      rows: rowIds.length,
      events: eligibleEvents.length,
      heldEvents,
    },
    skippedByReason,
    cautionsByKind,
    basisCounts,
    manifestHash: manifestHashOf(manifestRows, eligibleEvents),
  };
}
