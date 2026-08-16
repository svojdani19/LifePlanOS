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
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { projectNotes, type ReviewableNote } from "@/lib/records/noteProjection";
import { CURRENT_OUTPUT_WHERE, REVIEW_BLOCKING_STATES, REVIEW_VISIBLE_WHERE } from "@/lib/records/encounterLifecycle";
import { requiresDate } from "@/lib/documents/analysisClass";
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
  /** The KIND of document this row came from; null on legacy rows. */
  analysisClass: string | null;
  /** Author and role for documents that have one but no treating clinician. */
  attributionName: string | null;
  attributionRole: string | null;
  reviewedAt: string | null;
  verifiedAt: string | null;
  staleReason: string | null;
  /** The entry's own audit result; a note presents the worst of its rows'. */
  auditResult: string | null;
  /** Disputes about this entry no adjudicator settled — why it is conflicted. */
  unresolvedDisputes?: number | null;
  /** Fields adjudication confirmed the source contradicts. */
  contradictedFields?: string[] | null;
  /** Null on rows graded before dispute state was persisted (legacy). */
  auditVersion?: string | null;
  /** Findings targeted at THIS entry or its claims — never a neighbour's. */
  findings?: {
    id: string; scope: string; type: string; severity: string; blocking: boolean; source: string;
    detail: string; excerpt?: string | null; field?: string | null;
    pageStart?: number | null; pageEnd?: number | null; claimIndex?: number | null; status: string;
  }[];
  /**
   * Cross-document copies of this record: review-visible rows from OTHER
   * documents that the canonical build folded into the same entry. The
   * primary card discloses them and one review decision covers them.
   */
  copies?: { id: string; filename: string; page: number | null; summary: string; status: string; contentHash: string }[];
  /** Set on a copy row: the document whose primary card reviews it. */
  reviewedWith?: { filename: string } | null;
  /**
   * Machine corroboration: an independent blind re-read reproduced (or did
   * not reproduce) this row's facts. Quality evidence only — never satisfies
   * the human review gate.
   */
  corroboration?: { result: string; reproduced: number; total: number; unreproducedFields?: string[] } | null;
  /**
   * Hash of the exact content being displayed. Sent back with a review
   * decision so the server can refuse to sign content that changed after the
   * reviewer looked at it — for every row a group decision covers, not just
   * the one whose card carried the button.
   */
  contentHash: string;
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
  /**
   * The document's CANONICAL NOTES — the review unit.
   *
   * `encounters` above are the extraction rows the notes were assembled from;
   * they remain available as evidence and for per-row correction, but a
   * reviewer decides one note at a time.
   */
  notes: ReviewableNote[];
}

/**
 * Does a row of this kind need a date before the record is complete?
 *
 * Only material bound for the medical timeline does. A charge ledger, a fee
 * schedule or a records-request letter is legitimately dateless, and asking a
 * physician to date it is asking them to invent a fact. A legacy row with no
 * recorded kind is treated as needing one — the conservative reading keeps a
 * genuine gap visible rather than excusing it.
 */
function isMedicalTimelineKind(analysisClass: string | null | undefined): boolean {
  return requiresDate(analysisClass as never);
}

export interface StructuredRecord {
  documents: StructuredDocument[];
  /** Encounters with no reliable date — visible, never silently on the timeline. */
  undated: StructuredEncounter[];
  /** Case-level processing limitations to disclose in reviews and reports. */
  limitations: string[];
  counts: {
    encounters: number;
    verified: number;
    reviewed: number;
    humanEdited: number;
    /** Plain AI drafts (kept for existing consumers). */
    aiDraft: number;
    /** AI drafts that passed the automated audit — still pending a human. */
    aiAuditPassed: number;
    /** Audit-passed drafts an independent blind re-read also reproduced —
     *  the strongest machine evidence; still pending a human. */
    machineCorroborated: number;
    /** Everything awaiting HUMAN review: AI_DRAFT + AI_AUDIT_PASSED. An
     *  automated audit is a quality signal, never a review. */
    pendingHumanReview: number;
    stale: number;
    generationLoss: number;
    /** Clinical entries the system could not date — a real gap to close. */
    undatedClinical: number;
    /** Non-clinical material with no visit date because none applies. */
    undatedNonClinical: number;
    failedDocs: number;
    pendingOcr: number;
  };
}

const toIso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function toStructuredEncounter(e: {
  id: string; sourceDocumentId: string; dateStatus: string; encounterDate: Date | null; encounterDateEnd: Date | null;
  provider: string | null; providerCredentials: string | null; facility: string | null; encounterType: string | null;
  factualSummary: string; synthesis: string | null; claims: unknown; page: number | null; pageEnd: number | null;
  ocrConfidence: number | null; warnings: unknown; status: string; substanceClass?: string | null; substanceReason?: string | null;
  analysisClass?: string | null; attributionName?: string | null; attributionRole?: string | null;
  reviewedAt: Date | null; verifiedAt: Date | null; staleReason: string | null; corroboration?: unknown;
  auditResult?: string | null; unresolvedDisputes?: number | null; contradictedFields?: unknown; auditVersion?: string | null;
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
    analysisClass: e.analysisClass ?? null,
    attributionName: e.attributionName ?? null,
    attributionRole: e.attributionRole ?? null,
    reviewedAt: e.reviewedAt?.toISOString() ?? null,
    verifiedAt: e.verifiedAt?.toISOString() ?? null,
    staleReason: e.staleReason,
    auditResult: e.auditResult ?? null,
    unresolvedDisputes: e.unresolvedDisputes ?? 0,
    contradictedFields: Array.isArray(e.contradictedFields) ? (e.contradictedFields as string[]) : [],
    auditVersion: e.auditVersion ?? null,
    contentHash: encounterContentHash({
      dateStatus: e.dateStatus,
      encounterDate: e.encounterDate,
      provider: e.provider,
      facility: e.facility,
      encounterType: e.encounterType,
      factualSummary: e.factualSummary,
      synthesis: e.synthesis ?? null,
      claims: e.claims as never,
    } as never),
    corroboration:
      e.corroboration && typeof e.corroboration === "object"
        ? (e.corroboration as StructuredEncounter["corroboration"])
        : null,
  };
}

/**
 * Link cross-document copies of one record for the review surface.
 *
 * The canonical build already knows which rows are copies: a persisted
 * segment's rowIds span every row folded into that entry, including copies
 * absorbed from other documents. A reviewer was still asked to review the
 * same emergency visit once per production it appeared in.
 *
 * The row from the segment's own document becomes the PRIMARY; rows from
 * other documents become its copies, each pointing back at the primary's
 * document. Rows of one document folded together (fragments of one note) are
 * NOT linked — they carry different content and each deserves its own eyes.
 * Presentation-level linkage only: storage, gating and review semantics are
 * untouched, and every copy remains individually reviewable.
 */
export function linkCopies(
  docs: readonly { id: string; filename: string; segments?: unknown }[],
  byId: ReadonlyMap<string, StructuredEncounter>,
): void {
  const nameOf = new Map(docs.map((d) => [d.id, d.filename]));
  for (const d of docs) {
    const segments = Array.isArray(d.segments) ? (d.segments as { rowIds?: unknown }[]) : [];
    for (const seg of segments) {
      const rowIds = Array.isArray(seg.rowIds) ? (seg.rowIds as string[]) : [];
      if (rowIds.length < 2) continue;
      const rows = rowIds.map((id) => byId.get(id)).filter((r): r is StructuredEncounter => !!r);
      const primaries = rows.filter((r) => r.sourceDocumentId === d.id);
      const copies = rows.filter((r) => r.sourceDocumentId !== d.id);
      if (!primaries.length || !copies.length) continue;
      // One primary card carries the copies; the segment's first row is
      // stable across reloads because encounters arrive date-then-page sorted.
      const primary = primaries[0];
      primary.copies = [
        ...(primary.copies ?? []),
        ...copies.map((c) => ({
          id: c.id,
          filename: nameOf.get(c.sourceDocumentId) ?? "record on file",
          page: c.page,
          summary: c.factualSummary,
          status: c.status,
          contentHash: c.contentHash,
        })),
      ];
      for (const c of copies) c.reviewedWith = { filename: nameOf.get(d.id) ?? d.filename };
    }
  }
}

/**
 * The completion blocker for a record that is missing encounters.
 *
 * Coverage gaps stopped being copied onto every row of their document — an
 * entry is not defective because a DIFFERENT note was missed — so the gate
 * must carry them explicitly, or a fully reviewed case would export over a
 * known missing encounter. Latest run per document only: an earlier run's
 * gaps are not this record's gaps.
 *
 * Exported and pure so the guarantee is testable rather than merely asserted.
 */
export function coverageGapBlocker(runs: readonly { sourceDocumentId: string; coverageGaps?: number | null }[]): string | null {
  const latest = new Map<string, number>();
  for (const r of runs) if (!latest.has(r.sourceDocumentId)) latest.set(r.sourceDocumentId, r.coverageGaps ?? 0);
  const missed = [...latest.values()].reduce((n, g) => n + g, 0);
  if (missed <= 0) return null;
  return `${missed} dated note header(s) across the records produced no extracted encounter; the record may be under-extracted and needs human review.`;
}

/** Tenant-scoped: firmId comes from the authenticated context, never the client. */
export async function getStructuredRecord(caseId: string, firmId: string, options: { scope?: "review" | "output" } = {}): Promise<StructuredRecord> {
  const [documents, runs, encounters] = await Promise.all([
    prisma.document.findMany({ where: { caseId, firmId }, orderBy: { createdAt: "asc" } }),
    prisma.recordExtraction.findMany({ where: { caseId, firmId }, orderBy: { createdAt: "desc" } }),
    prisma.extractedEncounter.findMany({
      // Two callers, two questions. The review surface must SEE stale human
      // work and generation-loss candidates in order to resolve them; report
      // data must NOT read facts from rows describing a source that changed or
      // a result the current extraction could not reproduce.
      where: { caseId, firmId, ...(options.scope === "output" ? CURRENT_OUTPUT_WHERE : REVIEW_VISIBLE_WHERE) },
      orderBy: [{ encounterDate: "asc" }, { page: "asc" }],
    }),
  ]);

  const latestRunByDoc = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestRunByDoc.has(r.sourceDocumentId)) latestRunByDoc.set(r.sourceDocumentId, r);
  const encByDoc = new Map<string, StructuredEncounter[]>();
  const encById = new Map<string, StructuredEncounter>();
  const undated: StructuredEncounter[] = [];
  for (const e of encounters) {
    const se = toStructuredEncounter(e);
    if (se.dateStatus === "UNKNOWN") undated.push(se);
    const arr = encByDoc.get(e.sourceDocumentId) ?? [];
    arr.push(se);
    encByDoc.set(e.sourceDocumentId, arr);
    encById.set(se.id, se);
  }
  // Cross-document copies of one record review together, not once per
  // production. Runs on review scope only; report data reads facts, not
  // review linkage.
  if (options.scope !== "output") linkCopies(documents, encById);

  const findingsByDoc = new Map<string, unknown[]>();
  // Scoped findings, attached to the thing each one names. A DOCUMENT or PAGE
  // finding is deliberately NOT attached to entries: it belongs to the
  // document, and copying it down is the defect this replaces.
  if (options.scope !== "output") {
    // Optional-chained: a caller with a narrower Prisma surface (tests, older
    // mocks) simply gets no findings rather than a crash. `.catch` cannot
    // help here — the throw would happen before a promise exists.
    const found = await prisma.recordFinding
      ?.findMany({
        where: { caseId, firmId, status: { in: ["OPEN", "CONFIRMED"] } },
        select: {
          id: true, scope: true, type: true, severity: true, blocking: true, source: true,
          detail: true, excerpt: true, field: true, pageStart: true, pageEnd: true,
          claimIndex: true, status: true, encounterId: true,
        },
      })
      .catch(() => [] as { encounterId: string | null }[]);
    for (const f of (found ?? []) as { encounterId: string | null; sourceDocumentId?: string | null; scope?: string }[]) {
      // Note- and entry-scoped findings travel to the note projection; a
      // DOCUMENT or PAGE finding stays at its own scope and is shown once.
      if (f.sourceDocumentId && (f.scope === "NOTE" || f.scope === "ENTRY" || f.scope === "CLAIM")) {
        findingsByDoc.set(f.sourceDocumentId, [...(findingsByDoc.get(f.sourceDocumentId) ?? []), f]);
      }
      if (!f.encounterId) continue;
      const target = encById.get(f.encounterId);
      if (!target) continue;
      target.findings = [...(target.findings ?? []), f as never];
    }
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
      // Built from the same persisted segments the records builder wrote, so
      // the review unit is exactly what the chronology and reports cite.
      notes: projectNotes(d.id, d.segments, encByDoc.get(d.id) ?? [], (findingsByDoc.get(d.id) ?? []) as never),
    };
  });
  // State the two facts separately. Lumping them together overstates the
  // problem and hides the part that actually needs a human.
  const undatedClinical = undated.filter((e) => isMedicalTimelineKind(e.analysisClass));
  const undatedOther = undated.filter((e) => !isMedicalTimelineKind(e.analysisClass));
  if (undatedClinical.length) {
    limitations.push(
      `${undatedClinical.length} clinical entr${undatedClinical.length === 1 ? "y" : "ies"} carr${undatedClinical.length === 1 ? "ies" : "y"} no reliable date and require human date review; they are not placed on the dated chronology.`,
    );
  }
  if (undatedOther.length) {
    limitations.push(
      `${undatedOther.length} non-clinical document${undatedOther.length === 1 ? "" : "s"} (correspondence, consent and registration pages, billing and similar material) carr${undatedOther.length === 1 ? "ies" : "y"} no visit date because none applies. This is expected and requires no action; such material never enters the medical chronology.`,
    );
  }

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
      aiAuditPassed: countBy("AI_AUDIT_PASSED"),
      machineCorroborated: all.filter((e) => e.status === "AI_AUDIT_PASSED" && e.corroboration?.result === "CORROBORATED").length,
      pendingHumanReview: countBy("AI_DRAFT") + countBy("AI_AUDIT_PASSED"),
      stale: countBy("STALE"),
      // Prior machine results the current extraction did not reproduce,
      // waiting on a reviewer to confirm or reject.
      generationLoss: countBy("GENERATION_LOSS"),
      // Undated is TWO different facts. A clinic note the system could not
      // date is a gap to close; a consent form or a charge page has no visit
      // date because it is not a visit, and counting the two together turned
      // 24 real problems into an alarming, meaningless 101.
      undatedClinical: undated.filter((e) => isMedicalTimelineKind(e.analysisClass)).length,
      undatedNonClinical: undated.filter((e) => !isMedicalTimelineKind(e.analysisClass)).length,
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
  const [record, events, encounters, pages, runs] = await Promise.all([
    getStructuredRecord(caseId, firmId),
    prisma.chronologyEvent.findMany({ where: { caseId }, select: { reviewStatus: true, edited: true } }),
    prisma.extractedEncounter.findMany({
      where: { caseId, firmId, ...CURRENT_OUTPUT_WHERE },
      select: {
        status: true, auditResult: true, verifiedContentHash: true, dateStatus: true, encounterDate: true,
        provider: true, facility: true, encounterType: true, factualSummary: true, synthesis: true, claims: true,
      },
    }),
    prisma.sourcePage.findMany({ where: { caseId, firmId }, select: { status: true } }).catch(() => [] as { status: string }[]),
    // Under-extraction is a fact about a DOCUMENT, so the gate reads it from
    // the document's latest run rather than from every row of that document
    // carrying it as its own defect.
    prisma.recordExtraction
      .findMany({ where: { caseId, firmId, status: "COMPLETE" }, orderBy: { createdAt: "desc" }, select: { sourceDocumentId: true, coverageGaps: true } })
      .catch(() => [] as { sourceDocumentId: string; coverageGaps: number }[]),
  ]);
  const blockers: string[] = [];
  if (record.counts.pendingHumanReview > 0) blockers.push(`${record.counts.pendingHumanReview} extracted encounter(s) are pending human review (AI drafts, including audit-passed drafts — an automated audit is not a human review).`);
  if (record.counts.stale > 0) blockers.push(`${record.counts.stale} reviewed encounter(s) are stale after source changes and need re-review.`);
  if (record.counts.generationLoss > 0) blockers.push(`${record.counts.generationLoss} prior machine encounter(s) were not reproduced by the current extraction and need a reviewer to confirm or reject them.`);
  // Belt and braces: the blocker states are queried EXPLICITLY, so a future
  // change to either scoped query cannot silently blind the completion gate.
  const blocking = await prisma.extractedEncounter.count({
    where: { caseId, firmId, status: { in: REVIEW_BLOCKING_STATES as unknown as string[] }, supersededById: null },
  });
  if (blocking > 0 && record.counts.stale === 0 && record.counts.generationLoss === 0) {
    blockers.push(`${blocking} encounter(s) are awaiting review resolution.`);
  }
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

  // A dated note the extraction never produced an encounter for is content
  // missing from the record — the same class of defect as an unreadable page,
  // and it must block a final export for the same reason. Latest run per
  // document only: an earlier run's gaps are not this record's gaps.
  const underExtracted = coverageGapBlocker(runs);
  if (underExtracted) blockers.push(underExtracted);

  // Structured findings, counted ONCE each by identity. A document or page
  // problem blocks the case exactly once, however many entries sit near it.
  const openFindings = await prisma.recordFinding
    ?.findMany({
      where: { caseId, firmId, blocking: true, status: { in: ["OPEN", "CONFIRMED"] } },
      select: { fingerprint: true, scope: true, type: true },
    })
    .catch(() => [] as { fingerprint: string; scope: string; type: string }[]);
  const distinctBlocking = new Map<string, { scope: string; type: string }>();
  for (const f of openFindings ?? []) distinctBlocking.set(f.fingerprint, { scope: f.scope, type: f.type });
  const byScope = new Map<string, number>();
  for (const f of distinctBlocking.values()) byScope.set(f.scope, (byScope.get(f.scope) ?? 0) + 1);
  for (const [scope, n] of [...byScope].sort()) {
    blockers.push(`${n} unresolved ${scope.toLowerCase()}-level finding(s) must be corrected or dispositioned before a final export.`);
  }

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
