// ─────────────────────────────────────────────────────────────────────────────
// Firm-scoped correction learning. When an authorized reviewer corrects and
// VERIFIES an AI-extracted encounter, the correction is stored with structured
// field-level differences and a deterministic, FACT-FREE guidance sentence.
// Future extraction prompts for the SAME FIRM retrieve a bounded number of
// guidance sentences (by document type) — they teach formatting and
// extraction choices; they never carry patient names, dates, providers, or
// any case fact into another case's prompt.
//
// Prompts themselves are never modified automatically: guidance is injected
// through the versioned prompt's dedicated slot, and exemplar use can be
// disabled entirely with RECORD_EXEMPLARS=off. Promotion (`promoted`) is a
// human/measured act — only verified corrections qualify as exemplars, and
// promotion should follow a measured accuracy improvement.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";

export type CorrectionCategory =
  | "WRONG_FIELD"
  | "BOILERPLATE_REMOVED"
  | "DATE_CORRECTED"
  | "PROVIDER_CORRECTED"
  | "EXCERPT_MISMATCH"
  | "SUMMARY_REWORDED"
  | "OTHER";

export interface FieldDiff {
  field: string;
  changeType: "added" | "removed" | "reworded" | "moved";
}

/** Deterministic, fact-free guidance for a correction category. */
export function guidanceFor(category: CorrectionCategory, diffs: FieldDiff[]): string {
  const fields = [...new Set(diffs.map((d) => d.field))].slice(0, 4).join(", ") || "the affected field";
  switch (category) {
    case "WRONG_FIELD":
      return `Reviewers here re-file content between fields (${fields}); place each fact under the field its source section indicates, not where it merely fits.`;
    case "BOILERPLATE_REMOVED":
      return `Reviewers here remove consent/administrative boilerplate from ${fields}; extract only clinically substantive statements.`;
    case "DATE_CORRECTED":
      return "Reviewers here correct encounter dates; prefer explicit service-date labels over any other date on the page.";
    case "PROVIDER_CORRECTED":
      return "Reviewers here correct provider attribution; use the authoring clinician of the note, not a mentioned or referred-to provider.";
    case "EXCERPT_MISMATCH":
      return `Reviewers here tighten supporting excerpts for ${fields}; cite the exact sentence containing the fact, not surrounding text.`;
    case "SUMMARY_REWORDED":
      return "Reviewers here prefer terse, neutral phrasing in summaries; avoid narrative filler and keep the documented terminology.";
    default:
      return `Reviewers here frequently adjust ${fields}; extract conservatively and flag uncertainty instead of guessing.`;
  }
}

/** Structured field-level diff between the AI draft and the corrected version. */
export function diffFields(draft: Record<string, unknown>, corrected: Record<string, unknown>): FieldDiff[] {
  const out: FieldDiff[] = [];
  const keys = new Set([...Object.keys(draft), ...Object.keys(corrected)]);
  for (const k of keys) {
    const a = draft[k];
    const b = corrected[k];
    if (a == null && b != null) out.push({ field: k, changeType: "added" });
    else if (a != null && b == null) out.push({ field: k, changeType: "removed" });
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: k, changeType: "reworded" });
  }
  return out;
}

export function exemplarsEnabled(): boolean {
  return process.env.RECORD_EXEMPLARS !== "off";
}

/**
 * Record a VERIFIED correction as an exemplar. Draft/corrected snapshots stay
 * in the owning firm+case row for audit; only the fact-free guidance sentence
 * ever reaches another case's prompt.
 */
export async function recordCorrectionExemplar(input: {
  firmId: string;
  caseId: string;
  encounterId: string;
  documentType: string | null;
  category: CorrectionCategory;
  draft: Record<string, unknown>;
  corrected: Record<string, unknown>;
  claimRefs?: string[];
  reviewerId: string;
  promptVersion?: string | null;
  schemaVersion?: string | null;
  model?: string | null;
}): Promise<string> {
  const fieldDiffs = diffFields(input.draft, input.corrected);
  const row = await prisma.correctionExemplar.create({
    data: {
      firmId: input.firmId,
      caseId: input.caseId,
      encounterId: input.encounterId,
      documentType: input.documentType,
      category: input.category,
      guidance: guidanceFor(input.category, fieldDiffs),
      fieldDiffs: fieldDiffs as never,
      draftSnapshot: input.draft as never,
      correctedSnapshot: input.corrected as never,
      claimRefs: (input.claimRefs ?? []) as never,
      reviewerId: input.reviewerId,
      promptVersion: input.promptVersion ?? null,
      schemaVersion: input.schemaVersion ?? null,
      model: input.model ?? null,
    },
  });
  return row.id;
}

/**
 * Bounded, tenant-safe retrieval: at most `limit` DISTINCT fact-free guidance
 * sentences for this firm (never another firm), preferring the same document
 * type and promoted exemplars. Case-specific snapshots are never returned.
 */
export async function fetchExemplarGuidance(firmId: string, documentType: string | null, limit = 3): Promise<string[]> {
  if (!exemplarsEnabled()) return [];
  const rows = await prisma.correctionExemplar.findMany({
    where: { firmId, ...(documentType ? { OR: [{ documentType }, { documentType: null }] } : {}) },
    orderBy: [{ promoted: "desc" }, { verifiedAt: "desc" }],
    take: limit * 4,
    select: { guidance: true, documentType: true, promoted: true },
  });
  const ranked = rows.sort((a, b) => Number(b.documentType === documentType) - Number(a.documentType === documentType) || Number(b.promoted) - Number(a.promoted));
  return [...new Set(ranked.map((r) => r.guidance))].slice(0, limit);
}
