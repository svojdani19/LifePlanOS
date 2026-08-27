// ─────────────────────────────────────────────────────────────────────────────
// Which clean records still deserve a reader's eyes.
//
// "Ready to confirm" means no check fired — the audit passed, no source
// conflict, no contradicted field, no unresolved disagreement. It does NOT
// mean the extraction was right. The machine cannot flag what it never read,
// and measured on this corpus extraction recall runs 23.6–38.4% (see
// docs/31_LEARNING_LOOP.md), so a note can be clean on every field extracted
// while most of the page never reached it.
//
// That left the batch in an awkward place. Eighteen clean encounters behind a
// single click is either a reasonable disclosure or a rubber stamp, depending
// entirely on whether the reviewer read the manifest — and nothing about the
// surface distinguished the two. Weighting fixes the surface, not the
// signature: it says WHICH of the clean records carry enough residual
// uncertainty to be worth opening the cited page for.
//
// THREE RULES, and they are what keep this honest:
//
//   • It only ever ADDS scrutiny. A weight is computed for notes that are
//     ALREADY clean and awaiting attestation, and the only thing it can do is
//     pull one OUT of the light batch. Nothing here can promote a record into
//     a batch it did not already qualify for, so a scoring bug cannot launder
//     an exception into a confirmation.
//
//   • It writes nothing and decides nothing. A human still confirms, and the
//     row still becomes REVIEWED by their action. `humanAuthoritative()` keeps
//     meaning what it says. This module changes the order and the framing of
//     the work, never its authority.
//
//   • It always says why. A tier with no reasons is another opaque score, and
//     a reviewer cannot act on "this one is riskier". Every note that lands in
//     NEEDS_EYES carries the specific signals that put it there, phrased as
//     something a person can go and check.
//
// Deterministic and hash-free: thresholds are named constants, the output is a
// pure function of the note, and nothing is persisted. Re-running it on the
// same note yields the same tier forever, which is what lets a test pin it.
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of a `ReviewableNote` this scorer reads. Structural, so the
 *  module imports no Prisma and no server record builder. */
export interface RiskWeighable {
  id: string;
  rowIds?: readonly string[];
  claims?: readonly { confidence?: number | null; warning?: string | null }[] | null;
  claimCount?: number | null;
  rows?: readonly { ocrConfidence?: number | null; warnings?: unknown }[] | null;
  crossDocumentMembers?: readonly unknown[] | null;
  copies?: readonly unknown[] | null;
  corroboration?: { result?: string | null; reproduced?: number | null; total?: number | null } | null;
  fragmentDisagreement?: readonly string[] | null;
  membershipBasis?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  /** Only a note already awaiting attestation is weighable. */
  awaitingAttestation?: boolean | null;
  attention?: string | null;
}

export type RiskTier = "LOW_RISK" | "NEEDS_EYES";

export interface RiskSignal {
  /** Stable code, for counting and for tests. */
  code: string;
  /** What a reviewer should go and check, in their words. */
  reason: string;
}

export interface RiskWeight {
  tier: RiskTier;
  /** Every signal that fired, in a stable order. Empty for LOW_RISK. */
  signals: RiskSignal[];
}

// ── Thresholds ───────────────────────────────────────────────────────────────
//
// Deliberately conservative: when a threshold is arguable, it is set so the
// note lands in NEEDS_EYES. Sending a safe record to a human costs a glance;
// keeping an unsafe one in the light batch costs the thing the batch exists to
// protect. These are the numbers a calibration pass should move, and moving
// them is a one-line change with a test that fails loudly.

/**
 * A single claim below this is weak enough to want the page open.
 *
 * ON A 0–1 SCALE, because that is what `ExtractedEncounter.claims[].confidence`
 * actually holds — measured across 82,389 claims on this corpus: min 0.6,
 * median 1.0, p05 0.85, p01 0.70. The first version of this file used 70,
 * borrowed from the `Int @default(50) // 0–100` columns elsewhere in the
 * schema, and consequently read a PERFECT 1.0 as a catastrophic 1 and flagged
 * every record in the batch. `normalizeConfidence` below now rejects that
 * mistake instead of silently inverting the score.
 *
 * 0.80 sits between p01 and p05: a value the extractor itself put in the
 * bottom ~2% of everything it produced.
 */
export const WEAK_CLAIM_CONFIDENCE = 0.8;
/** OCR below this has misread enough characters to matter. Null (native text
 *  layer) is NOT low confidence — it was never OCR'd and is not guessed at. */
export const WEAK_OCR_CONFIDENCE = 0.85;
/** Below this many claims, "clean" is an assertion about very little. */
export const THIN_EVIDENCE_CLAIMS = 3;
/** A note consolidating more than this many rows had more chances to misjoin. */
export const WIDE_CONSOLIDATION_ROWS = 4;

/** Membership the records builder did not itself establish. */
const DERIVED_MEMBERSHIP = new Set(["COMPATIBILITY_FALLBACK", "UNVERIFIABLE_DOCUMENT"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A claim confidence as a 0–1 fraction, whatever scale it arrived on.
 *
 * The schema carries BOTH conventions — `claims[].confidence` is a 0–1 float
 * while several `confidence Int @default(50) // 0–100` columns are percentages
 * — and reading one as the other silently inverts the verdict. Anything above
 * 1 is treated as a percentage; anything outside both ranges is discarded
 * rather than guessed at, because a fabricated confidence is exactly what the
 * page-quality model refuses to do ("never a fabricated 0.96").
 */
export function normalizeConfidence(v: unknown): number | null {
  const n = num(v);
  if (n == null || n < 0) return null;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/**
 * Weigh one clean note.
 *
 * Returns LOW_RISK with no signals for a note nothing fired on. A note that is
 * not awaiting attestation is not weighable at all — it is an exception or a
 * caution and belongs in the queue on its own merits — and is reported as
 * NEEDS_EYES so that a caller who weighs the wrong set cannot quietly batch it.
 */
export function weighNote(note: RiskWeighable): RiskWeight {
  const signals: RiskSignal[] = [];
  const add = (code: string, reason: string) => signals.push({ code, reason });

  // Guard. Only a clean, attestable note is a candidate for the light batch.
  if (note.awaitingAttestation !== true || (note.attention != null && note.attention !== "CLEAN")) {
    return { tier: "NEEDS_EYES", signals: [{ code: "NOT_ATTESTABLE", reason: "This record is not clean and needs its own decision." }] };
  }

  // ── Extraction confidence ──────────────────────────────────────────────
  const claims = list(note.claims) as { confidence?: number | null; warning?: string | null }[];
  const confidences = claims.map((c) => normalizeConfidence(c?.confidence)).filter((n): n is number => n != null);
  const weakest = confidences.length ? Math.min(...confidences) : null;
  if (weakest != null && weakest < WEAK_CLAIM_CONFIDENCE) {
    add("WEAK_CLAIM", `An extracted value scored ${Math.round(weakest * 100)}% for confidence — read the cited page and check it.`);
  }
  if (claims.some((c) => typeof c?.warning === "string" && c.warning.length > 0)) {
    add("CLAIM_WARNING", "The extractor attached a warning to one of the values it took from this record.");
  }

  // ── Page quality ───────────────────────────────────────────────────────
  const rows = list(note.rows) as { ocrConfidence?: number | null; warnings?: unknown }[];
  const ocr = rows.map((r) => num(r?.ocrConfidence)).filter((n): n is number => n != null);
  const worstOcr = ocr.length ? Math.min(...ocr) : null;
  if (worstOcr != null && worstOcr < WEAK_OCR_CONFIDENCE) {
    add("WEAK_OCR", `The page was read by OCR at ${Math.round(worstOcr * 100)}% confidence — characters may be wrong.`);
  }
  if (rows.some((r) => list(r?.warnings).length > 0)) {
    add("EXTRACTION_WARNING", "Extraction recorded a warning about the source page.");
  }

  // ── How much this record actually asserts ──────────────────────────────
  const claimCount = num(note.claimCount) ?? claims.length;
  if (claimCount < THIN_EVIDENCE_CLAIMS) {
    add("THIN_EVIDENCE", `Only ${claimCount} value${claimCount === 1 ? "" : "s"} were extracted here — a clean grade over very little content.`);
  }

  // ── How the record was assembled ───────────────────────────────────────
  const rowCount = list(note.rowIds).length || rows.length;
  if (rowCount > WIDE_CONSOLIDATION_ROWS) {
    add("WIDE_CONSOLIDATION", `${rowCount} extracted fragments were joined into this one record — confirm they belong together.`);
  }
  if (list(note.fragmentDisagreement).length > 0) {
    const fields = (note.fragmentDisagreement ?? []).join(", ");
    add("FRAGMENT_DISAGREEMENT", `The fragments of this record disagree about ${fields}, even though none of it was material.`);
  }
  if (list(note.crossDocumentMembers).length > 0 || list(note.copies).length > 0) {
    add("CROSS_DOCUMENT", "The same record appears in more than one document — confirm the copies are the same encounter.");
  }
  if (note.membershipBasis != null && DERIVED_MEMBERSHIP.has(note.membershipBasis)) {
    add("DERIVED_MEMBERSHIP", "Which fragments make up this record was derived here, not established by the records builder.");
  }

  // ── Independent re-read ────────────────────────────────────────────────
  const corr = note.corroboration ?? null;
  if (corr) {
    const reproduced = num(corr.reproduced);
    const total = num(corr.total);
    if (reproduced != null && total != null && total > 0 && reproduced < total) {
      add("PARTIAL_CORROBORATION", `A blind second read reproduced ${reproduced} of ${total} fields — the rest it read differently.`);
    }
  }

  return { tier: signals.length ? "NEEDS_EYES" : "LOW_RISK", signals };
}

export interface RiskSplit<T> {
  lowRisk: T[];
  needsEyes: { note: T; weight: RiskWeight }[];
  /** Signal codes across `needsEyes`, most frequent first. */
  topSignals: { code: string; reason: string; count: number }[];
}

/**
 * Partition an already-clean batch into the light batch and the read-me set.
 *
 * The input is expected to be exactly the notes the batch would have confirmed
 * in one click. The output is the same set, split — no note is dropped, which
 * a test pins, because a triage that loses records is worse than no triage.
 */
export function splitByRisk<T extends RiskWeighable>(notes: readonly T[]): RiskSplit<T> {
  const lowRisk: T[] = [];
  const needsEyes: { note: T; weight: RiskWeight }[] = [];
  for (const n of notes) {
    const weight = weighNote(n);
    if (weight.tier === "LOW_RISK") lowRisk.push(n);
    else needsEyes.push({ note: n, weight });
  }

  const byCode = new Map<string, { code: string; reason: string; count: number }>();
  for (const { weight } of needsEyes) {
    for (const s of weight.signals) {
      const seen = byCode.get(s.code);
      if (seen) seen.count += 1;
      else byCode.set(s.code, { code: s.code, reason: s.reason, count: 1 });
    }
  }
  // Ties broken by code so the order is stable across runs.
  const topSignals = [...byCode.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return { lowRisk, needsEyes, topSignals };
}

/** How the split is described above the batch. Says both numbers and the
 *  grain, because "14 low risk" alone invites the reading that the other four
 *  are problems — they are not, they are clean records worth a glance. */
export function riskSentence(lowRisk: number, needsEyes: number): string {
  const total = lowRisk + needsEyes;
  if (total === 0) return "No records are ready to confirm.";
  if (needsEyes === 0) return `All ${total} ready record${total === 1 ? "" : "s"} scored low risk.`;
  if (lowRisk === 0) {
    return `All ${total} ready record${total === 1 ? "" : "s"} carry a residual-uncertainty signal worth reading before confirming.`;
  }
  return `${lowRisk} of ${total} ready records scored low risk; ${needsEyes} carr${needsEyes === 1 ? "ies" : "y"} a residual-uncertainty signal worth reading first.`;
}
