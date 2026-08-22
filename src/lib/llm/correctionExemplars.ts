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
import { retrieveGuidance, sanitizeGuidance } from "@/lib/learning/candidateService";

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
/**
 * Guidance for an extraction prompt: this firm's correction exemplars, plus any
 * lessons the controlled learning loop has actually ADOPTED.
 *
 * The two sources are deliberately joined here rather than given a channel of
 * their own. An exemplar is one reviewer's correction, recorded immediately;
 * an adopted lesson has survived held-out evaluation and a safety check. They
 * answer the same question — what should this prompt be told about this kind of
 * document — and a second, unrestricted prompt-memory path would be exactly the
 * thing that makes learned behaviour untraceable.
 *
 * Adopted lessons lead, because they have been measured. Everything is
 * firm-scoped, bounded in count, and sanitized before it is returned.
 */
export async function fetchExemplarGuidance(firmId: string, documentType: string | null, limit = 3): Promise<string[]> {
  const learned = await fetchAdoptedGuidance(firmId, documentType, limit).catch(() => []);
  const remaining = Math.max(0, limit - learned.length);
  if (!exemplarsEnabled() || remaining === 0) return learned.map((l) => l.text);
  const exemplars = await fetchRawExemplarGuidance(firmId, documentType, remaining);
  return [...learned.map((l) => l.text), ...exemplars];
}

/**
 * Adopted lessons for this firm and document class, with their candidate ids so
 * a caller can record which lessons shaped a given output.
 *
 * Both fact-free structural mechanisms are retrieved. TASK_GUIDANCE says what
 * to capture; SALIENCE_PREFERENCE says what should lead and what is
 * boilerplate. The second was being produced, evaluated and adopted and then
 * read by nothing, so approving one changed no output at all — an approval that
 * cannot change anything is not a control, it is a form.
 *
 * Task guidance leads, because it governs whether a fact is captured at all;
 * salience only orders facts that were. Both are sanitized and budgeted by
 * retrieveGuidance, and both are served only when ADOPTED.
 */
export async function fetchAdoptedGuidance(firmId: string, documentType: string | null, limit = 3) {
  const task = await retrieveGuidance({
    firmId,
    mechanism: "TASK_GUIDANCE",
    documentClass: documentType ?? undefined,
    limit,
  });
  const remaining = Math.max(0, limit - task.length);
  if (remaining === 0) return task;
  const salience = await retrieveGuidance({
    firmId,
    mechanism: "SALIENCE_PREFERENCE",
    documentClass: documentType ?? undefined,
    limit: remaining,
  });
  return [...task, ...salience];
}

async function fetchRawExemplarGuidance(firmId: string, documentType: string | null, limit: number): Promise<string[]> {
  const rows = await prisma.correctionExemplar.findMany({
    where: { firmId, ...(documentType ? { OR: [{ documentType }, { documentType: null }] } : {}) },
    orderBy: [{ promoted: "desc" }, { verifiedAt: "desc" }],
    take: limit * 4,
    select: { guidance: true, documentType: true, promoted: true },
  });
  const ranked = rows.sort((a, b) => Number(b.documentType === documentType) - Number(a.documentType === documentType) || Number(b.promoted) - Number(a.promoted));
  // Sanitized on the way out: the cheapest place to catch a lesson carrying
  // patient detail is immediately before it enters a prompt.
  return [...new Set(ranked.map((r) => sanitizeGuidance(r.guidance)).filter((g): g is string => !!g))].slice(0, limit);
}
