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
import { pageMarks } from "@/lib/documents/meta";
import { stripChartFurniture } from "@/lib/documents/chartStructure";
import {
  chunkDocumentText,
  extractEncountersFromChunk,
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
  status: "COMPLETE" | "EXTRACTION_FAILED" | "BLOCKED_OCR";
  accepted: number;
  rejected: number;
  error?: string;
}

const encounterKey = (e: { encounterDate: Date | null; provider: string | null; page: number | null }) =>
  `${e.encounterDate?.toISOString().slice(0, 10) ?? "undated"}|${(e.provider ?? "").toLowerCase().trim()}|${e.page ?? "?"}`;

export async function processDocumentExtraction(documentId: string, opts: ExtractOptions & { actorUserId?: string | null } = {}): Promise<ExtractionRunResult> {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const base = { firmId: doc.firmId, caseId: doc.caseId, sourceDocumentId: doc.id, createdById: opts.actorUserId ?? null };
  const prov = safeProvenance(opts);

  const record = async (status: string, extra: Record<string, unknown>) =>
    prisma.recordExtraction.create({ data: { ...base, status, provider: prov.provider, model: prov.model, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, ...extra } });

  // ── OCR discipline: incomplete or failed OCR never reaches the model ───────
  const flags = doc.flags ?? "";
  if (OCR_PENDING.test(flags)) {
    const run = await record("BLOCKED_OCR", { error: "OCR has not completed for this document; extraction will run once the text is readable." });
    return { extractionId: run.id, status: "BLOCKED_OCR", accepted: 0, rejected: 0, error: run.error ?? undefined };
  }
  if (OCR_FAILED.test(flags)) {
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
  const { chunks, truncated } = chunkDocumentText(text, marks, {
    firmId: doc.firmId,
    caseId: doc.caseId,
    sourceDocumentId: doc.id,
    filename: doc.filename,
    ocrConfidence: doc.ocrConfidence ?? null,
  });

  const exemplarGuidance = opts.exemplarGuidance ?? (await fetchExemplarGuidance(doc.firmId, doc.type).catch(() => []));

  // ── Extract → critique → adjudicate → validate, chunk by chunk ─────────────
  // The critic reads the SOURCE, not the first pass's answer, so it can see
  // what the extractor never noticed. Anything it disputes is either settled
  // by an adjudicator against the source or left unresolved — and unresolved
  // means the audit refuses to call the result complete, rather than the
  // pipeline quietly picking a side.
  const validated: ValidatedEncounter[] = [];
  const rejects: string[] = [];
  const criticFindings: string[] = [];
  let candidateCount = 0;
  let disputedCount = 0;
  let adjudicatedCount = 0;
  let unresolvedDisputes = 0;
  try {
    for (const chunk of chunks) {
      let encounters = await extractEncountersFromChunk(chunk, { provider: opts.provider, exemplarGuidance });
      candidateCount += encounters.reduce((s, e) => s + e.claims.length, 0);

      if (criticEnabled() && encounters.length) {
        const critique = await runCritic(chunk, encounters, { provider: opts.provider });
        rejects.push(...critique.rejected);
        for (const issue of critique.issues) {
          // Omissions and boundary problems are reported for human attention;
          // they cannot be auto-corrected without inventing content.
          criticFindings.push(`${issue.type}: ${issue.detail}`);
        }
        const disputes = critique.issues.filter(isDisputing);
        disputedCount += disputes.length;
        if (disputes.length) {
          const rulings = await adjudicateDisputes(chunk, encounters, disputes, { provider: opts.provider });
          const applied = applyAdjudications(encounters, rulings);
          encounters = applied.encounters;
          adjudicatedCount += rulings.filter((r) => r.ruling !== "UNRESOLVED").length;
          unresolvedDisputes += applied.unresolved;
          rejects.push(...applied.notes);
        }
      }

      const outcome = validateEncounters(chunk, encounters);
      validated.push(...outcome.accepted);
      rejects.push(...outcome.rejected);
    }
  } catch (err) {
    const message =
      err instanceof ExtractionOutputError || err instanceof LlmConfigError
        ? err.message
        : "Extraction failed unexpectedly; the document is queued for human review.";
    const run = await record("EXTRACTION_FAILED", {
      sourceFingerprint,
      truncated,
      chunkCount: chunks.length,
      candidateCount,
      rejectedCount: rejects.length,
      warnings: rejects.slice(0, 40) as never,
      error: message,
    });
    return { extractionId: run.id, status: "EXTRACTION_FAILED", accepted: 0, rejected: rejects.length, error: message };
  }

  const encounters = consolidateEncounters(validated);
  const { synthesis, warning: synthesisWarning } = await synthesizeDocumentSummary(encounters, { provider: opts.provider });

  const warnings = [
    ...(truncated ? [`Document exceeds the processing bound — only the first ${chunks.length} sections were processed; the remainder requires human review.`] : []),
    ...(synthesisWarning ? [synthesisWarning] : []),
    ...rejects.slice(0, 40),
  ];

  // ── Adversarial audit over the finished draft ─────────────────────────────
  // Page state is what makes "complete" meaningful: a chronology built from
  // the pages that happened to read is not the record. Documents ingested
  // before per-page tracking existed report no pages, and the audit treats
  // that as unknown rather than as clean.
  const pageRows = await Promise.resolve()
    .then(() => prisma.sourcePage.findMany({ where: { sourceDocumentId: doc.id }, select: { pageNumber: true, status: true, ocrConfidence: true } }))
    .catch(() => [] as { pageNumber: number; status: string; ocrConfidence: number | null }[]);
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
  }));
  const audit = auditFactualRecord({
    encounters: auditEncounters,
    pages: pageRows.map((p) => ({ pageNumber: p.pageNumber, status: p.status, ocrConfidence: p.ocrConfidence })),
    failedExtractions: 0,
    unresolvedDisputes,
    allDocumentsProcessed: true,
  });

  const run = await record("COMPLETE", {
    sourceFingerprint,
    truncated,
    chunkCount: chunks.length,
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
  });

  // ── Persist with review lineage ────────────────────────────────────────────
  const prior = await prisma.extractedEncounter.findMany({ where: { caseId: doc.caseId, sourceDocumentId: doc.id, status: { notIn: ["SUPERSEDED"] } } });
  const priorHuman = prior.filter((p) => ["HUMAN_EDITED", "REVIEWED", "VERIFIED", "STALE"].includes(p.status));
  // Machine-produced drafts — including ones that passed the audit — may be
  // superseded by a newer run. Passing an audit is not human work and earns no
  // protection from regeneration.
  const priorDrafts = prior.filter((p) => ["AI_DRAFT", "AI_AUDIT_PASSED", "EXTRACTION_FAILED"].includes(p.status));

  // Source changed → reviewed content goes STALE (never silently re-verified).
  for (const h of priorHuman) {
    if (h.status !== "STALE" && h.sourceFingerprint && h.sourceFingerprint !== sourceFingerprint) {
      await prisma.extractedEncounter.update({
        where: { id: h.id },
        data: { status: "STALE", staleReason: "Source document content changed after this encounter was reviewed; re-review required." },
      });
    }
  }
  const humanKeys = new Set(
    priorHuman
      .filter((h) => h.status !== "STALE" && (!h.sourceFingerprint || h.sourceFingerprint === sourceFingerprint))
      .map((h) => encounterKey({ encounterDate: h.encounterDate, provider: h.provider, page: h.page })),
  );

  const created: string[] = [];
  for (const e of encounters) {
    // A current (non-stale) human row already covers this encounter — do not
    // create a duplicate AI candidate beside preserved human work.
    if (humanKeys.has(encounterKey({ encounterDate: e.encounterDate, provider: e.provider, page: e.page }))) continue;
    const row = await prisma.extractedEncounter.create({
      data: {
        extractionId: run.id,
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
        factualSummary: renderFactualSummary(e),
        synthesis: encounters.length === 1 ? synthesis : null,
        claims: e.claims as never,
        ocrConfidence: e.ocrConfidence,
        warnings: e.warnings as never,
        // A draft that survived the audit is marked as such; anything else
        // stays a plain AI_DRAFT and carries the reasons. Neither is verified —
        // an audit says the system found nothing wrong, which is not the same
        // as a human agreeing the record is right.
        status: audit.result === "PASS" ? "AI_AUDIT_PASSED" : "AI_DRAFT",
        auditResult: audit.result,
        auditFindings: audit.findings.slice(0, 20) as never,
        auditedAt: new Date(),
        sourceFingerprint,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        model: prov.model,
      },
    });
    created.push(row.id);
  }
  // Prior drafts are superseded by this run (pointing at the run's first row
  // when one exists — enough to walk the lineage).
  if (priorDrafts.length) {
    await prisma.extractedEncounter.updateMany({
      where: { id: { in: priorDrafts.map((p) => p.id) } },
      data: { status: "SUPERSEDED", supersededById: created[0] ?? null },
    });
  }

  return { extractionId: run.id, status: "COMPLETE", accepted: encounters.length, rejected: rejects.length };
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
