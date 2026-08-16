// ─────────────────────────────────────────────────────────────────────────────
// What a finding is ABOUT — the vocabulary, kept free of imports so both the
// server and the browser bundle can use it.
//
// The defect this replaces: audit findings were one unstructured array of
// strings copied onto every row of a document. A physician opening one entry
// saw problems belonging to other entries; a metric counting those strings
// reported 14 real contradictions as ~1,276. A finding now names its own
// target, and is counted by identity.
// ─────────────────────────────────────────────────────────────────────────────

/** The thing a finding is about. Narrower scopes are more actionable. */
export const FINDING_SCOPES = ["CASE", "DOCUMENT", "PAGE", "NOTE", "ENTRY", "CLAIM"] as const;
export type FindingScope = (typeof FINDING_SCOPES)[number];

/** Where the finding came from. Provenance is never inferred from wording. */
export const FINDING_SOURCES = [
  "DETERMINISTIC_VALIDATOR",
  "EXTRACTION_CRITIC",
  "ADJUDICATOR",
  "CORROBORATION",
  "OCR",
  "PAGE_LEDGER",
  "HUMAN_REVIEW",
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const FINDING_SEVERITIES = ["INFO", "WARNING", "BLOCKING"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * OPEN and CONFIRMED both still require work; DISMISSED and RESOLVED do not.
 * A dismissal always carries a reason — "we looked and it was fine" is a
 * different statement from "nobody looked".
 */
export const FINDING_STATUSES = ["OPEN", "CONFIRMED", "DISMISSED", "RESOLVED"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** A finding still demanding attention. */
export const isOpenFinding = (status: string): boolean => status === "OPEN" || status === "CONFIRMED";

/** Types, grouped by what a reviewer would do about them. */
export const FINDING_TYPES = [
  // Entry / claim level — a specific fact is wrong or unsupported.
  "CONTRADICTED_DATE",
  "CONTRADICTED_PROVIDER",
  "UNRESOLVED_DISPUTE",
  "UNSUPPORTED_CLAIM",
  "NOT_CORROBORATED",
  "UNDATED_CLINICAL",
  "DATE_ARTIFACT_REJECTED",
  "DATE_AMBIGUOUS",
  "PROVIDER_ROLE_REJECTED",
  // Note level.
  "STALE_REVIEW",
  "GENERATION_LOSS",
  // Document / page level — the record is incomplete.
  "MISSING_ENCOUNTER",
  "UNCLEAR_NOTE_BOUNDARY",
  "SECTION_NOT_PROCESSED",
  "PAGE_UNREADABLE",
  "PAGE_LOW_CONFIDENCE",
  "PAGE_TRUNCATED",
  "SOURCE_CLIPPED",
  "DOCUMENT_EXTRACTION_FAILED",
  /** The latest run is queued, running, paused, or never started. */
  "DOCUMENT_NOT_PROCESSED",
  // Case level.
  "DOCUMENTS_STILL_PROCESSING",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** Scopes whose findings block a final export but never mark an entry defective. */
export const COMPLETENESS_SCOPES: readonly FindingScope[] = ["CASE", "DOCUMENT", "PAGE"];
