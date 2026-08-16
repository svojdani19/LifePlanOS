// ─────────────────────────────────────────────────────────────────────────────
// Which dates in a record may become a SERVICE date.
//
// Derived from adjudicated contradictions on a real case — eight date errors,
// each of a recurring kind:
//
//   • a witness/signature timestamp taken as the date of service;
//   • an artifact date ("Depart Date 5/24/73") wildly inconsistent with the
//     encounter it was attached to;
//   • a compact numeric ("110624") parsed as a different date;
//   • an ambiguous partial ("JUNE - 08") given a guessed year;
//   • an explicit range ("03/15/2024-07/23/2024 (dates of service)") collapsed
//     into its first day;
//   • an open-ended range ("03/15/2024 to present") likewise;
//   • a relative "today" resolved against the wrong event.
//
// These are mechanical, so they are enforced here rather than hoped for in a
// prompt. Every rejection returns a reason code, because a date that vanishes
// without explanation is worse than a wrong one: a reviewer cannot act on it.
//
// Nothing here invents a date. The strongest action is DEMOTION — the
// encounter keeps its claims and lands in the undated review group, where a
// human sets the date from the source.
// ─────────────────────────────────────────────────────────────────────────────

export type DateRejection =
  | "SIGNATURE_OR_WITNESS_LINE"
  | "PRINT_OR_TRANSMISSION"
  | "BIRTH_DATE"
  | "ARTIFACT_FIELD"
  | "AMBIGUOUS_PARTIAL"
  | "COMPACT_NUMERIC_UNLABELLED"
  | "RELATIVE_WITHOUT_ANCHOR"
  | "IMPLAUSIBLE_FOR_ENCOUNTER";

/**
 * Labels whose date is about the PAPER, not the care.
 *
 * Matched against the words immediately around the cited date, never against
 * the whole page: a note that happens to contain a signature block elsewhere
 * still has a perfectly good service date of its own.
 */
const SIGNATURE_CONTEXT = /\b(?:electronically\s+)?sign(?:ed|ature)\b|\bwitness(?:ed|\s+signature)?\b|\bnotar(?:y|ized|ization)\b|\battest(?:ed|ation)\b|\bcertified\s+by\b/i;
const TRANSMISSION_CONTEXT = /\bprint(?:ed)?\b|\bgenerated\b|\bfax(?:ed)?\b|\btransmi(?:t|tted|ssion)\b|\bexported\b|\buploaded\b|\breceived\s+by\s+fax\b|\bpage\s+\d+\s+of\s+\d+\b/i;
const BIRTH_CONTEXT = /\b(?:date\s+of\s+birth|dob|birth\s*date|d\.o\.b\.)\b/i;
/**
 * Fields that carry a date which is not this encounter's service date. NOT a
 * blanket word ban: "depart" only disqualifies when the value it labels is
 * implausible for the encounter, which is exactly how the real error looked
 * (a 1973 departure stamped on a 2024 visit).
 */
const ARTIFACT_LABEL = /\b(?:depart(?:ure)?\s*date|admit\s*date\s*\(prior\)|next\s+appointment|follow[-\s]?up\s+(?:on|date)|scheduled\s+for|due\s+date|expiration|effective\s+date|policy\s+date)\b/i;

/** A service-date label makes an otherwise ambiguous string trustworthy. */
const SERVICE_LABEL = /\b(?:date\s+of\s+service|dos|service\s+date|date\s+of\s+procedure|encounter\s+date|visit\s+date|exam\s+date|date\s+performed|collection\s+date|admission\s+date|discharge\s+date)\b/i;

/** How much text around the cited date counts as its context. */
const CONTEXT_WINDOW = 90;

/**
 * The LINE the citation sits on.
 *
 * Charts put a date and the label that governs it on one line — "Date of
 * Service: 03/18/2024", "Depart Date 5/24/73", "Printed 07/11/2025". Judging
 * from a character window instead let a service label three lines away bless
 * a print stamp, which is precisely the confusion these rules exist to stop.
 */
export function lineAround(haystack: string, needle: string): string {
  if (!needle) return "";
  const at = haystack.indexOf(needle);
  if (at < 0) return needle;
  const start = haystack.lastIndexOf("\n", at) + 1;
  const end = haystack.indexOf("\n", at + needle.length);
  return haystack.slice(start, end < 0 ? haystack.length : end);
}

/** The text immediately surrounding the first occurrence of `needle`. */
export function contextAround(haystack: string, needle: string, window = CONTEXT_WINDOW): string {
  if (!needle) return "";
  const at = haystack.indexOf(needle);
  if (at < 0) return haystack.slice(0, window * 2);
  return haystack.slice(Math.max(0, at - window), at + needle.length + window);
}

export interface DateEvidenceInput {
  /** The date the extractor proposes, ISO. */
  iso: string | null;
  /** The excerpt the extractor cited for it. */
  excerpt: string;
  /** The note/segment text the excerpt must live inside. */
  noteText: string;
  /** The encounter's own year, when another dated fact establishes one. */
  plausibleYear?: number | null;
}

export interface DateEvidenceVerdict {
  ok: boolean;
  reason?: DateRejection;
  /** PHI-free explanation for a reviewer. */
  detail?: string;
}

/**
 * May this cited date be used as the encounter's service date?
 *
 * Judged from the words around the citation, inside the note that owns it.
 */
export function judgeDateEvidence(input: DateEvidenceInput): DateEvidenceVerdict {
  const { iso, excerpt } = input;
  if (!iso) return { ok: true };
  // Both the label and the disqualifier are judged on the citation's OWN line.
  const line = lineAround(input.noteText || excerpt, excerpt) || excerpt;
  const context = line;
  const labelled = SERVICE_LABEL.test(line);

  if (BIRTH_CONTEXT.test(context)) {
    return { ok: false, reason: "BIRTH_DATE", detail: "The cited date is labelled as a date of birth, not a date of service." };
  }
  // A service label beats a nearby signature block: charts routinely print
  // both, and the labelled one is the answer.
  if (!labelled && SIGNATURE_CONTEXT.test(context)) {
    return { ok: false, reason: "SIGNATURE_OR_WITNESS_LINE", detail: "The cited date sits on a signature, witness or attestation line, which records when the paper was signed rather than when care was given." };
  }
  if (!labelled && TRANSMISSION_CONTEXT.test(context)) {
    return { ok: false, reason: "PRINT_OR_TRANSMISSION", detail: "The cited date sits on a print, fax or transmission line, which records when the document moved rather than when care was given." };
  }
  if (!labelled && ARTIFACT_LABEL.test(context)) {
    const year = Number(iso.slice(0, 4));
    const plausible = input.plausibleYear ?? null;
    // Only disqualifying when the value cannot belong to this encounter —
    // "depart date" is a real field, and rejecting the word everywhere would
    // throw away legitimate discharge dates.
    if (plausible != null && Math.abs(year - plausible) > 1) {
      return {
        ok: false,
        reason: "IMPLAUSIBLE_FOR_ENCOUNTER",
        detail: "The cited date comes from an ancillary form field and is years away from this encounter's other dated content.",
      };
    }
  }
  return { ok: true };
}

// ── Ranges ───────────────────────────────────────────────────────────────────

export interface DateRange {
  start: string;
  /** null when the source says the range is still running. */
  end: string | null;
  openEnded: boolean;
}

const RANGE_RE =
  /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\s*(?:-|–|—|\bto\b|\bthrough\b)\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\bpresent\b|\bcurrent\b|\bongoing\b|\bdate\b)/i;

/**
 * An explicit service-date RANGE, preserved as a range.
 *
 * "03/15/2024-07/23/2024 (dates of service)" documents a course of care, and
 * flattening it to its first day silently discards the end — which the
 * adjudicator caught twice on one case.
 */
export function parseDateRange(text: string, toIso: (raw: string) => string | null): DateRange | null {
  const m = text.match(RANGE_RE);
  if (!m) return null;
  const start = toIso(m[1]);
  if (!start) return null;
  const tail = m[2].toLowerCase();
  if (/present|current|ongoing|^date$/.test(tail)) {
    // Explicitly open-ended. Never given an invented end date.
    return { start, end: null, openEnded: true };
  }
  const end = toIso(m[2]);
  if (!end) return null;
  return { start, end, openEnded: false };
}

// ── Ambiguity ────────────────────────────────────────────────────────────────

/** "JUNE - 08", "6/08", "June 2008?" — a component is missing or unclear. */
const PARTIAL_DATE_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[-–]?\s*\d{1,2}\b(?!\s*[/-]\s*\d)/i;

/** Is this citation too incomplete to assert a calendar date? */
export function isAmbiguousPartial(excerpt: string): boolean {
  if (!PARTIAL_DATE_RE.test(excerpt)) return false;
  // A full date elsewhere in the same citation resolves it.
  return !/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b/.test(excerpt);
}

/** A bare 6-digit run like "110624": only trustworthy under a service label. */
export function isUnlabelledCompactNumeric(excerpt: string, context: string): boolean {
  if (!/\b\d{6}\b/.test(excerpt)) return false;
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(excerpt)) return false;
  return !SERVICE_LABEL.test(context);
}

/** "today", "this morning" — resolvable only against an anchor in the same note. */
export function isRelativeWithoutAnchor(excerpt: string, noteHasAnchorDate: boolean): boolean {
  return /\b(?:today|this\s+(?:morning|afternoon|evening)|yesterday|tomorrow)\b/i.test(excerpt) && !noteHasAnchorDate;
}
