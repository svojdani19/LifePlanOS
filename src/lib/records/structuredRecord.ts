// ─────────────────────────────────────────────────────────────────────────────
// Shared structured-record service: ONE source of truth consumed by the case
// Records page (via its API) and the exported Medical Record Summary — the
// same cited, validated encounter facts everywhere.
//
// Distinctions carried on every element (never blurred):
//   • documented record facts   → claims with excerpt + page citations
//   • system-generated synthesis→ `synthesis`, labeled
//   • system-suggested relevance→ computed elsewhere; labeled at display
//   • human-verified content    → status HUMAN_EDITED / REVIEWED / VERIFIED
//   • professional opinions     → NOT here (they live in gated workflows)
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { detectVerificationDrift } from "@/lib/records/verifiedContent";

export interface StructuredClaim {
  field: string;
  value: string;
  excerpt: string;
  page: number | null;
  /** Advisory model confidence; null when the model did not state one. */
  confidence: number | null;
  warning?: string;
}

export interface StructuredEncounter {
  id: string;
  sourceDocumentId: string;
  dateStatus: "DOCUMENTED" | "INFERRED" | "UNKNOWN";
  encounterDate: string | null;
  encounterDateEnd: string | null;
  provider: string | null;
  providerCredentials: string | null;
  facility: string | null;
  encounterType: string | null;
  factualSummary: string;
  synthesis: string | null;
  claims: StructuredClaim[];
  page: number | null;
  pageEnd: number | null;
  ocrConfidence: number | null;
  warnings: string[];
  status: string;
  /** CLINICAL | ANCILLARY | ADMINISTRATIVE — null means not yet classified. */
  substanceClass: string | null;
  substanceReason: string | null;
  reviewedAt: string | null;
  verifiedAt: string | null;
  staleReason: string | null;
}

export interface StructuredDocument {
  documentId: string;
  filename: string;
  type: string;
  pageCount: number | null;
  serviceDate: string | null;
  serviceDateEnd: string | null;
  ocrConfidence: number | null;
  flags: string | null;
  extraction: {
    status: "COMPLETE" | "EXTRACTION_FAILED" | "BLOCKED_OCR" | "PENDING" | "NOT_RUN";
    error: string | null;
    warnings: string[];
    truncated: boolean;
    model: string | null;
    promptVersion: string | null;
    createdAt: string | null;
  };
  encounters: StructuredEncounter[];
}

export interface StructuredRecord {
  documents: StructuredDocument[];
  /** Encounters with no reliable date — visible, never silently on the timeline. */
  undated: StructuredEncounter[];
  /** Case-level processing limitations to disclose in reviews and reports. */
  limitations: string[];
  counts: { encounters: number; verified: number; reviewed: number; humanEdited: number; aiDraft: number; stale: number; failedDocs: number; pendingOcr: number };
}

const toIso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function toStructuredEncounter(e: {
  id: string; sourceDocumentId: string; dateStatus: string; encounterDate: Date | null; encounterDateEnd: Date | null;
  provider: string | null; providerCredentials: string | null; facility: string | null; encounterType: string | null;
  factualSummary: string; synthesis: string | null; claims: unknown; page: number | null; pageEnd: number | null;
  ocrConfidence: number | null; warnings: unknown; status: string; substanceClass?: string | null; substanceReason?: string | null;
  reviewedAt: Date | null; verifiedAt: Date | null; staleReason: string | null;
}): StructuredEncounter {
  return {
    id: e.id,
    sourceDocumentId: e.sourceDocumentId,
    dateStatus: e.dateStatus as StructuredEncounter["dateStatus"],
    encounterDate: toIso(e.encounterDate),
    encounterDateEnd: toIso(e.encounterDateEnd),
    provider: e.provider,
    providerCredentials: e.providerCredentials,
    facility: e.facility,
    encounterType: e.encounterType,
    factualSummary: e.factualSummary,
    synthesis: e.synthesis,
    claims: Array.isArray(e.claims) ? (e.claims as StructuredClaim[]) : [],
    page: e.page,
    pageEnd: e.pageEnd,
    ocrConfidence: e.ocrConfidence,
    warnings: Array.isArray(e.warnings) ? (e.warnings as string[]) : [],
    status: e.status,
    substanceClass: e.substanceClass ?? null,
    substanceReason: e.substanceReason ?? null,
    reviewedAt: e.reviewedAt?.toISOString() ?? null,
    verifiedAt: e.verifiedAt?.toISOString() ?? null,
    staleReason: e.staleReason,
  };
}

/** Tenant-scoped: firmId comes from the authenticated context, never the client. */
export async function getStructuredRecord(caseId: string, firmId: string): Promise<StructuredRecord> {
  const [documents, runs, encounters] = await Promise.all([
    prisma.document.findMany({ where: { caseId, firmId }, orderBy: { createdAt: "asc" } }),
    prisma.recordExtraction.findMany({ where: { caseId, firmId }, orderBy: { createdAt: "desc" } }),
    prisma.extractedEncounter.findMany({
      where: { caseId, firmId, status: { in: ["AI_DRAFT", "AI_AUDIT_PASSED", "HUMAN_EDITED", "REVIEWED", "VERIFIED", "STALE"] } },
      orderBy: [{ encounterDate: "asc" }, { page: "asc" }],
    }),
  ]);

  const latestRunByDoc = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestRunByDoc.has(r.sourceDocumentId)) latestRunByDoc.set(r.sourceDocumentId, r);
  const encByDoc = new Map<string, StructuredEncounter[]>();
  const undated: StructuredEncounter[] = [];
  for (const e of encounters) {
    const se = toStructuredEncounter(e);
    if (se.dateStatus === "UNKNOWN") undated.push(se);
    const arr = encByDoc.get(e.sourceDocumentId) ?? [];
    arr.push(se);
    encByDoc.set(e.sourceDocumentId, arr);
  }

  const limitations: string[] = [];
  let failedDocs = 0;
  let pendingOcr = 0;
  const docs: StructuredDocument[] = documents.map((d) => {
    const run = latestRunByDoc.get(d.id) ?? null;
    const ocrPending = /OCR queued|OCR in progress/i.test(d.flags ?? "");
    const ocrFailed = /OCR failed/i.test(d.flags ?? "");
    if (ocrPending) pendingOcr++;
    const status: StructuredDocument["extraction"]["status"] = run
      ? (run.status as StructuredDocument["extraction"]["status"])
      : ocrPending
        ? "PENDING"
        : "NOT_RUN";
    if (status === "EXTRACTION_FAILED" || ocrFailed) failedDocs++;
    if (run?.truncated) limitations.push(`"${d.filename}" exceeds the processing bound; only part of it was processed.`);
    if (d.ocrConfidence != null && d.ocrConfidence < 0.6) limitations.push(`"${d.filename}" has low-confidence OCR (${Math.round(d.ocrConfidence * 100)}%); its extracted facts require verification against the source scan.`);
    if (status === "EXTRACTION_FAILED") limitations.push(`"${d.filename}": ${run?.error ?? "extraction failed"}`);
    if (ocrPending) limitations.push(`"${d.filename}" is still being OCR'd; its content is not yet included.`);
    if (ocrFailed) limitations.push(`"${d.filename}": OCR failed; the document's content could not be read.`);
    return {
      documentId: d.id,
      filename: d.filename,
      type: d.type,
      pageCount: d.pageCount,
      serviceDate: toIso(d.serviceDate),
      serviceDateEnd: toIso(d.serviceDateEnd),
      ocrConfidence: d.ocrConfidence,
      flags: d.flags,
      extraction: {
        status,
        error: run?.error ?? null,
        warnings: Array.isArray(run?.warnings) ? (run!.warnings as string[]) : [],
        truncated: run?.truncated ?? false,
        model: run?.model ?? null,
        promptVersion: run?.promptVersion ?? null,
        createdAt: run?.createdAt.toISOString() ?? null,
      },
      encounters: encByDoc.get(d.id) ?? [],
    };
  });
  if (undated.length) limitations.push(`${undated.length} extracted encounter${undated.length === 1 ? "" : "s"} carry no reliable date and require human date review; they are not placed on the dated chronology.`);

  const all = [...encByDoc.values()].flat();
  const countBy = (s: string) => all.filter((e) => e.status === s).length;
  return {
    documents: docs,
    undated,
    limitations: [...new Set(limitations)],
    counts: {
      encounters: all.length,
      verified: countBy("VERIFIED"),
      reviewed: countBy("REVIEWED"),
      humanEdited: countBy("HUMAN_EDITED"),
      aiDraft: countBy("AI_DRAFT"),
      stale: countBy("STALE"),
      failedDocs,
      pendingOcr,
    },
  };
}

/**
 * Factual-review completion gate for FINAL Medical Record Summary / Medical
 * Chronology exports: every active extracted encounter reviewed (no AI drafts,
 * no stale), no failed extractions, no pending OCR, and no AI-draft/stale
 * chronology events. This is a FACTUAL gate — it never requires a physician
 * credential; medical opinions have their own gated workflows.
 */
export async function factualReviewState(caseId: string, firmId: string): Promise<{ complete: boolean; blockers: string[] }> {
  const [record, events, encounters, pages] = await Promise.all([
    getStructuredRecord(caseId, firmId),
    prisma.chronologyEvent.findMany({ where: { caseId }, select: { reviewStatus: true, edited: true } }),
    prisma.extractedEncounter.findMany({
      where: { caseId, firmId, status: { in: ["AI_DRAFT", "AI_AUDIT_PASSED", "HUMAN_EDITED", "REVIEWED", "VERIFIED", "STALE"] } },
      select: {
        status: true, auditResult: true, verifiedContentHash: true, dateStatus: true, encounterDate: true,
        provider: true, facility: true, encounterType: true, factualSummary: true, synthesis: true, claims: true,
      },
    }),
    prisma.sourcePage.findMany({ where: { caseId, firmId }, select: { status: true } }).catch(() => [] as { status: string }[]),
  ]);
  const blockers: string[] = [];
  if (record.counts.aiDraft > 0) blockers.push(`${record.counts.aiDraft} extracted encounter(s) are unreviewed AI drafts.`);
  if (record.counts.stale > 0) blockers.push(`${record.counts.stale} reviewed encounter(s) are stale after source changes and need re-review.`);
  if (record.counts.failedDocs > 0) blockers.push(`${record.counts.failedDocs} document(s) failed extraction or OCR and need attention.`);
  if (record.counts.pendingOcr > 0) blockers.push(`${record.counts.pendingOcr} document(s) are still being OCR'd.`);
  const draftEvents = events.filter((e) => e.reviewStatus === "AI_DRAFT" && !e.edited).length;
  const staleEvents = events.filter((e) => e.reviewStatus === "STALE").length;
  if (draftEvents > 0) blockers.push(`${draftEvents} chronology event(s) are unreviewed AI drafts.`);
  if (staleEvents > 0) blockers.push(`${staleEvents} chronology event(s) are stale and need re-review.`);

  // A page that could not be read is content missing from the record, not a
  // cosmetic warning — a "complete" chronology built on the readable subset
  // would be a claim about the whole record that nobody can support.
  const badPages = pages.filter((p) => ["UNREADABLE", "OCR_FAILED", "PENDING_OCR", "TRUNCATED"].includes(p.status)).length;
  if (badPages > 0) blockers.push(`${badPages} source page(s) are unreadable, truncated or still processing.`);

  // Audit outcomes: anything other than PASS is, by definition, not a complete
  // draft — so it cannot become a final export.
  const unaudited = encounters.filter((e) => !e.auditResult).length;
  const failedAudit = encounters.filter((e) => e.auditResult && e.auditResult !== "PASS");
  if (unaudited > 0) blockers.push(`${unaudited} encounter(s) have not completed the factual audit.`);
  for (const [result, n] of countBy(failedAudit.map((e) => e.auditResult!))) {
    blockers.push(`${n} encounter(s) ended the factual audit as ${result.replace(/_/g, " ").toLowerCase()}.`);
  }

  // Verified content must still be the content that was verified.
  const drift = detectVerificationDrift(
    encounters.map((e) => ({ ...e, encounterDate: e.encounterDate, verifiedContentHash: e.verifiedContentHash })),
  );
  if (drift.changed > 0) blockers.push(`${drift.changed} verified encounter(s) have changed since verification and must be re-verified.`);
  if (drift.unhashed > 0) blockers.push(`${drift.unhashed} verified encounter(s) predate content hashing and must be re-verified before a final export.`);

  return { complete: blockers.length === 0, blockers };
}

function countBy(values: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()];
}
