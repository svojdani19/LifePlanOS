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
// A human disposition (dismiss/resolve) is never overwritten by a re-audit: a
// re-derived finding that a reviewer already answered stays answered.
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
 * `supersedeWithin` names the slice of findings this derivation is
 * authoritative for — typically one document's deterministic findings. Any
 * OPEN finding in that slice which the new derivation did NOT produce is
 * RESOLVED: the problem is gone, and leaving it open would block a case over
 * something already fixed. Findings a human dispositioned are left alone.
 */
export async function writeFindings(
  db: FindingStore,
  drafts: readonly FindingDraft[],
  supersedeWithin?: { caseId: string; sourceDocumentId?: string | null; sources: readonly FindingSource[] },
): Promise<{ written: number; resolved: number; fingerprints: string[] }> {
  const fingerprints: string[] = [];
  for (const draft of drafts) {
    const fingerprint = findingFingerprint(draft);
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
    await db.recordFinding.upsert({
      where: { caseId_fingerprint: { caseId: draft.caseId, fingerprint } },
      // A re-derivation refreshes the explanation and provenance but NEVER the
      // status: a finding a reviewer dismissed stays dismissed.
      update: {
        detail: data.detail,
        excerpt: data.excerpt,
        severity: data.severity,
        blocking: data.blocking,
        producerVersion: data.producerVersion,
        sourceFingerprint: data.sourceFingerprint,
      },
      create: data,
    });
  }

  let resolved = 0;
  if (supersedeWithin) {
    const gone = await db.recordFinding.updateMany({
      where: {
        caseId: supersedeWithin.caseId,
        ...(supersedeWithin.sourceDocumentId ? { sourceDocumentId: supersedeWithin.sourceDocumentId } : {}),
        source: { in: [...supersedeWithin.sources] },
        status: { in: ["OPEN", "CONFIRMED"] },
        fingerprint: { notIn: fingerprints.length ? fingerprints : ["__none__"] },
      },
      data: { status: "RESOLVED", dispositionReason: "no longer produced by the current deterministic audit" },
    });
    resolved = gone.count;
  }

  return { written: drafts.length, resolved, fingerprints };
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
