// ─────────────────────────────────────────────────────────────────────────────
// Writing and reading scoped findings.
//
// Two properties matter more than anything else here:
//
//   IDENTITY — the same problem, re-derived by a later audit, must be the SAME
//   finding. Every finding carries a fingerprint built from what it is about,
//   so a re-audit updates rather than multiplies. Metrics count fingerprints.
//
//   TARGET — a finding names the one thing it concerns. A document's
//   incompleteness is a DOCUMENT finding; a contradicted date is an ENTRY
//   finding. Nothing is copied sideways onto neighbours, which is the whole
//   defect this replaces.
//
// A human disposition (dismiss/resolve/confirm) is never overwritten by a
// re-audit, and never automatically resolved by one. Two rules make that real:
//
//   AUTHORITY — a pass may only supersede findings inside the scope it
//   actually evaluated, and only ones still OPEN and machine-produced. The
//   first version superseded case-wide whenever ANY subset of documents was
//   re-audited, and swept CONFIRMED — a human saying "yes, this is real" —
//   into RESOLVED along with it.
//
//   COVERAGE — a dismissal covers the content it was given over. Its source
//   fingerprint is recorded, and when the source changes underneath it the
//   finding REOPENS instead of carrying forward as though the human had seen
//   the new content. The prior disposition is kept as history, never deleted.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import {
  isOpenFinding,
  type FindingScope,
  type FindingSeverity,
  type FindingSource,
  type FindingStatus,
} from "@/lib/records/findingScope";

export interface FindingDraft {
  firmId: string;
  caseId: string;
  scope: FindingScope;
  type: string;
  severity?: FindingSeverity;
  blocking?: boolean;
  source: FindingSource;
  sourceDocumentId?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  canonicalNoteId?: string | null;
  encounterId?: string | null;
  claimIndex?: number | null;
  field?: string | null;
  detail: string;
  excerpt?: string | null;
  sourceFingerprint?: string | null;
  promptVersion?: string | null;
  model?: string | null;
  producerVersion?: string | null;
}

/**
 * The identity of a problem: its target and its kind, never its wording.
 *
 * Deliberately excludes `detail` and `excerpt` — an audit that rephrases its
 * explanation has not found a second problem. Deliberately includes the page
 * range and claim index, because "page 4 is unreadable" and "page 9 is
 * unreadable" are two problems.
 */
export function findingFingerprint(draft: FindingDraft): string {
  const target = [
    draft.scope,
    draft.type,
    draft.sourceDocumentId ?? "",
    draft.pageStart ?? "",
    draft.pageEnd ?? "",
    draft.canonicalNoteId ?? "",
    draft.encounterId ?? "",
    draft.claimIndex ?? "",
    draft.field ?? "",
  ].join("|");
  return createHash("sha256").update(target).digest("hex").slice(0, 40);
}

/** The Prisma surface this service needs, structurally typed for testing. */
export interface FindingStore {
  recordFinding: {
    findMany(args: unknown): Promise<unknown[]>;
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

/**
 * Sources a machine pass may supersede. HUMAN_REVIEW findings are raised by a
 * person and are never swept by an automated derivation, whatever a caller
 * passes in.
 */
const MACHINE_SOURCES: ReadonlySet<string> = new Set([
  "DETERMINISTIC_VALIDATOR",
  "EXTRACTION_CRITIC",
  "ADJUDICATOR",
  "CORROBORATION",
  "OCR",
  "PAGE_LEDGER",
]);

/** Human dispositions, which bind to the source content they were given over. */
const HUMAN_DISPOSITIONS: ReadonlySet<string> = new Set(["DISMISSED", "RESOLVED"]);

/**
 * The slice of findings a derivation is authoritative for.
 *
 * `evaluatedDocumentIds` are the documents whose LATEST state this pass
 * actually read. Case-scope findings name no document, so they may only be
 * superseded by a pass that evaluated the whole case — otherwise re-auditing
 * one document would clear "not every document has finished processing".
 */
export interface SupersedeScope {
  caseId: string;
  sources: readonly FindingSource[];
  evaluatedDocumentIds: readonly string[];
  evaluatedWholeCase: boolean;
}

interface ExistingFinding {
  fingerprint: string;
  status: string;
  dispositionReason?: string | null;
  reviewedById?: string | null;
  reviewedAt?: Date | null;
  dispositionSourceFingerprint?: string | null;
  dispositionHistory?: unknown;
}

/** PHI-free record of a disposition that no longer applies. */
interface DispositionHistoryEntry {
  status: string;
  reason: string | null;
  byId: string | null;
  at: string | null;
  sourceFingerprint: string | null;
  supersededBecause: string;
}

const historyOf = (existing: ExistingFinding): DispositionHistoryEntry[] =>
  Array.isArray(existing.dispositionHistory) ? (existing.dispositionHistory as DispositionHistoryEntry[]) : [];

/**
 * Does a re-derivation invalidate the human answer already on this finding?
 *
 * Only when the answer was given over DIFFERENT source content. A dismissal
 * recorded against fingerprint A says nothing about fingerprint B, and
 * carrying it forward would hide a problem in content nobody has looked at.
 * A finding whose disposition predates fingerprint recording is left alone —
 * absent evidence is not evidence of change.
 */
export function dispositionOutlivedItsSource(existing: ExistingFinding, redrivedFingerprint: string | null | undefined): boolean {
  if (!HUMAN_DISPOSITIONS.has(existing.status)) return false;
  if (!existing.dispositionSourceFingerprint || !redrivedFingerprint) return false;
  return existing.dispositionSourceFingerprint !== redrivedFingerprint;
}

export interface PersistedFinding extends FindingDraft {
  id: string;
  fingerprint: string;
  status: FindingStatus;
  dispositionReason?: string | null;
  reviewedById?: string | null;
  reviewedAt?: Date | null;
}

/**
 * Write a set of findings for a scope that was just re-derived.
 *
 * `supersedeWithin` names the slice this derivation is authoritative for. Any
 * still-OPEN machine finding in that slice which the new derivation did not
 * produce is RESOLVED: the problem is gone, and leaving it open would block a
 * case over something already fixed. Anything a human touched — CONFIRMED,
 * DISMISSED, RESOLVED — is left exactly as it is.
 */
export async function writeFindings(
  db: FindingStore,
  drafts: readonly FindingDraft[],
  supersedeWithin?: SupersedeScope,
): Promise<{ written: number; resolved: number; reopened: number; fingerprints: string[] }> {
  const fingerprints: string[] = [];
  const drafted = drafts.map((draft) => ({ draft, fingerprint: findingFingerprint(draft) }));

  // Read the current state of everything about to be written, in one query, so
  // the upsert can decide whether a human answer still covers this content.
  const existingByFingerprint = new Map<string, ExistingFinding>();
  if (drafted.length) {
    const rows = (await db.recordFinding.findMany({
      where: { caseId: drafted[0].draft.caseId, fingerprint: { in: drafted.map((d) => d.fingerprint) } },
      select: {
        fingerprint: true, status: true, dispositionReason: true, reviewedById: true,
        reviewedAt: true, dispositionSourceFingerprint: true, dispositionHistory: true,
      },
    }).catch(() => [])) as ExistingFinding[];
    for (const r of rows ?? []) existingByFingerprint.set(r.fingerprint, r);
  }

  let reopened = 0;
  for (const { draft, fingerprint } of drafted) {
    fingerprints.push(fingerprint);
    const data = {
      firmId: draft.firmId,
      caseId: draft.caseId,
      scope: draft.scope,
      type: draft.type,
      severity: draft.severity ?? (draft.blocking ? "BLOCKING" : "WARNING"),
      blocking: draft.blocking ?? false,
      source: draft.source,
      sourceDocumentId: draft.sourceDocumentId ?? null,
      pageStart: draft.pageStart ?? null,
      pageEnd: draft.pageEnd ?? null,
      canonicalNoteId: draft.canonicalNoteId ?? null,
      encounterId: draft.encounterId ?? null,
      claimIndex: draft.claimIndex ?? null,
      field: draft.field ?? null,
      detail: draft.detail,
      excerpt: draft.excerpt ?? null,
      sourceFingerprint: draft.sourceFingerprint ?? null,
      promptVersion: draft.promptVersion ?? null,
      model: draft.model ?? null,
      producerVersion: draft.producerVersion ?? null,
      fingerprint,
    };
    const existing = existingByFingerprint.get(fingerprint);
    // A dismissal given over different source content does not cover this
    // content. Reopen, and keep the human's answer as history rather than
    // discarding it.
    const reopen = existing ? dispositionOutlivedItsSource(existing, draft.sourceFingerprint) : false;
    if (reopen) reopened++;

    await db.recordFinding.upsert({
      where: { caseId_fingerprint: { caseId: draft.caseId, fingerprint } },
      // A re-derivation refreshes the explanation and provenance. It changes
      // the status in exactly one case: the source moved out from under a
      // human disposition.
      update: {
        detail: data.detail,
        excerpt: data.excerpt,
        severity: data.severity,
        blocking: data.blocking,
        producerVersion: data.producerVersion,
        sourceFingerprint: data.sourceFingerprint,
        ...(reopen && existing
          ? {
              status: "OPEN",
              dispositionReason: null,
              reviewedById: null,
              reviewedAt: null,
              dispositionSourceFingerprint: null,
              dispositionHistory: [
                ...historyOf(existing),
                {
                  status: existing.status,
                  reason: existing.dispositionReason ?? null,
                  byId: existing.reviewedById ?? null,
                  at: existing.reviewedAt ? new Date(existing.reviewedAt).toISOString() : null,
                  sourceFingerprint: existing.dispositionSourceFingerprint ?? null,
                  supersededBecause: "source content changed after this disposition was recorded",
                } satisfies DispositionHistoryEntry,
              ],
            }
          : {}),
      },
      create: data,
    });
  }

  let resolved = 0;
  if (supersedeWithin) {
    const machineSources = supersedeWithin.sources.filter((s) => MACHINE_SOURCES.has(s));
    // Scope: the documents this pass actually read, plus — only for a pass
    // that read the whole case — the findings that name no document at all.
    const targets: Record<string, unknown>[] = [];
    if (supersedeWithin.evaluatedDocumentIds.length) targets.push({ sourceDocumentId: { in: [...supersedeWithin.evaluatedDocumentIds] } });
    if (supersedeWithin.evaluatedWholeCase) targets.push({ sourceDocumentId: null });

    if (machineSources.length && targets.length) {
      const gone = await db.recordFinding.updateMany({
        where: {
          caseId: supersedeWithin.caseId,
          source: { in: machineSources },
          // OPEN only. CONFIRMED is a person saying the problem is real, and a
          // machine pass may not answer that on their behalf.
          status: "OPEN",
          fingerprint: { notIn: fingerprints.length ? fingerprints : ["__none__"] },
          OR: targets,
        },
        data: { status: "RESOLVED", dispositionReason: "no longer produced by the current deterministic audit" },
      });
      resolved = gone.count;
    }
  }

  return { written: drafts.length, resolved, reopened, fingerprints };
}

/** Open findings for a case, already deduplicated by identity. */
export function distinctOpen<T extends { fingerprint: string; status: string }>(findings: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of findings) {
    if (!isOpenFinding(f.status)) continue;
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    out.push(f);
  }
  return out;
}
