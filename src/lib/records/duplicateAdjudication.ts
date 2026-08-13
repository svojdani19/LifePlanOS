// ─────────────────────────────────────────────────────────────────────────────
// The pairs the rules cannot settle.
//
// One emergency visit reached the chronology twice: the hospital filed it under
// "ENGLISH, PAUL W" and the therapy practice under "Paul English, MD". Both
// name one man on one day, but each production described the visit in its own
// words — "Toradol, discharged home" against "x-rays showed no fractures,
// ibuprofen" — and word overlap never reached the bar.
//
// Lowering that bar was tried and rejected: a threshold loose enough to fold
// those two also folds the operative report with the discharge summary the same
// surgeon wrote that day, which the published plan lists separately. Losing a
// real record is worse than showing a duplicate.
//
// So the deterministic rules keep every decision they can make, and this reads
// only what they leave genuinely undecided — same day, same named clinician,
// compatible record types, partial agreement. That residue is small, bounded,
// and exactly the question a human would answer by reading both.
//
// Everything about this defers to the rules:
//
//   - it never separates what the rules merged, only merges what they left apart
//   - a pair must already be a candidate; it cannot volunteer new ones
//   - any failure, timeout, malformed answer or hesitation keeps them separate
//   - it runs on claim text that is already in the case, and returns a verdict
//     and a reason, never new clinical content
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { z } from "zod";
import { getProvider, type LlmProvider } from "@/lib/llm";
import { distinctiveOverlap, type IdentityFacts } from "@/lib/records/encounterIdentity";
import type { MergedEntry } from "@/lib/records/entryMerge";

/**
 * How the two records are attributed.
 *
 * The prompt asserted "both entries name the same clinician" for every pair,
 * which was false for the unattributed ones — the model was being told
 * something about the evidence that was not true, and answering on that basis.
 */
export type Attribution =
  /** Both name a clinician, and it is the same one. */
  | "SAME_CLINICIAN"
  /** Neither names anyone. */
  | "BOTH_UNATTRIBUTED"
  /** One names a clinician; the other names nobody. */
  | "ONE_ATTRIBUTED";

/** A pair the rules could not settle either way. */
export interface DuplicatePair {
  a: MergedEntry;
  b: MergedEntry;
  /** What is actually known about who wrote each. */
  attribution: Attribution;
  /** Why this pair is worth asking about, for the audit trail. */
  reason: string;
}

export type PairVerdict =
  | { same: true; confidence: "HIGH"; reason: string }
  | { same: false; reason: string };

/**
 * No agreement floor, deliberately.
 *
 * The first version required some measured overlap before asking, and that
 * gated out the exact case this exists for: the two accounts of one emergency
 * visit share ZERO distinctive facts as the extractor computes them, because
 * one says "Toradol, discharged home" and the other "x-rays showed no
 * fractures, ibuprofen". A residue with no measurable overlap is not a residue
 * worth skipping — it is the residue, and measuring it again with the same
 * instrument that already failed would answer the same way.
 *
 * What bounds this instead is the candidacy test itself: same day, same named
 * clinician, compatible record types, in different productions, and unsettled
 * by the rules. That is a small set on any real case, and MAX_PAIRS caps it.
 */
export const ASK_FLOOR = 0;

/** How many pairs one case may ask about, so a bad corpus cannot run away. */
export const MAX_PAIRS = 60;

/**
 * How alike two UNATTRIBUTED records must read before they are worth asking about.
 *
 * A named clinician on a shared date is itself a reason to ask. Without one
 * there is no such reason, and every pair of records sharing a date would
 * qualify — hundreds on a busy admission, none of them likely. So text
 * similarity selects the candidates here.
 *
 * This is a filter, not a finding. It decides which questions are worth the
 * asking; the answer still comes from reading both records.
 */
export const UNATTRIBUTED_SIMILARITY = 0.65;

/** Shared meaningful words below which a resemblance is not worth acting on. */
export const MIN_SHARED_TOKENS = 5;

/**
 * The bar for a pair where only one record names its clinician.
 *
 * Higher than for two unattributed records. "Neither names anyone" leaves the
 * question open; "one names Dr A and the other names nobody" carries a live
 * possibility that the unnamed one belongs to somebody else, so it needs more
 * agreement in the content before it is worth asking about.
 */
export const ONE_ATTRIBUTED_SIMILARITY = 0.8;

const STOP = new Set(["the", "a", "an", "of", "for", "with", "and", "to", "in", "on", "at", "was", "were", "is", "patient"]);

/**
 * Rough token similarity, for selecting questions rather than answering them.
 *
 * Divides by the UNION. The first version divided by the smaller set, which
 * scores a short record fully contained in a long one at 1.0 — so a one-line
 * note matched every long record that happened to mention the same words, and
 * the candidate set went from 5 pairs to more than 60, capped, at 60 model
 * calls a rebuild, without folding the duplicates it was built for.
 *
 * Measured on the case, the denominator was the whole problem: at the SAME
 * threshold, union scoring takes 60+ candidates down to 20. Between 0.65 and
 * 0.8 the count barely moves — 16 pairs against 14 — so the bar sits on a
 * plateau rather than a cliff, which is where a threshold should sit if it has
 * to sit anywhere.
 */
export function textSimilarity(a: string, b: string): { ratio: number; shared: number } {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return { ratio: 0, shared: 0 };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return { ratio: shared / (ta.size + tb.size - shared), shared };
}

const textOf = (entry: { claims: readonly { value: string }[] }) => entry.claims.map((c) => c.value).join(" ");

const verdictSchema = z.object({
  same_encounter: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().min(3).max(400),
});

/**
 * Pairs worth adjudicating, chosen deterministically.
 *
 * `sameNamed` and `settledByRules` are supplied by the caller so this module
 * cannot drift from the rules it defers to.
 */
export type CandidateList = DuplicatePair[] & { truncated?: boolean };

export function candidatePairs(
  entries: readonly MergedEntry[],
  deps: {
    sameNamedAuthor: (a: MergedEntry, b: MergedEntry) => boolean;
    /** Does this record name a clinician at all? */
    namesSomeone: (entry: MergedEntry) => boolean;
    settledByRules: (a: MergedEntry, b: MergedEntry) => boolean;
    factsOf: (entry: MergedEntry) => IdentityFacts;
    compatibleClass: (a: MergedEntry, b: MergedEntry) => boolean;
  },
): CandidateList {
  const pairs: CandidateList = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];

      // One day. An undated record has nothing to anchor a comparison to.
      if (!a.encounterDate || !b.encounterDate) continue;
      if (a.encounterDate.getTime() !== b.encounterDate.getTime()) continue;
      // Within a document the rules already have the note structure to work
      // with; this is for copies filed in separate productions.
      if (a.sourceDocumentId === b.sourceDocumentId) continue;
      if (!deps.compatibleClass(a, b)) continue;
      // Anything the rules can settle stays with the rules.
      if (deps.settledByRules(a, b)) continue;

      // Either a shared clinician, or — where neither record names one — enough
      // resemblance to make the question worth asking.
      const named = deps.sameNamedAuthor(a, b);
      const aNamed = deps.namesSomeone(a);
      const bNamed = deps.namesSomeone(b);

      // Two records naming DIFFERENT clinicians are two records. They never
      // enter any path here — least of all one that would describe them as
      // unattributed.
      if (!named && aNamed && bNamed) continue;

      const attribution: Attribution = named
        ? "SAME_CLINICIAN"
        : aNamed || bNamed
          ? "ONE_ATTRIBUTED"
          : "BOTH_UNATTRIBUTED";

      let similarity = 1;
      if (!named) {
        const resemblance = textSimilarity(textOf(a), textOf(b));
        // Both bars matter: the ratio rejects a long record that merely
        // contains a short one, and the token floor rejects two thin records
        // agreeing on three words. A half-attributed pair must clear a higher
        // bar, because "one record names nobody" is weaker evidence of one
        // event than "neither does" — an unnamed fragment could belong to any
        // clinician, including one other than the named record's.
        const floor = attribution === "ONE_ATTRIBUTED" ? ONE_ATTRIBUTED_SIMILARITY : UNATTRIBUTED_SIMILARITY;
        if (resemblance.ratio < floor || resemblance.shared < MIN_SHARED_TOKENS) continue;
        similarity = resemblance.ratio;
      }

      const overlap = distinctiveOverlap(deps.factsOf(a), deps.factsOf(b));
      if (overlap.ratio < ASK_FLOOR) continue;

      pairs.push({
        a,
        b,
        attribution,
        // Recorded for the audit trail, not used as a gate: it is the measure
        // that could not settle this pair in the first place.
        reason:
          attribution === "SAME_CLINICIAN"
            ? `same clinician and date in two productions, ${Math.round(overlap.ratio * 100)}% distinctive agreement`
            : attribution === "BOTH_UNATTRIBUTED"
              ? `neither record names a clinician; one date in two productions, ${Math.round(similarity * 100)}% textual resemblance`
              : `one record names a clinician and the other does not; one date in two productions, ${Math.round(similarity * 100)}% textual resemblance`,
      });
      if (pairs.length >= MAX_PAIRS) {
        // Hitting the cap means coverage is incomplete AND depends on iteration
        // order. Said out loud rather than truncated quietly: a silent cap
        // reads as "everything was checked".
        pairs.truncated = true;
        return pairs;
      }
    }
  }
  return pairs;
}

/**
 * What was decided about one pair, and on what basis.
 *
 * Aggregate counts cannot answer the question a reviewer will actually ask:
 * why did these two records become one? A merge changes what the plan says
 * happened to the patient, so the reasoning has to survive the rebuild that
 * produced it.
 *
 * Content hashes stand in for the text wherever they can. The claims are
 * already stored on the rows this references; copying them here would multiply
 * the PHI without adding anything a reviewer could not reach.
 */
export interface AdjudicationRecord {
  /** The rows behind each side, so a reviewer can open both. */
  aRowIds: string[];
  bRowIds: string[];
  aDocumentId: string;
  bDocumentId: string;
  /** Content identity, rather than another copy of the content. */
  aContentHash: string;
  bContentHash: string;
  /** The date and provider evidence the decision was taken on. */
  encounterDate: string | null;
  aProvider: string | null;
  bProvider: string | null;
  attribution: Attribution;
  /** Why the deterministic rules offered this pair. */
  candidacyReason: string;
  decision: "MERGED" | "KEPT_SEPARATE";
  confidence: "high" | "medium" | "low" | "none";
  explanation: string;
  provider: string | null;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  decidedAt: string;
}

/** Bumped when the prompt or the verdict shape changes, so old rows stay readable. */
export const ADJUDICATION_PROMPT_VERSION = "2026-08-12.attribution-aware";
export const ADJUDICATION_SCHEMA_VERSION = "1";

function contentHash(entry: MergedEntry): string {
  const text = entry.claims.map((c) => `${c.field}:${c.value}`).sort().join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export interface AdjudicationResult {
  /** Pairs judged to be one encounter, in the order they were asked. */
  merged: DuplicatePair[];
  /** Every verdict, including refusals, for the audit trail. */
  verdicts: { reason: string; verdict: PairVerdict }[];
  /** One durable record per pair, for the reviewer who asks why. */
  audit: AdjudicationRecord[];
  asked: number;
  failed: number;
}

/**
 * Ask which of the undecided pairs are one encounter.
 *
 * Concurrency is modest and the pair count is capped, because this runs once
 * per rebuild over a residue that should stay small. A growing residue is a
 * signal that the rules need work, not that this should scale.
 */
export async function adjudicateDuplicates(
  pairs: readonly DuplicatePair[],
  options: { provider?: LlmProvider; concurrency?: number; decidedAt?: string } = {},
): Promise<AdjudicationResult> {
  const result: AdjudicationResult = { merged: [], verdicts: [], audit: [], asked: 0, failed: 0 };
  if (!pairs.length) return result;

  let llm: LlmProvider;
  try {
    llm = options.provider ?? getProvider();
  } catch {
    // No provider configured: the rules' answer stands, which is separate.
    return result;
  }

  const concurrency = options.concurrency ?? 4;
  // One timestamp for the run: rows from one adjudication should sort together
  // rather than by whichever model call returned first.
  const decidedAt = options.decidedAt ?? new Date().toISOString();
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const verdicts = await Promise.all(batch.map((pair) => askOnePair(llm, pair, result)));
    batch.forEach((pair, index) => {
      const verdict = verdicts[index];
      result.verdicts.push({ reason: pair.reason, verdict });
      result.audit.push(auditRecordFor(pair, verdict, llm, decidedAt));
      if (verdict.same) result.merged.push(pair);
    });
  }
  return result;
}

function auditRecordFor(
  pair: DuplicatePair,
  verdict: PairVerdict,
  llm: LlmProvider,
  decidedAt: string,
): AdjudicationRecord {
  const named = llm as unknown as { name?: string; model?: string };
  return {
    aRowIds: pair.a.rowIds,
    bRowIds: pair.b.rowIds,
    aDocumentId: pair.a.sourceDocumentId,
    bDocumentId: pair.b.sourceDocumentId,
    aContentHash: contentHash(pair.a),
    bContentHash: contentHash(pair.b),
    encounterDate: pair.a.encounterDate?.toISOString().slice(0, 10) ?? null,
    aProvider: pair.a.provider,
    bProvider: pair.b.provider,
    attribution: pair.attribution,
    candidacyReason: pair.reason,
    decision: verdict.same ? "MERGED" : "KEPT_SEPARATE",
    confidence: verdict.same ? "high" : "none",
    explanation: verdict.reason,
    provider: named.name ?? null,
    model: named.model ?? null,
    promptVersion: ADJUDICATION_PROMPT_VERSION,
    schemaVersion: ADJUDICATION_SCHEMA_VERSION,
    decidedAt,
  };
}

async function askOnePair(llm: LlmProvider, pair: DuplicatePair, result: AdjudicationResult): Promise<PairVerdict> {
  result.asked++;
  try {
    const raw = await llm.complete({
      system: SYSTEM,
      messages: [{ role: "user", content: promptFor(pair) }],
      temperature: 0,
      maxTokens: 500,
    });
    const parsed = verdictSchema.safeParse(JSON.parse(extractJson(raw)));
    if (!parsed.success) {
      result.failed++;
      return { same: false, reason: "the adjudicator's answer did not match the required shape" };
    }
    // Only a confident yes merges. "Medium" on a question this consequential is
    // a no, and the pair stays visible for a reviewer.
    if (parsed.data.same_encounter && parsed.data.confidence === "high") {
      return { same: true, confidence: "HIGH", reason: parsed.data.reason };
    }
    return { same: false, reason: parsed.data.reason };
  } catch (error) {
    result.failed++;
    return { same: false, reason: `adjudication failed: ${String(error).slice(0, 120)}` };
  }
}

const SYSTEM = `You compare two medical record entries that a records-consolidation system could not tell apart or distinguish.

Both entries are dated the same day and come from two different record productions — for example a hospital's own chart and a copy subpoenaed by another practice. What is known about their authorship is stated in the message; rely on that and not on an assumption.

Decide whether they document THE SAME clinical encounter, or two different encounters that happen to share a clinician and a date.

They are the same encounter when the two texts describe one event in different words: the same presentation, the same findings, the same disposition, differing only in wording, detail or emphasis.

They are DIFFERENT encounters when the texts describe things that both happened but are distinct — an operation and the discharge that followed it, a morning clinic visit and an evening admission, a procedure and the imaging that preceded it. One clinician commonly writes several records in one day.

Answer "high" confidence only when a reviewer reading both would say without hesitation that they are one event. If the texts are consistent but you cannot tell whether they are one event or two, that is not high confidence.

Reply with JSON only:
{"same_encounter": true|false, "confidence": "high"|"medium"|"low", "reason": "<one sentence>"}`;

const ATTRIBUTION_SENTENCE: Record<Attribution, string> = {
  SAME_CLINICIAN: "Both records name the same clinician.",
  BOTH_UNATTRIBUTED: "Neither record names a clinician, so authorship is unknown for both. Do not assume they share an author.",
  ONE_ATTRIBUTED:
    "One record names a clinician and the other names nobody. The unattributed record may or may not be by that clinician; do not assume it is.",
};

function promptFor(pair: DuplicatePair): string {
  return [
    `Both records are dated ${pair.a.encounterDate?.toISOString().slice(0, 10)}.`,
    ATTRIBUTION_SENTENCE[pair.attribution],
    "",
    "RECORD A:",
    describe(pair.a),
    "",
    "RECORD B:",
    describe(pair.b),
    "",
    "Are these the same clinical encounter?",
  ].join("\n");
}

function describe(entry: MergedEntry): string {
  const head = [entry.provider, entry.facility].filter(Boolean).join(" · ");
  // Claim text only — already extracted, already in the case. Bounded so a
  // large record cannot crowd out the comparison.
  const claims = entry.claims
    .slice(0, 25)
    .map((c) => `- ${c.field}: ${c.value}`)
    .join("\n");
  return [head ? `(${head})` : "(no attribution)", claims].filter(Boolean).join("\n");
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}
