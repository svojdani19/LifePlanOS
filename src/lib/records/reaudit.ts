// ─────────────────────────────────────────────────────────────────────────────
// Re-grade a case with the CURRENT deterministic rules, without a model.
//
// Deterministic audit rules have been corrected several times — document-level
// facts that were copied onto every row, case-level facts that made an entry's
// grade depend on which sibling document happened to run first. Those fixes
// only reached rows that were re-extracted, which costs hours of model time
// for a change that needs none: the inputs (claims, pages, runs, segments) are
// already persisted, and the audit is a pure function of them.
//
// What this may change: auditResult, scoped findings, audit version, and the
// legacy findings array. What it must never change: extracted facts, human
// status, verification hashes, reviewer identity, or history. A row a person
// reviewed stays reviewed; only machine rows move between AI_DRAFT and
// AI_AUDIT_PASSED, and only when the current rules justify it.
// ─────────────────────────────────────────────────────────────────────────────

import { auditFactualRecord, type AuditEncounter, type AuditOutcome } from "@/lib/llm/factualAudit";
import { canonicalNoteId } from "@/lib/records/reviewBurden";
import type { FindingDraft } from "@/lib/records/recordFindings";

/** Bumped whenever deterministic grading changes; persisted on every row. */
export const AUDIT_VERSION = "2026-08-17.scoped-findings";

/** Statuses a machine re-audit may move between. Everything else is human. */
const MACHINE_STATUSES = new Set(["AI_DRAFT", "AI_AUDIT_PASSED"]);

export interface ReauditRow {
  id: string;
  sourceDocumentId: string;
  status: string;
  auditResult: string | null;
  auditVersion?: string | null;
  dateStatus: string;
  encounterDate: Date | null;
  provider: string | null;
  encounterType: string | null;
  factualSummary: string;
  synthesis?: string | null;
  claims: unknown;
  page: number | null;
  unresolvedDisputes?: number | null;
  contradictedFields?: string[] | null;
}

/**
 * The state of a document's LATEST extraction run.
 *
 * The distinction that matters: only COMPLETE means this pass can see the
 * document's real inputs. Every other state means the persisted rows are a
 * partial or absent picture, so the pass may raise a blocker about the
 * document but may not resolve one.
 */
export type ReauditRunState =
  | "COMPLETE"
  | "EXTRACTION_FAILED"
  | "BLOCKED_OCR"
  | "ABANDONED"
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "NOT_RUN";

export interface ReauditDocument {
  id: string;
  firmId: string;
  caseId: string;
  segments: unknown;
  rows: ReauditRow[];
  pages: { pageNumber: number; status: string; ocrConfidence: number | null }[];
  /** Status of the LATEST run — not of some historical one. */
  runState: ReauditRunState;
  /** Facts from that latest run. */
  run: { coverageGaps?: number | null; failedSections?: number | null; truncated?: boolean | null } | null;
}

export interface ReauditPlan {
  /** Per row: the result the current rules give it. */
  results: { id: string; before: string | null; after: string; statusBefore: string; statusAfter: string }[];
  findings: FindingDraft[];
  /**
   * Documents whose latest state this pass authoritatively evaluated — the
   * ONLY documents whose stale findings it may supersede. A document whose
   * latest run did not complete is deliberately absent: the pass could not
   * reproduce its blockers, and "could not see it" is not "it is gone".
   */
  evaluatedDocumentIds: string[];
  /** True only when every document in the case was authoritatively evaluated. */
  evaluatedWholeCase: boolean;
  /** Aggregate, PHI-free. */
  summary: {
    rows: number;
    documents: number;
    documentsEvaluated: number;
    documentsSkipped: number;
    emptyDocuments: number;
    changedResult: number;
    changedStatus: number;
    humanRowsUntouched: number;
    findingsDerived: number;
  };
}

/** What an unfinished document's latest run means for the reviewer. */
const RUN_STATE_FINDING: Record<Exclude<ReauditRunState, "COMPLETE">, { type: string; detail: string }> = {
  EXTRACTION_FAILED: { type: "DOCUMENT_EXTRACTION_FAILED", detail: "This document's extraction failed; its content is not represented in the record." },
  BLOCKED_OCR: { type: "DOCUMENT_EXTRACTION_FAILED", detail: "This document could not be read by OCR, so its extraction never ran; its content is not represented." },
  ABANDONED: { type: "DOCUMENT_EXTRACTION_FAILED", detail: "This document's extraction run was abandoned before finishing; its content is not fully represented." },
  PENDING: { type: "DOCUMENT_NOT_PROCESSED", detail: "This document is queued for extraction and has not been processed yet." },
  RUNNING: { type: "DOCUMENT_NOT_PROCESSED", detail: "This document's extraction is still running; its content is not yet fully represented." },
  PAUSED: { type: "DOCUMENT_NOT_PROCESSED", detail: "This document's extraction paused part-way; the remainder has not been read." },
  NOT_RUN: { type: "DOCUMENT_NOT_PROCESSED", detail: "This document has never been extracted; none of its content is represented in the record." },
};

const claimsOf = (row: ReauditRow) =>
  Array.isArray(row.claims)
    ? (row.claims as { field?: string; claimType?: string; value?: string; excerpt?: string; page?: number | null; warning?: string }[])
    : [];

/**
 * Compute — without writing — what the current rules say about a case.
 *
 * Case-level facts are passed in by the caller, because they are a property of
 * the CASE rather than of any document, and must be applied identically to
 * every document so processing order cannot change a grade.
 */
export function planReaudit(
  documents: readonly ReauditDocument[],
  caseFacts: { failedExtractions: number; allDocumentsProcessed: boolean },
): ReauditPlan {
  const results: ReauditPlan["results"] = [];
  const findings: FindingDraft[] = [];
  const evaluatedDocumentIds: string[] = [];
  let changedResult = 0;
  let changedStatus = 0;
  let humanRowsUntouched = 0;
  let emptyDocuments = 0;

  for (const doc of documents) {
    // A document with no active rows is NOT skipped. "Nothing extracted" is
    // one of the strongest signals there is — an unprocessed or empty-yield
    // document is exactly the one most likely to own a completeness blocker,
    // and skipping it while superseding case-wide is how such a blocker was
    // silently cleared.
    if (!doc.rows.length) emptyDocuments++;
    // Only a completed latest run gives this pass the document's real inputs.
    const authoritative = doc.runState === "COMPLETE";
    if (authoritative) evaluatedDocumentIds.push(doc.id);
    else {
      const shape = RUN_STATE_FINDING[doc.runState as Exclude<ReauditRunState, "COMPLETE">];
      findings.push({
        firmId: doc.firmId,
        caseId: doc.caseId,
        scope: "DOCUMENT",
        type: shape.type,
        blocking: true,
        severity: "BLOCKING",
        source: "DETERMINISTIC_VALIDATOR",
        sourceDocumentId: doc.id,
        detail: shape.detail,
        producerVersion: AUDIT_VERSION,
      });
    }

    const auditEncounters: AuditEncounter[] = doc.rows.map((r, i) => ({
      id: String(i),
      sourceDocumentId: doc.id,
      dateStatus: r.dateStatus,
      encounterDate: r.encounterDate?.toISOString().slice(0, 10) ?? null,
      provider: r.provider,
      encounterType: r.encounterType,
      factualSummary: r.factualSummary,
      synthesis: r.synthesis ?? null,
      claims: claimsOf(r).map((c, j) => ({
        id: `c${j}`,
        field: c.field ?? "",
        claimType: c.claimType,
        value: c.value ?? "",
        excerpt: c.excerpt ?? "",
        page: c.page ?? null,
        warning: c.warning,
      })),
      page: r.page,
      status: r.status,
      unresolvedDisputes: r.unresolvedDisputes ?? 0,
      contradictedFields: Array.isArray(r.contradictedFields) ? r.contradictedFields : [],
    }));

    const outcome: AuditOutcome = auditFactualRecord({
      encounters: auditEncounters,
      pages: doc.pages,
      failedExtractions: caseFacts.failedExtractions,
      failedSections: doc.run?.failedSections ?? 0,
      coverageGaps: doc.run?.coverageGaps ?? 0,
      truncatedSource: doc.run?.truncated ?? false,
      unresolvedDisputes: 0,
      allDocumentsProcessed: caseFacts.allDocumentsProcessed,
      // A document whose latest run did not complete is incomplete in its own
      // right, and its own entries inherit that.
      thisDocumentIncomplete: !authoritative,
    });

    // Row ids by their position in the persisted segment, so a NOTE-scoped
    // finding can name the canonical note rather than one fragment of it.
    const noteOfRow = new Map<string, string>();
    const segments = Array.isArray(doc.segments) ? (doc.segments as { rowIds?: unknown }[]) : [];
    for (const seg of segments) {
      const ids = Array.isArray(seg?.rowIds) ? (seg.rowIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const live = ids.filter((id) => doc.rows.some((r) => r.id === id));
      if (!live.length) continue;
      const noteId = canonicalNoteId(doc.id, live);
      for (const id of live) noteOfRow.set(id, noteId);
    }

    doc.rows.forEach((row, index) => {
      let after = outcome.perEncounter[index] ?? outcome.result;
      // A row extracted before dispute state was persisted carries UNKNOWN
      // dispute data, not zero. Re-deriving "no conflict" from absent data
      // would silently clear a real contradiction, so a legacy conflict is
      // preserved until an extraction actually reproduces the row.
      const disputeStateKnown = row.auditVersion != null;
      if (!disputeStateKnown && row.auditResult === "SOURCE_CONFLICT" && after !== "SOURCE_CONFLICT") {
        after = "SOURCE_CONFLICT";
      }
      const isHuman = !MACHINE_STATUSES.has(row.status);
      if (isHuman) humanRowsUntouched++;
      // A human status is never rewritten by a machine re-grade.
      const statusAfter = isHuman ? row.status : after === "PASS" ? "AI_AUDIT_PASSED" : "AI_DRAFT";
      if (row.auditResult !== after) changedResult++;
      if (row.status !== statusAfter) changedStatus++;
      results.push({ id: row.id, before: row.auditResult, after, statusBefore: row.status, statusAfter });
    });

    for (const f of outcome.scoped) {
      const row = f.encounterIndex != null ? doc.rows[f.encounterIndex] : undefined;
      findings.push({
        firmId: doc.firmId,
        caseId: doc.caseId,
        scope: f.scope,
        type: f.type,
        blocking: f.blocking,
        severity: f.blocking ? "BLOCKING" : "WARNING",
        source: "DETERMINISTIC_VALIDATOR",
        // A CASE-scope finding names no document; everything narrower does.
        sourceDocumentId: f.scope === "CASE" ? null : doc.id,
        pageStart: f.pageStart ?? null,
        pageEnd: f.pageEnd ?? null,
        canonicalNoteId: row ? (noteOfRow.get(row.id) ?? null) : null,
        encounterId: row?.id ?? null,
        claimIndex: f.claimIndex ?? null,
        field: f.field ?? null,
        detail: f.detail,
        producerVersion: AUDIT_VERSION,
      });
    }
  }

  return {
    results,
    findings,
    evaluatedDocumentIds,
    evaluatedWholeCase: documents.length > 0 && evaluatedDocumentIds.length === documents.length,
    summary: {
      rows: results.length,
      documents: documents.length,
      documentsEvaluated: evaluatedDocumentIds.length,
      documentsSkipped: documents.length - evaluatedDocumentIds.length,
      emptyDocuments,
      changedResult,
      changedStatus,
      humanRowsUntouched,
      findingsDerived: findings.length,
    },
  };
}
