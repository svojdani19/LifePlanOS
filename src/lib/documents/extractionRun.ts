// ─────────────────────────────────────────────────────────────────────────────
// Extraction-run orchestrator: runs the source-grounded LLM pipeline for ONE
// document and persists the results with review lineage.
//
//   • OCR discipline: a document whose OCR is queued, in progress, or failed
//     NEVER reaches the model — the run is recorded as BLOCKED_OCR with an
//     actionable message.
//   • Fail closed: malformed output (after its one controlled retry) or a
//     provider/config problem produces an EXTRACTION_FAILED run — visible on
//     the Records page — never template prose.
//   • Human work is preserved: a regeneration supersedes prior AI_DRAFT rows
//     only. HUMAN_EDITED / REVIEWED / VERIFIED rows are kept; when the source
//     document's bytes changed they are marked STALE (with a new AI candidate
//     generated alongside for comparison); when unchanged, no duplicate
//     candidate is created for the encounters they already cover.
//   • Tenant safety: every row written carries the document's own firmId and
//     caseId — never values from the model.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { makeRecordStore, refreshCaseRecordsWithRecovery } from "@/lib/records/buildRecords";
import { CURRENT_OUTPUT_WHERE } from "@/lib/records/encounterLifecycle";
import { withDbRetry, createWithDbRetry } from "@/lib/dbRetry";
import { pageMarks } from "@/lib/documents/meta";
import { segmentEncounters } from "@/lib/engine/chronology";
import { MAX_TEXT } from "@/lib/documents/textLimits";
import { buildPageLedger, buildPendingPages, persistPageLedger, caseProcessingFacts } from "@/lib/documents/pageLedger";
import { claimRun, findIdempotentRun, finishRun, pauseRun, heartbeat, chunkBudget } from "@/lib/documents/runLifecycle";
import { inheritDatesWithinDocument } from "@/lib/documents/dateInheritance";
import { stripChartFurniture } from "@/lib/documents/chartStructure";
import {
  chunkDocumentText,
  extractChunkComplete,
  validateEncounters,
  consolidateEncounters,
  renderFactualSummary,
  synthesizeDocumentSummary,
  extractionProvenance,
  fingerprint,
  ExtractionOutputError,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type ValidatedEncounter,
  type ExtractOptions,
} from "@/lib/llm/recordExtraction";
import { fetchExemplarGuidance } from "@/lib/llm/correctionExemplars";
import { runCritic, adjudicateDisputes, applyAdjudications, isDisputing } from "@/lib/llm/extractionCritic";
import { auditFactualRecord, type AuditEncounter } from "@/lib/llm/factualAudit";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { classifyEncounterSubstance } from "@/lib/records/encounterSubstance";
import { corroborateRows } from "@/lib/records/corroboration";
import { AUDIT_VERSION } from "@/lib/records/reaudit";
import { LlmConfigError } from "@/lib/llm";

/**
 * The critic doubles the model calls per chunk. It is on by default because
 * the whole point of this pipeline is accuracy over cost, but a deployment
 * that needs the cheaper single pass can set RECORD_CRITIC=off.
 */
function criticEnabled(): boolean {
  return process.env.RECORD_CRITIC !== "off";
}

const OCR_PENDING = /OCR queued|OCR in progress/i;
const OCR_FAILED = /OCR failed/i;

export interface ExtractionRunResult {
  extractionId: string;
  status: "COMPLETE" | "EXTRACTION_FAILED" | "BLOCKED_OCR" | "PAUSED" | "BUSY";
  accepted: number;
  rejected: number;
  error?: string;
  /** The prior identical run was reused; no model calls were made. */
  idempotent?: boolean;
  /** Chunk index this run stopped at; a later invocation resumes there. */
  resumeFrom?: number;
}

const encounterKey = (e: { encounterDate: Date | null; provider: string | null; page: number | null }) =>
  `${e.encounterDate?.toISOString().slice(0, 10) ?? "undated"}|${(e.provider ?? "").toLowerCase().trim()}|${e.page ?? "?"}`;

export async function processDocumentExtraction(
  documentId: string,
  opts: ExtractOptions & {
    actorUserId?: string | null;
    force?: boolean;
    /**
     * Skip the case-wide records rebuild this run would otherwise trigger.
     *
     * Every completed document rebuilds the WHOLE case, which is right for a
     * single upload and quadratic for a bulk re-extraction: on a 23-document
     * case each two-page file took eighteen minutes, essentially all of it
     * re-composing the other twenty-two documents' notes. A caller
     * re-extracting many documents sets this and rebuilds ONCE at the end.
     * The derived records are stale until it does — so only a caller that
     * will actually perform that rebuild may pass it.
     */
    deferDerivedRefresh?: boolean;
  } = {},
): Promise<ExtractionRunResult> {
  const startedAt = new Date();
  // A read, and the one that actually failed in the field: nine documents
  // died here, before any work, when the pool refused connections.
  const doc = await withDbRetry(() => prisma.document.findUniqueOrThrow({ where: { id: documentId } }));
  const base = { firmId: doc.firmId, caseId: doc.caseId, sourceDocumentId: doc.id, createdById: opts.actorUserId ?? null };
  const prov = safeProvenance(opts);

  // Terminal runs that never held the lock (OCR gates, unreadable source) are
  // recorded whole: they start and finish in the same instant.
  const record = async (status: string, extra: Record<string, unknown>) =>
    createWithDbRetry(
      () =>
        prisma.recordExtraction.create({
          data: { ...base, status, provider: prov.provider, model: prov.model, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, startedAt, finishedAt: new Date(), ...extra },
        }),
      // `startedAt` is fixed for this invocation, so it identifies OUR row and
      // answers whether a lost acknowledgement hid a write that landed.
      () => prisma.recordExtraction.findFirst({ where: { sourceDocumentId: doc.id, startedAt } }),
    );

  // ── OCR discipline: incomplete or failed OCR never reaches the model ───────
  const flags = doc.flags ?? "";
  if (OCR_PENDING.test(flags)) {
    await persistPageLedger(buildPendingPages(doc, "PENDING_OCR")).catch(() => {});
    const run = await record("BLOCKED_OCR", { error: "OCR has not completed for this document; extraction will run once the text is readable." });
    return { extractionId: run.id, status: "BLOCKED_OCR", accepted: 0, rejected: 0, error: run.error ?? undefined };
  }
  if (OCR_FAILED.test(flags)) {
    await persistPageLedger(buildPendingPages(doc, "OCR_FAILED")).catch(() => {});
    const run = await record("BLOCKED_OCR", { error: "OCR failed for this document; re-run OCR or re-upload a readable copy before extraction." });
    return { extractionId: run.id, status: "BLOCKED_OCR", accepted: 0, rejected: 0, error: run.error ?? undefined };
  }

  const rawText = doc.extractedText ?? "";
  const text = stripChartFurniture(rawText);
  const sourceFingerprint = fingerprint(rawText);
  if (text.trim().length < 40) {
    const run = await record("EXTRACTION_FAILED", { sourceFingerprint, error: "No extractable text — the document appears illegible or empty; human review of the source file is required." });
    return { extractionId: run.id, status: "EXTRACTION_FAILED", accepted: 0, rejected: 0, error: run.error ?? undefined };
  }

  const marks = pageMarks(text);
  const { chunks } = chunkDocumentText(text, marks, {
    firmId: doc.firmId,
    caseId: doc.caseId,
    sourceDocumentId: doc.id,
    filename: doc.filename,
    ocrConfidence: doc.ocrConfidence ?? null,
    // What KIND of document this is — a deposition is not a clinic note, and
    // must not be asked for a treating provider or a visit date.
    documentType: doc.type,
  });
  // "Truncated" means one thing now: the source text itself arrived clipped at
  // the storage cap. There is no processing bound — every chunk of every
  // document is read, however large the record.
  const truncated = rawText.length >= MAX_TEXT;

  // ── Run lifecycle: idempotency, then the lock ─────────────────────────────
  const identity = {
    firmId: doc.firmId,
    caseId: doc.caseId,
    sourceDocumentId: doc.id,
    sourceFingerprint,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    provider: prov.provider,
    model: prov.model,
    createdById: opts.actorUserId ?? null,
  };
  if (!opts.force) {
    const prior = await findIdempotentRun(identity);
    if (prior) {
      // Same bytes, same prompt, same schema, same model — the answer would be
      // the same. Re-running would only burn tokens and churn draft rows.
      return { extractionId: prior.id, status: "COMPLETE", accepted: prior.acceptedCount, rejected: 0, idempotent: true };
    }
  }
  const claim = await claimRun(identity);
  if (claim.kind === "BUSY") {
    // Another worker owns this document. Two runs writing drafts for the same
    // document is how duplicate encounters get created; refusing is the point.
    return {
      extractionId: claim.runId ?? "",
      status: "BUSY",
      accepted: 0,
      rejected: 0,
      error: "An extraction run is already in progress for this document; it will finish or be retried automatically.",
    };
  }
  if (claim.kind === "IDEMPOTENT") {
    return { extractionId: claim.runId, status: "COMPLETE", accepted: claim.accepted, rejected: 0, idempotent: true };
  }
  const runId = claim.runId;
  const startIndex = claim.startIndex;
  const budget = chunkBudget();
  const endIndex = budget ? Math.min(chunks.length, startIndex + budget) : chunks.length;
  const paused = endIndex < chunks.length;

  const fail = async (error: string, extra: Record<string, unknown> = {}) => {
    await finishRun(runId, "EXTRACTION_FAILED", { sourceFingerprint, truncated, chunkCount: chunks.length, chunksTotal: chunks.length, error, ...extra }, startedAt);
    return { extractionId: runId, status: "EXTRACTION_FAILED" as const, accepted: 0, rejected: 0, error };
  };

  const exemplarGuidance = opts.exemplarGuidance ?? (await fetchExemplarGuidance(doc.firmId, doc.type).catch(() => []));

  // ── Extract → critique → adjudicate → validate, chunk by chunk ─────────────
  // The critic reads the SOURCE, not the first pass's answer, so it can see
  // what the extractor never noticed. Anything it disputes is either settled
  // by an adjudicator against the source or left unresolved — and unresolved
  // means the audit refuses to call the result complete, rather than the
  // pipeline quietly picking a side.
  //
  // Fault containment: on a large record, one chunk's transient failure must
  // not discard hundreds of good chunks. Provider errors retry with backoff;
  // a chunk that still fails is recorded as an UNPROCESSED SECTION with its
  // page range — disclosed, counted, and fatal to the audit's notion of
  // completeness, but never fatal to the rest of the document. Only a
  // configuration error (no provider) or every chunk failing fails the run.
  type ChunkResult = {
    accepted: ValidatedEncounter[];
    rejected: string[];
    critic: string[];
    candidates: number;
    disputed: number;
    adjudicated: number;
    unresolved: number;
    /** Unresolved disputes attributed to accepted encounters, in their order. */
    unresolvedPerAccepted: number[];
    /** Unresolved disputes naming no entry, so they cannot be pinned to one. */
    unresolvedUnattributed: number;
    /** Entry fields the source contradicts, aligned to accepted entries. */
    contradictedPerAccepted: string[][];
    /** Critic omissions: encounters it says the extraction missed. */
    omissions: number;
    /** Critic findings that the note boundaries could not be determined. */
    unclearBoundaries: number;
  };
  const results: (ChunkResult | { failed: string; failedRange?: { pageStart: number | null; pageEnd: number | null; reason: string } })[] = new Array(chunks.length);

  const TRANSIENT_RE = /overloaded|rate.?limit|429|5\d\d|timeout|timed out|ECONN|EPIPE|ENOTFOUND|fetch failed|socket|network/i;
  const backoffs = [2_000, 8_000, 20_000];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Overflow accounting: how many server-chosen subdivisions ran, and which
  // pages still overflowed after the depth bound. Declared BEFORE processChunk,
  // which closes over them and RUNS before the block where they used to live —
  // a `let` in its temporal dead zone made exactly the dense chunks that
  // subdivide crash with a ReferenceError, while every ordinary chunk passed.
  // The unit tests called extractChunkComplete directly and never this path,
  // which is why 2,174 green tests proved nothing about it.
  let telemetrySubdivisions = 0;
  const unresolvedOverflowPages: number[] = [];

  const processChunk = async (chunk: (typeof chunks)[number]): Promise<ChunkResult> => {
    // Complete extraction: an overflowing range is subdivided at page
    // boundaries the server chose, and only a single page that STILL overflows
    // comes back unresolved — recorded, and fatal to a "complete" audit.
    const extraction = await extractChunkComplete(chunk, { provider: opts.provider, exemplarGuidance });
    let encounters = extraction.encounters;
    if (extraction.subdivisions) telemetrySubdivisions += extraction.subdivisions;
    if (extraction.unresolvedPages.length) {
      unresolvedOverflowPages.push(...extraction.unresolvedPages);
    }
    const candidates = encounters.reduce((s: number, e: { claims: unknown[] }) => s + e.claims.length, 0);
    const rejected: string[] = [];
    // A page kept by dropping an unparseable claim says so. Salvage that is
    // not disclosed is indistinguishable from a page that had nothing wrong.
    if (extraction.salvage?.length) rejected.push(...extraction.salvage);
    const critic: string[] = [];
    let disputed = 0;
    let adjudicated = 0;
    let unresolved = 0;
    let unresolvedUnattributed = 0;
    let unresolvedByEncounter = new Map<number, number>();
    let contradictedByEncounter = new Map<number, string[]>();
    let omissions = 0;
    let unclearBoundaries = 0;
    if (criticEnabled() && encounters.length) {
      const critique = await runCritic(chunk, encounters, { provider: opts.provider });
      rejected.push(...critique.rejected);
      for (const issue of critique.issues) {
        // Omissions and boundary problems cannot be auto-corrected without
        // inventing content — but they are evidence the record in hand is
        // incomplete, so they are COUNTED into the audit, not merely logged.
        // Collected and then read by nothing was the earlier failure: the
        // critic could name an encounter the extraction missed while every
        // row still passed.
        critic.push(`${issue.type}: ${issue.detail}`);
        if (issue.type === "MISSING_ENCOUNTER") omissions++;
        if (issue.type === "UNCLEAR_SOURCE_BOUNDARY") unclearBoundaries++;
      }
      const disputes = critique.issues.filter(isDisputing);
      disputed = disputes.length;
      if (disputes.length) {
        const rulings = await adjudicateDisputes(chunk, encounters, disputes, { provider: opts.provider });
        const applied = applyAdjudications(encounters, rulings);
        encounters = applied.encounters;
        adjudicated = rulings.filter((r) => r.ruling !== "UNRESOLVED").length;
        unresolved = applied.unresolved;
        unresolvedUnattributed = applied.unresolvedUnattributed;
        unresolvedByEncounter = applied.unresolvedByEncounter;
        contradictedByEncounter = applied.contradictedFieldsByEncounter;
        rejected.push(...applied.notes);
      }
    }
    const outcome = validateEncounters(chunk, encounters);
    rejected.push(...outcome.rejected);
    // Follow each unresolved dispute to the entry it is about. Validation
    // drops entries, so the pre-validation index only survives via
    // sourceIndex — without it a dispute would land on whichever entry
    // happened to take the vacated position.
    const unresolvedPerAccepted = outcome.accepted.map((e) =>
      e.sourceIndex != null ? (unresolvedByEncounter.get(e.sourceIndex) ?? 0) : 0,
    );
    const contradictedPerAccepted = outcome.accepted.map((e) =>
      e.sourceIndex != null ? (contradictedByEncounter.get(e.sourceIndex) ?? []) : [],
    );
    return {
      accepted: outcome.accepted, rejected, critic, candidates, disputed, adjudicated, unresolved,
      unresolvedPerAccepted, unresolvedUnattributed, contradictedPerAccepted, omissions, unclearBoundaries,
    };
  };

  const concurrency = Math.max(1, Math.min(8, Number(process.env.RECORD_CHUNK_CONCURRENCY) || 3));
  let configError: LlmConfigError | ExtractionOutputError | null = null;
  let cursor = startIndex;
  let completedChunks = 0;
  let retries = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= endIndex || configError) return;
      const chunk = chunks[i];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        try {
          results[i] = await processChunk(chunk);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // A configuration problem affects every chunk equally — stop the run
          // rather than failing 300 sections one by one.
          if (err instanceof LlmConfigError) {
            configError = err;
            return;
          }
          const transient = TRANSIENT_RE.test(err instanceof Error ? err.message : String(err));
          if (!transient || attempt === backoffs.length) break;
          retries++;
          await sleep(backoffs[attempt]);
        }
      }
      // Keep the lock warm and the progress cursor durable: a long record is
      // exactly the case where a run must not look like a crash.
      completedChunks++;
      if (completedChunks % 10 === 0) await heartbeat(runId, startIndex + completedChunks);
      if (lastErr) {
        const pages = chunk.pageStart != null ? `pages ${chunk.pageStart}–${chunk.pageEnd ?? chunk.pageStart}` : `section ${i + 1}`;
        const reason = lastErr instanceof ExtractionOutputError ? lastErr.message.slice(0, 120) : "provider unavailable after retries";
        results[i] = {
          failed: `Content covering ${pages} could not be processed (${reason}); it is not represented in this draft.`,
          failedRange: { pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, reason },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, endIndex - startIndex)) }, worker));

  if (configError) return fail((configError as Error).message);

  const warningsSeed: string[] = [];
  const validated: ValidatedEncounter[] = [];
  const rejects: string[] = [];
  const criticFindings: string[] = [];
  const failedSections: string[] = [];
  let candidateCount = 0;
  let disputedCount = 0;
  let adjudicatedCount = 0;
  let unresolvedDisputes = 0;
  let unattributedDisputes = 0;
  /** Aligned to `validated`: unresolved disputes about each accepted entry. */
  const unresolvedPerValidated: number[] = [];
  /** Aligned to `validated`: entry fields the source contradicts. */
  const contradictedPerValidated: string[][] = [];
  let criticOmissions = 0;
  let unclearBoundaries = 0;
  const failedRanges: { pageStart: number | null; pageEnd: number | null; reason: string }[] = [];
  for (const r of results) {
    if (!r) continue;
    if ("failed" in r) {
      failedSections.push(r.failed);
      if (r.failedRange) failedRanges.push(r.failedRange);
      continue;
    }
    validated.push(...r.accepted);
    unresolvedPerValidated.push(...r.unresolvedPerAccepted);
    contradictedPerValidated.push(...r.contradictedPerAccepted);
    criticOmissions += r.omissions;
    unclearBoundaries += r.unclearBoundaries;
    rejects.push(...r.rejected);
    criticFindings.push(...r.critic);
    candidateCount += r.candidates;
    disputedCount += r.disputed;
    adjudicatedCount += r.adjudicated;
    unresolvedDisputes += r.unresolved;
    unattributedDisputes += r.unresolvedUnattributed;
  }

  // Every chunk failing is a document-level failure, not a partial result.
  if (failedSections.length === endIndex - startIndex && !paused && startIndex === 0) {
    const message = "No section of this document could be processed; the document is queued for human review.";
    const res = await fail(message, { warnings: failedSections.slice(0, 40) as never });
    return { ...res, rejected: rejects.length };
  }

  // ── Recall cross-check ─────────────────────────────────────────────────────
  // The deterministic segmenter finds dated note-headers with no model
  // involved. Any header date for which extraction produced NO encounter is a
  // silent recall gap made loud: two independent methods disagreeing about
  // what the document contains is a review item, never a shrug. (This is the
  // critic pattern applied to omissions.)
  // The check is CLASS-SPECIFIC. Dated visit headers are the right recall
  // expectation for a chart; they are meaningless for a deposition, which has
  // one date and no visits, and demanding them there produced a stream of
  // "missing clinical encounter date" findings on documents that are not
  // clinical charts at all.
  const coverageGaps: string[] = [];
  try {
    const classes = new Set(chunks.slice(startIndex, endIndex).map((c) => c.analysisClass ?? "UNKNOWN"));
    const datedVisitClasses = ["CLINICAL_ENCOUNTER", "THERAPY_COURSE"];
    const expectsDatedVisits = datedVisitClasses.some((k) => classes.has(k as never));

    if (expectsDatedVisits) {
      const headerDates = new Set(segmentEncounters(text, marks).map((s) => s.dateIso).filter(Boolean));
      const extractedDates = new Set(validated.filter((v) => v.encounterDate).map((v) => v.encounterDate!.toISOString().slice(0, 10)));
      for (const d of [...headerDates].sort()) {
        if (!extractedDates.has(d)) {
          coverageGaps.push(`Coverage check: a dated note header for ${d} appears in this document, but no encounter was extracted for that date; human review required.`);
        }
      }
    }
    // Every other kind gets the recall question its own kind poses.
    if (classes.has("UNKNOWN" as never)) {
      coverageGaps.push(
        "Coverage check: part of this document could not be identified as any known kind of record. It is retained and visible for review, but no claim is made that it was completely extracted, and it does not enter the medical chronology.",
      );
    }
    for (const [klass, expectation] of [
      ["OPERATIVE", "each operation documented in it"],
      ["PATHOLOGY_DIAGNOSTIC", "each specimen accession"],
      ["DIAGNOSTIC_STUDY", "each study reported in it"],
      ["TESTIMONY", "the substantive testimony it contains"],
      ["EXPERT_OPINION", "each stated opinion"],
      ["INCIDENT", "the incident narrative and the statements it reports"],
      ["FINANCIAL", "the charge lines it contains"],
      ["LEGAL", "the assertions and relief it states"],
    ] as const) {
      if (classes.has(klass as never) && !validated.some((v) => v.analysisClass === klass)) {
        coverageGaps.push(`Coverage check: this document contains ${klass.toLowerCase().replace(/_/g, " ")} material, but nothing was extracted from it; ${expectation} requires human review.`);
      }
    }
  } catch {
    /* the cross-check is an auditor; its failure never blocks extraction */
  }

  // Pin each unresolved dispute to the entry it is about before consolidation
  // merges entries (which sums the counts). Document-wide counting is what put
  // whole productions into source conflict over one contested claim.
  validated.forEach((e, i) => {
    e.unresolvedDisputes = unresolvedPerValidated[i] ?? 0;
    e.contradictedFields = contradictedPerValidated[i] ?? [];
  });

  const consolidated = consolidateEncounters(validated);

  // ── Place undated entries within their OWN document ───────────────────────
  // A service-date header dates a whole note, not just the page it sits on.
  // An entry from a later page of that note is not a loose, undated record —
  // it belongs to a dated section already in evidence, and the document itself
  // says which. Inheritance is INFERRED and carries its basis; it never
  // crosses a document, and anything the document cannot place stays UNKNOWN.
  const datedSections = (() => {
    try {
      // The segmenter reports where each dated section STARTS. A section runs
      // until the next one begins, and that extent is what lets an undated
      // page be attributed to the note it belongs to.
      const anchors = segmentEncounters(text, marks)
        .filter((sec) => sec.dateIso && sec.page != null)
        .map((sec) => ({ date: sec.dateIso as string, page: sec.page as number }))
        .sort((a, b) => a.page - b.page);
      return anchors.map((a, i) => ({
        date: a.date,
        pageStart: a.page,
        pageEnd: i + 1 < anchors.length ? Math.max(a.page, anchors[i + 1].page - 1) : null,
      }));
    } catch {
      return [];
    }
  })();
  const inherited = inheritDatesWithinDocument(consolidated, datedSections);
  const encounters = inherited.entries;
  if (inherited.placed > 0) {
    warningsSeed.push(
      `${inherited.placed} entr${inherited.placed === 1 ? "y" : "ies"} carried no date of their own and were placed by the dated content of this same document; each is marked inferred and names what it was placed by.`,
    );
  }

  const { synthesis, warning: synthesisWarning } = await synthesizeDocumentSummary(encounters, { provider: opts.provider });

  const warnings = [
    ...warningsSeed,
    ...(truncated ? ["The source text was clipped at the storage cap during ingestion; content beyond it is not represented and requires human review."] : []),
    ...failedSections,
    ...coverageGaps,
    ...(synthesisWarning ? [synthesisWarning] : []),
    ...(unresolvedOverflowPages.length
      ? [
          `extraction overflow unresolved on page(s) ${[...new Set(unresolvedOverflowPages)].sort((a, b) => a - b).join(", ")}: the range yielded more than one bounded response can carry even after subdivision; content beyond the cap is not represented and requires human review`,
        ]
      : []),
    ...rejects.slice(0, 40),
  ];

  // ── Page-coverage ledger ──────────────────────────────────────────────────
  // The proof behind "every page was processed": one durable row per page,
  // written idempotently, with failed chunk ranges mapped onto the pages they
  // cover. The audit consumes these persisted facts — completeness is derived,
  // never assumed.
  //
  // A paused run accounts only for the pages it actually reached: the pages
  // beyond its budget get no row at all, because "no row yet" is the truthful
  // record and the resumed run fills them in.
  const coveredPages = paused || startIndex > 0 ? new Set<number>() : null;
  if (coveredPages) {
    for (let i = startIndex; i < endIndex; i++) {
      const c = chunks[i];
      if (c.pageStart == null) continue;
      for (let p = c.pageStart; p <= (c.pageEnd ?? c.pageStart); p++) coveredPages.add(p);
    }
  }
  const pageRows = buildPageLedger({ doc, text, marks, failedRanges, sourceClipped: truncated, coveredPages });
  // A page whose extraction overflowed unresolved is a page whose content is
  // not fully represented — exactly what TRUNCATED means to the gate.
  for (const row of pageRows) {
    if (unresolvedOverflowPages.includes(row.pageNumber) && row.status === "READABLE") {
      row.status = "TRUNCATED" as typeof row.status;
    }
  }
  await persistPageLedger(pageRows).catch((e) => {
    // Ledger persistence failing must not lose the extraction, but it MUST be
    // visible: without the ledger the audit cannot call this complete.
    warnings.push(`Page-coverage ledger could not be persisted (${e instanceof Error ? e.message.slice(0, 80) : "error"}); page accounting is incomplete.`);
  });
  // This document's own run has not been written as COMPLETE yet, so the facts
  // query is told the outcome it is about to persist. Every OTHER document is
  // read from what is actually stored.
  const facts = await caseProcessingFacts(doc.caseId, doc.firmId, { documentId: doc.id, processed: !paused }).catch(() => ({
    allDocumentsProcessed: false,
    failedExtractions: 0,
  }));
  const auditEncounters: AuditEncounter[] = encounters.map((e, i) => ({
    id: `pending-${i}`,
    sourceDocumentId: doc.id,
    dateStatus: e.dateStatus,
    encounterDate: e.encounterDate?.toISOString().slice(0, 10) ?? null,
    provider: e.provider,
    encounterType: e.encounterType,
    factualSummary: renderFactualSummary(e),
    synthesis: null,
    sentenceClaimMap: null,
    claims: e.claims.map((c, j) => ({ id: `c${j}`, field: c.field, claimType: c.claimType, value: c.value, excerpt: c.excerpt, page: c.page, warning: c.warning })),
    page: e.page,
    status: "AI_DRAFT",
    unresolvedDisputes: e.unresolvedDisputes ?? 0,
    contradictedFields: e.contradictedFields ?? [],
  }));
  const audit = auditFactualRecord({
    encounters: auditEncounters,
    pages: pageRows.map((p) => ({ pageNumber: p.pageNumber, status: p.status, ocrConfidence: p.ocrConfidence })),
    failedExtractions: facts.failedExtractions,
    failedSections: failedSections.length,
    coverageGaps: coverageGaps.length,
    truncatedSource: truncated,
    // Only the disputes that name no entry are document-level; the rest travel
    // on the entries they are about.
    unresolvedDisputes: unattributedDisputes,
    criticOmissions,
    unclearBoundaries,
    allDocumentsProcessed: facts.allDocumentsProcessed,
    // This document's own completeness, which DOES bear on its entries.
    thisDocumentIncomplete: paused,
  });

  // ── Persist with review lineage ────────────────────────────────────────────
  const prior = await withDbRetry(() =>
    prisma.extractedEncounter.findMany({ where: { caseId: doc.caseId, sourceDocumentId: doc.id, ...CURRENT_OUTPUT_WHERE } }),
  );
  const priorHuman = prior.filter((p) => ["HUMAN_EDITED", "REVIEWED", "VERIFIED", "STALE"].includes(p.status));
  // Machine-produced drafts — including ones that passed the audit — may be
  // superseded by a newer run. Passing an audit is not human work and earns no
  // protection from regeneration. Drafts belonging to THIS run are the earlier
  // instalments of a resumed run, not stale output, and are left alone.
  const priorDrafts = prior.filter((p) => ["AI_DRAFT", "AI_AUDIT_PASSED", "EXTRACTION_FAILED"].includes(p.status) && p.extractionId !== runId);
  const sameRunKeys = new Set(
    prior
      .filter((p) => p.extractionId === runId)
      .map((p) => encounterKey({ encounterDate: p.encounterDate, provider: p.provider, page: p.page })),
  );

  // Source changed → reviewed content goes STALE (never silently re-verified).
  for (const h of priorHuman) {
    if (h.status !== "STALE" && h.sourceFingerprint && h.sourceFingerprint !== sourceFingerprint) {
      await withDbRetry(() =>
        prisma.extractedEncounter.update({
          where: { id: h.id },
          data: { status: "STALE", staleReason: "Source document content changed after this encounter was reviewed; re-review required." },
        }),
      );
    }
  }
  const humanKeys = new Set(
    priorHuman
      .filter((h) => h.status !== "STALE" && (!h.sourceFingerprint || h.sourceFingerprint === sourceFingerprint))
      .map((h) => encounterKey({ encounterDate: h.encounterDate, provider: h.provider, page: h.page })),
  );

  const created: string[] = [];
  const createdDates = new Set<string>();
  for (const [encIndex, e] of encounters.entries()) {
    // A current (non-stale) human row already covers this encounter — do not
    // create a duplicate AI candidate beside preserved human work.
    const key = encounterKey({ encounterDate: e.encounterDate, provider: e.provider, page: e.page });
    if (humanKeys.has(key)) continue;
    // An earlier instalment of this same (resumed) run already wrote it.
    if (sameRunKeys.has(key)) continue;
    const summaryText = renderFactualSummary(e);
    const row = await createWithDbRetry(
      () =>
        prisma.extractedEncounter.create({
          data: {
            extractionId: runId,
            firmId: doc.firmId, // server-controlled — never from the model
            caseId: doc.caseId,
            sourceDocumentId: doc.id,
            page: e.page,
            pageEnd: e.pageEnd,
            dateStatus: e.dateStatus,
            encounterDate: e.encounterDate,
            encounterDateEnd: e.encounterDateEnd,
            provider: e.provider,
            providerCredentials: e.providerCredentials,
            facility: e.facility,
            encounterType: e.encounterType,
            // Document-kind provenance travels with the row, so chronology
            // admission and report rendering never have to guess from field names.
            analysisClass: e.analysisClass,
            segmentKey: e.segmentKey,
            classificationMethod: e.classificationMethod,
            classificationConfidence: e.classificationConfidence,
            attributionName: e.attributionName,
            attributionRole: e.attributionRole,
            factualSummary: summaryText,
            synthesis: encounters.length === 1 ? synthesis : null,
            claims: e.claims as never,
            ocrConfidence: e.ocrConfidence,
            warnings: e.warnings as never,
            // Substance class: paperwork and supporting logs stay off the
            // chronology, with the reason recorded for the reviewer.
            ...(() => {
              const verdict = classifyEncounterSubstance({ analysisClass: e.analysisClass, encounterType: e.encounterType, factualSummary: summaryText, claims: e.claims });
              return { substanceClass: verdict.class, substanceReason: verdict.reason };
            })(),
            // A draft that survived the audit is marked as such; anything else
            // stays a plain AI_DRAFT and carries the reasons. Neither is verified —
            // an audit says the system found nothing wrong, which is not the same
            // as a human agreeing the record is right.
            // The audit result for THIS entry: every document-level defect it
            // inherits, plus what it raised itself — but not a conflict that
            // belongs to a different entry.
            status: (audit.perEncounter[encIndex] ?? audit.result) === "PASS" ? "AI_AUDIT_PASSED" : "AI_DRAFT",
            auditResult: audit.perEncounter[encIndex] ?? audit.result,
            auditVersion: AUDIT_VERSION,
            // Persisted so a later deterministic re-audit sees the same
            // disagreement this run saw, instead of clearing it silently.
            unresolvedDisputes: e.unresolvedDisputes ?? 0,
            contradictedFields: (e.contradictedFields ?? []) as never,
            auditFindings: audit.findings.slice(0, 20) as never,
            auditedAt: new Date(),
            sourceFingerprint,
            promptVersion: PROMPT_VERSION,
            schemaVersion: SCHEMA_VERSION,
            model: prov.model,
          },
        }),
      // Identity of THIS row within THIS run: if the insert landed and the
      // acknowledgement was lost, the probe finds it instead of writing a twin.
      () =>
        prisma.extractedEncounter.findFirst({
          where: { extractionId: runId, sourceDocumentId: doc.id, page: e.page, factualSummary: summaryText },
        }),
    );

    created.push(row.id);
    // The dates this generation actually produced, collected as the rows are
    // written. Asking the database back for rows we just created was an extra
    // round-trip whose only purpose was to learn what this loop already knew.
    const createdDay = e.encounterDate?.toISOString().slice(0, 10);
    if (createdDay) createdDates.add(createdDay);
  }
  // Prior drafts are superseded by this run (pointing at the run's first row
  // when one exists — enough to walk the lineage).
  if (priorDrafts.length) {
    // Re-extraction is not deterministic. Measured on a real case, a re-run
    // recovered one date and LOST another the previous generation had — and a
    // supersede-everything policy turns that variance into silent erasure of
    // care from the chronology. A prior machine row whose date the new
    // generation failed to reproduce is therefore kept as a GENERATION_LOSS
    // candidate: stored with its lineage and a reason, surfaced for review,
    // and EXCLUDED from records until a human confirms it. The first version
    // marked these STALE, which is an active state — so a fact the current
    // extraction could not reproduce flowed straight back into the chronology
    // as an ordinary draft, on no authority but an earlier model's. A failed
    // row is never retained: it was not trustworthy in its own generation
    // either.
    const newDates = createdDates;
    const lost = priorDrafts.filter((p) => {
      if (p.status === "EXTRACTION_FAILED") return false;
      const day = p.encounterDate?.toISOString().slice(0, 10);
      return Boolean(day) && !newDates.has(day as string);
    });
    const lostIds = new Set(lost.map((l) => l.id));
    if (lost.length) {
      const lostDates = [...new Set(lost.map((l) => l.encounterDate!.toISOString().slice(0, 10)))].sort();
      warnings.push(
        `generation loss: this extraction produced no rows dated ${lostDates.join(", ")}; the prior generation's ${lost.length} row(s) were kept as generation-loss candidates — excluded from records until a reviewer confirms or restores them`,
      );
      await withDbRetry(() =>
        prisma.extractedEncounter.updateMany({
          where: { id: { in: [...lostIds] } },
          data: {
            status: "GENERATION_LOSS",
            staleReason: `Prior machine result not reproduced by extraction run ${runId}; excluded from records until a reviewer confirms or restores it.`,
          },
        }),
      );
    }
    const superseded = priorDrafts.filter((p) => !lostIds.has(p.id));
    if (superseded.length) {
      await withDbRetry(() =>
        prisma.extractedEncounter.updateMany({
          where: { id: { in: superseded.map((p) => p.id) } },
          data: { status: "SUPERSEDED", supersededById: created[0] ?? null },
        }),
      );
    }
  }

  // ── Machine corroboration ─────────────────────────────────────────────────
  // Rows that are clean on every server-side check get one independent blind
  // read of their source span; reproduced facts are recorded as a quality
  // tier. Never a verification, never a promotion — a corroborated row still
  // waits for a human, it just waits in a quieter queue. Failures record
  // nothing. RECORD_CORROBORATION=off skips the pass entirely.
  if (process.env.RECORD_CORROBORATION !== "off" && created.length) {
    try {
      const freshRows = await prisma.extractedEncounter.findMany({
        where: { id: { in: created }, status: "AI_AUDIT_PASSED" },
        select: { id: true, status: true, dateStatus: true, page: true, pageEnd: true, warnings: true, claims: true },
      });
      const outcome = await corroborateRows(freshRows, text, { model: prov.model, sourceFingerprint });
      for (const [rowId, verdict] of outcome.verdicts) {
        await withDbRetry(() => prisma.extractedEncounter.update({ where: { id: rowId }, data: { corroboration: verdict as never } }));
      }
      if (outcome.asked) {
        warnings.push(`machine corroboration: ${outcome.candidates} candidate(s), ${outcome.corroborated} corroborated by an independent re-read, ${outcome.failed} read(s) failed`);
      }
    } catch (error) {
      // Corroboration is additive evidence; its failure must never fail a run.
      warnings.push(`machine corroboration skipped: ${String(error).slice(0, 120)}`);
    }
  }

  // ── Close the run ─────────────────────────────────────────────────────────
  // The run reaches its terminal state only after its output is persisted, so
  // a crash mid-write leaves an unfinished run — recoverable — rather than a
  // COMPLETE run missing half its encounters.
  const runData = {
    sourceFingerprint,
    truncated,
    chunkCount: chunks.length,
    chunksTotal: chunks.length,
    chunksDone: endIndex,
    coverageGaps: coverageGaps.length,
    candidateCount,
    acceptedCount: encounters.reduce((s, e) => s + e.claims.length, 0),
    rejectedCount: rejects.length,
    warnings: warnings as never,
    criticFindings: criticFindings.slice(0, 40) as never,
    disputedCount,
    adjudicatedCount,
    pagesTotal: pageRows.length,
    pagesReadable: pageRows.filter((p) => p.status === "READABLE").length,
    auditResult: audit.result,
    // Operational counters only — chunk positions and call counts, never
    // record content.
    telemetry: {
      chunksProcessed: endIndex - startIndex,
      retries,
      failedChunks: failedSections.length,
      subdivisions: telemetrySubdivisions,
      overflowPages: unresolvedOverflowPages.length,
      concurrency,
      criticEnabled: criticEnabled(),
      elapsedMs: Date.now() - startedAt.getTime(),
    } as never,
  };

  if (paused) {
    await pauseRun(runId, endIndex, runData);
    return { extractionId: runId, status: "PAUSED", accepted: encounters.length, rejected: rejects.length, resumeFrom: endIndex };
  }
  await finishRun(runId, "COMPLETE", runData, startedAt);

  // The Records page and the chronology are rebuilt from everything now
  // extracted for the case, through the same service the manual rebuild uses.
  // A case that was uploaded and the same case rebuilt by hand must be
  // described identically; they were not, and every fix to one missed the
  // other. Failure here is reported and does not fail the run: the extraction
  // output is already safely persisted, and the previous records survive.
  // A bulk re-extraction rebuilds ONCE at the end instead of after every
  // document. The rebuild covers the whole case, so doing it per document is
  // quadratic: on this 23-document case a two-page file took eighteen
  // minutes, nearly all of it re-composing the other twenty-two documents.
  if (opts.deferDerivedRefresh) {
    console.log(`[extraction] derived rebuild deferred to the caller for case ${doc.caseId}`);
  } else {
    try {
      // Coalesced and self-recovering: a stale refusal retries from the newest
      // state (bounded), and completions arriving mid-build fold into one
      // follow-up rather than stacking.
      const refreshed = await refreshCaseRecordsWithRecovery(makeRecordStore(prisma as never), doc.caseId);
      if (!refreshed.published && !refreshed.coalesced) {
        console.error(`[extraction] records not republished for case ${doc.caseId}: ${refreshed.history.at(-1)?.reason ?? refreshed.status}`);
      }
    } catch (error) {
      console.error(`[extraction] records refresh failed for case ${doc.caseId}: ${String(error).slice(0, 200)}`);
    }
  }

  return { extractionId: runId, status: "COMPLETE", accepted: encounters.length, rejected: rejects.length };
}

function safeProvenance(opts: ExtractOptions): { provider: string; model: string | null } {
  try {
    const p = extractionProvenance(opts.provider);
    return { provider: p.provider, model: p.model };
  } catch {
    return { provider: "unconfigured", model: null };
  }
}

/**
 * Fire-and-forget hook for ingest/OCR completion. Never throws — a failure is
 * recorded as an extraction run the Records page surfaces for review.
 */
export function enqueueExtraction(documentId: string, actorUserId?: string | null): void {
  void processDocumentExtraction(documentId, { actorUserId }).catch((e) => {
    console.error(`[extraction] ${documentId} failed to record a run:`, e instanceof Error ? e.message : e);
  });
}
