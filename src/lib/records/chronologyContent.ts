// ─────────────────────────────────────────────────────────────────────────────
// What a chronology event SAYS, as a hash.
//
// `ChronologyEvent` has no `updatedAt`, so there is no column to compare-and-set
// against, and `sourceFingerprint` is not a substitute: it fingerprints the
// EXTRACTED claims and citations an event was generated from, not the sentence
// and structured fields a reader of the Medical Chronology actually sees. An
// event whose summary, work status or disposition changed while its review
// status stayed AI_DRAFT would carry the same fingerprint and the same status,
// and a batch confirmation would sign content nobody had displayed.
//
// So the identity of an event, for the purpose of confirming it, is everything
// that can materially reach the report — every narrative and structured field,
// every citation, the dates and the range, the series membership, the
// relevance and relatedness — plus the review state the confirmation is
// conditioned on.
//
// Pure and deterministic: no clock, no ordering dependence, no model. Nothing
// here writes, and nothing here is part of generating an event; it only reads
// one and says what it currently is.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

/**
 * Every field of a chronology event that can materially appear in the Medical
 * Chronology or the Medical Record Summary, in a fixed order.
 *
 * Listed exhaustively rather than derived from the object's own keys: a hash
 * built from `Object.keys` silently stops covering a column the day somebody
 * forgets to select it, which is the failure mode this exists to prevent. Add
 * a column to the model and it must be added here, deliberately.
 */
export const CHRONOLOGY_CONTENT_FIELDS = [
  // When, and over what span.
  "eventDate",
  "eventDateEnd",
  "dateInferred",
  // What kind of care, by whom, where.
  "eventType",
  "recordType",
  "specialty",
  "provider",
  "facility",
  // The narrative and the structured LCP encounter fields.
  "summary",
  "subjective",
  "pastMedicalHistory",
  "objectiveFindings",
  "diagnosis",
  "treatment",
  "procedure",
  "disposition",
  "imagingFindings",
  "medications",
  "restrictions",
  "workStatus",
  "functionalStatus",
  "impairmentRating",
  "clinicalSignificance",
  // The citation back to the record.
  "sourceDocumentId",
  "sourcePage",
  "sourceQuote",
  "sourceFingerprint",
  "extractionId",
  // Weighting, and a series' explicit membership.
  "relevanceScore",
  "relatedness",
  "seriesMembers",
  // The exact source rows this event was built from. Part of the CONTENT: a
  // rebuild that re-attributes an event to a different encounter — same id,
  // same prose, same date — must move the hash, or a reviewer's confirmation
  // carries over to a record they never saw it attached to.
  "sourceRowIds",
  // The review state a confirmation is conditioned on. Present so that a
  // decision taken elsewhere between the dialog and the click moves the hash.
  "reviewStatus",
  "edited",
] as const;

/** A chronology event as content hashing needs it. Every field optional. */
export type ChronologyContentRow = Partial<Record<(typeof CHRONOLOGY_CONTENT_FIELDS)[number], unknown>> & {
  id: string;
};

/** Stable across process runs, JSON key order and array identity. */
function canonicalize(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(canonicalize).join("|")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${canonicalize(v)}`)
      .sort()
      .join("|")}}`;
  }
  return String(value);
}

/** The content identity of ONE chronology event. */
export function chronologyEventContentHash(event: ChronologyContentRow): string {
  const body = CHRONOLOGY_CONTENT_FIELDS.map((field) => `${field}=${canonicalize(event[field])}`).join("\n");
  return createHash("sha256").update(`chronology-event\n${event.id}\n${body}`).digest("hex").slice(0, 32);
}

/**
 * The Prisma `select` that loads exactly what the hash covers.
 *
 * Exported so the preview and the write read the SAME columns: a manifest
 * computed over a narrower selection than the one it is later checked against
 * would differ for a reason that is not a change.
 */
export const CHRONOLOGY_CONTENT_SELECT = {
  id: true,
  ...Object.fromEntries(CHRONOLOGY_CONTENT_FIELDS.map((f) => [f, true])),
} as const;
