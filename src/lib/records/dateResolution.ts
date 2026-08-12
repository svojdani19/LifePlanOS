// ─────────────────────────────────────────────────────────────────────────────
// What day did this record document, and how do we know?
//
// Dating was spread across three places that did not know about each other: a
// header date the extractor recorded, a claim-level recovery that ran only when
// that header was missing, and a year check that could refuse a header outright.
// A refused header therefore fell straight to "undated", even where the record
// said "HCPCS 99214 billed on 10/01/2024" in its own text — the recovery that
// reads exactly that had already been skipped, because the record did have a
// date when the question was asked.
//
// So the sources are ordered here, once, from strongest evidence to weakest,
// and every answer carries the basis it was reached on. A reviewer can see the
// difference between a date read off a page and one worked out from the records
// around it, and INFERRED is never presented as DOCUMENTED.
//
//   1. the header, where the document attests its year
//   2. the header's day, re-yeared from the page that prints it
//   3. a service date the record states in its own claims
//   4. the records either side of it, when they agree
//   5. nothing — and an undated record routes to human review
//
// Position is the weakest source for a reason. The chart that prompted this is
// not filed in order: one gap sits between a record dated 03/21 and one dated
// 03/18. Where the neighbours run backwards their position proves nothing, and
// this says so rather than averaging two dates into a plausible-looking third.
// ─────────────────────────────────────────────────────────────────────────────

import { dateFromClaims, type DatedClaim } from "@/lib/records/dateRecovery";
import { dateVerdict, type YearProfile } from "@/lib/records/dateSanity";
import type { NoteDateBasis } from "@/lib/records/noteStructure";

export type DateBasis =
  /** Read off the record, and the document attests the year. */
  | "DOCUMENTED"
  /** A field the containing note labels as the date of its own service. */
  | "NOTE_SERVICE_LABEL"
  /** An unambiguous date in the containing note's header. */
  | "NOTE_HEADER"
  /** The record's day, re-yeared from a date the page itself prints. */
  | "RETIMED_FROM_PAGE"
  /** A service date the record states in its own text. */
  | "STATED_IN_CLAIMS"
  /** The records either side of it carry the same date. */
  | "NEIGHBOURS_AGREE"
  /** The records either side of it bracket a short window, in order. */
  | "BRACKETED_BY_NEIGHBOURS"
  /** No source could date it. It routes to review. */
  | "NONE";

/** Why a record could not be dated, for the reviewer who has to fix it. */
export type UnresolvedReason =
  | "NO_SERVICE_DATE"
  | "CONFLICTING_DATES"
  | "ONLY_ARTIFACT_DATES"
  | "NOTE_BOUNDARY_UNCERTAIN"
  | "SOURCE_TEXT_INSUFFICIENT";

/** Which bases are read off the page rather than worked out. */
const DOCUMENTED_BASES = new Set<DateBasis>(["DOCUMENTED", "NOTE_SERVICE_LABEL", "NOTE_HEADER"]);

export interface ResolvedDate {
  iso: string | null;
  basis: DateBasis;
  /** The text the date was read from, where there was any. */
  evidence?: string;
  /** True when the program worked the date out rather than reading it. */
  inferred: boolean;
  /** Present only when nothing could date the record. */
  unresolvedReason?: UnresolvedReason;
}

/**
 * How far apart two bracketing records may sit and still place what is between
 * them.
 *
 * A record filed between two days of one admission belongs to that admission. A
 * record filed between visits four months apart could be either, and saying so
 * is more useful than picking one.
 */
export const MAX_BRACKET_DAYS = 7;

export interface DateSources {
  /** The date the extractor recorded, if any. */
  header: Date | null;
  claims: readonly DatedClaim[];
  /** Document text around the record, for corroborating a re-yeared date. */
  nearbyText: string;
  profile: YearProfile;
  /** Nearest already-resolved date before this record, by position. */
  before?: string | null;
  /** Nearest already-resolved date after this record, by position. */
  after?: string | null;
  /**
   * The signed note this record's text sits inside, when one contains it.
   *
   * Containment is the whole point: a note's date belongs to the fragments of
   * THAT note, and to nothing else. A date is never taken because it happens to
   * be printed nearby, which would give an operative report the date of the
   * admission note filed before it.
   */
  containingNote?: { date: string | null; dateBasis: NoteDateBasis | null; dateEvidence: string | null } | null;
  today?: Date;
}

export function resolveDate(sources: DateSources): ResolvedDate {
  const { header, claims, nearbyText, profile, today } = sources;

  if (header) {
    const verdict = dateVerdict(header, nearbyText, profile);
    if (verdict.verdict === "KEEP") {
      return { iso: header.toISOString().slice(0, 10), basis: "DOCUMENTED", inferred: false };
    }
    if (verdict.verdict === "RETIME") {
      return {
        iso: verdict.iso,
        basis: "RETIMED_FROM_PAGE",
        evidence: verdict.evidence,
        inferred: true,
      };
    }
    // UNTRUSTED falls through: a refused header is no worse than no header,
    // and the record may still say what day it documents.
  }

  // The note this record sits inside, dating itself in its own header or
  // service field. Read off the page, so it is documented rather than inferred.
  const note = sources.containingNote;
  if (note?.date && note.dateBasis) {
    return {
      iso: note.date,
      basis: note.dateBasis === "SERVICE_LABEL" ? "NOTE_SERVICE_LABEL" : "NOTE_HEADER",
      evidence: note.dateEvidence ?? undefined,
      inferred: false,
    };
  }

  const stated = dateFromClaims(claims, today);
  if (stated) {
    return { iso: stated.iso, basis: "STATED_IN_CLAIMS", evidence: stated.sourceText, inferred: true };
  }

  const positioned = fromNeighbours(sources.before ?? null, sources.after ?? null);
  if (positioned) return positioned;

  return { iso: null, basis: "NONE", inferred: false, unresolvedReason: whyUnresolved(sources) };
}

/** Whether a resolved date was read off the page rather than worked out. */
export function isDocumented(basis: DateBasis): boolean {
  return DOCUMENTED_BASES.has(basis);
}

function whyUnresolved(sources: DateSources): UnresolvedReason {
  const { header, claims, nearbyText, profile } = sources;

  // A header the year check refused: the page printed only dates that cannot
  // be the service date.
  if (header && dateVerdict(header, nearbyText, profile).verdict === "UNTRUSTED") {
    return "ONLY_ARTIFACT_DATES";
  }
  if (sources.before && sources.after) {
    const from = Date.parse(`${sources.before}T00:00:00Z`);
    const to = Date.parse(`${sources.after}T00:00:00Z`);
    // Backwards neighbours mean the packet is out of order here.
    if (Number.isFinite(from) && Number.isFinite(to) && to < from) return "CONFLICTING_DATES";
  }
  if (!sources.containingNote) return "NOTE_BOUNDARY_UNCERTAIN";
  if (!claims.length) return "SOURCE_TEXT_INSUFFICIENT";
  return "NO_SERVICE_DATE";
}

function fromNeighbours(before: string | null, after: string | null): ResolvedDate | null {
  if (!before || !after) return null;

  if (before === after) {
    return {
      iso: before,
      basis: "NEIGHBOURS_AGREE",
      evidence: `filed between two records dated ${before}`,
      inferred: true,
    };
  }

  // Backwards neighbours mean this stretch of the document is not filed in
  // order, so position is not evidence of anything here.
  const from = Date.parse(`${before}T00:00:00Z`);
  const to = Date.parse(`${after}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;

  const days = (to - from) / 86_400_000;
  if (days > MAX_BRACKET_DAYS) return null;

  // The record follows the one before it, so it carries that day until the next
  // dated record says the day has moved on.
  return {
    iso: before,
    basis: "BRACKETED_BY_NEIGHBOURS",
    evidence: `filed between records dated ${before} and ${after}`,
    inferred: true,
  };
}
