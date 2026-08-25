// ─────────────────────────────────────────────────────────────────────────────
// How many records the chronology actually draws on.
//
// The Chronology panel said:
//
//     const excluded = Math.max(0, data.documents.length - events.length);
//     … "(N without a bearing on the complaint were excluded)"
//
// Subtracting a count of EVENTS from a count of DOCUMENTS is not a quantity.
// One operative note yielding forty events made `excluded` zero and the
// sentence claimed complete coverage of a case where most documents were never
// read. Forty documents yielding one event each produced a number that happened
// to look right for the wrong reason. And the moment events outnumber documents
// the clamp hides the nonsense entirely.
//
// It also asserted a CAUSE — "without a bearing on the complaint" — for
// documents whose real status was FAILED, PROCESSING, or simply not yet OCR'd.
// A record that could not be read is not a record that was found irrelevant,
// and telling a reviewer it was screened out is how an unreadable document
// stops being anybody's problem.
//
// So: count distinct source documents actually represented, and say only what
// the stored state proves.
// ─────────────────────────────────────────────────────────────────────────────

import { EXCLUDED_TYPES } from "@/lib/documents/chronologyExclusions";

export interface CoverageDocument {
  id: string;
  status?: string | null;
  type?: string | null;
}

export interface CoverageEvent {
  sourceDocumentId?: string | null;
  /** Per-visit members of a treatment series, each citing its own document. */
  seriesMembers?: unknown;
}

export interface ChronologyCoverage {
  /** Every document on the case. */
  totalDocuments: number;
  /** Distinct documents at least one chronology event cites. */
  representedDocuments: number;
  /**
   * Processed successfully, and excluded from the clinical chronology by a
   * STORED classification — a billing record, a deposition, a pleading. This
   * is the only bucket where "no chronology-bearing content" is a claim the
   * data supports.
   */
  excludedByType: number;
  /**
   * Processed successfully, not excluded by type, and still not represented.
   * Nothing here proves why, so nothing here is described as a reason.
   */
  processedNotRepresented: number;
  /** Never successfully processed: uploaded, queued, in flight, or failed. */
  unprocessed: number;
  /** Of those, the ones that actually failed — a fault, not a queue. */
  failed: number;
}

/** Documents a chronology event cites, including each series member's own. */
function citedDocumentIds(events: readonly CoverageEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (typeof event.sourceDocumentId === "string" && event.sourceDocumentId) {
      ids.add(event.sourceDocumentId);
    }
    // A treatment series cites one document in `sourceDocumentId` but spans
    // several visits, each with its own. Counting only the header would
    // under-report coverage for exactly the events that span the most records.
    if (Array.isArray(event.seriesMembers)) {
      for (const member of event.seriesMembers as { documentId?: unknown }[]) {
        if (member && typeof member.documentId === "string" && member.documentId) {
          ids.add(member.documentId);
        }
      }
    }
  }
  return ids;
}

export function chronologyCoverage(
  documents: readonly CoverageDocument[],
  events: readonly CoverageEvent[],
): ChronologyCoverage {
  // Membership is decided from the DOCUMENT side, so an event citing a
  // document that is no longer on the case cannot inflate coverage of one that
  // is. That is a data-integrity question, not a coverage one.
  const cited = citedDocumentIds(events);

  let representedDocuments = 0;
  let excludedByType = 0;
  let processedNotRepresented = 0;
  let unprocessed = 0;
  let failed = 0;

  for (const doc of documents) {
    if (cited.has(doc.id)) {
      representedDocuments += 1;
      continue;
    }
    if (doc.status !== "PROCESSED") {
      unprocessed += 1;
      if (doc.status === "FAILED") failed += 1;
      continue;
    }
    if (doc.type && EXCLUDED_TYPES.has(doc.type)) {
      excludedByType += 1;
      continue;
    }
    processedNotRepresented += 1;
  }

  return {
    totalDocuments: documents.length,
    representedDocuments,
    excludedByType,
    processedNotRepresented,
    unprocessed,
    failed,
  };
}

/**
 * The sentence under the timeline.
 *
 * Every clause is conditional on something the stored state proves. Where the
 * data does not establish a reason, the wording is neutral — "not represented
 * in the chronology" — rather than asserting the documents were screened out.
 */
export function coverageSentence(coverage: ChronologyCoverage, eventCount: number): string {
  const rec = (n: number) => `${n} ${n === 1 ? "record" : "records"}`;
  const head =
    `${eventCount} pivotal ${eventCount === 1 ? "event" : "events"} — those bearing on the diagnoses and future care — ` +
    `drawn from ${rec(coverage.representedDocuments)} of ${coverage.totalDocuments}`;

  const clauses: string[] = [];
  if (coverage.excludedByType > 0) {
    // Proven: the stored document type is one the clinical chronology excludes.
    clauses.push(`${rec(coverage.excludedByType)} excluded by record type`);
  }
  if (coverage.processedNotRepresented > 0) {
    // NOT proven: processed, not excluded, and still absent. Say only that.
    clauses.push(`${rec(coverage.processedNotRepresented)} not represented in the chronology`);
  }
  if (coverage.unprocessed > 0) {
    const failedPart = coverage.failed > 0 ? `, ${coverage.failed} failed` : "";
    clauses.push(`${rec(coverage.unprocessed)} not yet processed${failedPart}`);
  }

  return clauses.length ? `${head} (${clauses.join("; ")}).` : `${head}.`;
}
