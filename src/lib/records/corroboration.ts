// ─────────────────────────────────────────────────────────────────────────────
// Machine corroboration: independent reproduction, not self-agreement.
//
// The pipeline's existing checks — excerpt grounding, the critic, the
// adversarial audit — all examine ONE extraction's output. The program
// agreeing with itself is deliberately not review, and none of it can promote
// a row past "pending human review".
//
// Corroboration is a different kind of evidence: a second model reads the
// row's source span BLIND — it never sees the stored claims — and states the
// facts it finds. The server then compares deterministically. A row whose
// facts an independent reading reproduces is MACHINE-CORROBORATED: still not
// verified (no human has attested to it, and this tier can never set
// VERIFIED or satisfy the review gate), but honestly stronger than a draft
// only its own extraction stands behind — and the review queue may say so.
//
// Discipline, same as every adjudicator here:
//   - candidacy is deterministic and strict; rows with warnings, inferred
//     dates, demoted claims or inexact excerpts never reach the model
//   - the reader is blind; it cannot be led by the claims it is checking
//   - comparison is server-side and deterministic
//   - any failure, timeout or malformed answer records nothing — the row
//     simply stays where it was, in the human queue
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { getProvider, type LlmProvider } from "@/lib/llm";
import { pageMarks } from "@/lib/documents/meta";

export const CORROBORATION_PROMPT_VERSION = "2026-08-14.blind-reproduction";

/**
 * The COMPARATOR's version, bumped whenever grading changes.
 *
 * A verdict is only as good as the rules that produced it. The first
 * comparator could grade a negated finding as reproduced, so verdicts it
 * wrote must not stand on the strength of a rule that no longer exists:
 * anything graded under an older version is regraded rather than trusted.
 */
export const CORROBORATION_COMPARATOR_VERSION = "2026-08-15.discriminant-gate.2";

/**
 * What this tier may honestly be called.
 *
 * The reader is BLIND — it never sees the stored claims — which is the
 * substantive part. It is not necessarily a DIFFERENT model: unless
 * RECORD_CORROBORATION_MODEL names one, it is the same provider that produced
 * the extraction, and calling that "independent" overstated the separation.
 * The label follows the configuration rather than the aspiration.
 */
export const corroborationLabel = (distinctModel: boolean): string =>
  distinctModel ? "independent second reading" : "blind second reading";

/** A separately configured model for the second pass, when one is set. */
export const configuredCorroborationModel = (): string | null => process.env.RECORD_CORROBORATION_MODEL?.trim() || null;

export interface CorroborationClaim {
  field: string;
  value: string;
  excerpt: string;
  warning?: string | null;
}

export interface CorroborationRow {
  id: string;
  status: string;
  dateStatus: string | null;
  page: number | null;
  pageEnd: number | null;
  warnings: unknown;
  claims: unknown;
}

export interface CorroborationVerdict {
  result: "CORROBORATED" | "NOT_CORROBORATED";
  at: string;
  /** The model that actually read the source; never a guess. */
  model: string;
  /** True only when a separately configured model performed the re-read. */
  distinctModel: boolean;
  promptVersion: string;
  /** The grading rules that produced this verdict. */
  comparatorVersion: string;
  /** The source bytes the re-read was performed against. */
  sourceFingerprint: string | null;
  /** How many stored claims the independent reading reproduced. */
  reproduced: number;
  total: number;
  /** Field names only — PHI never travels in the verdict. */
  unreproducedFields: string[];
}

const claimsOf = (row: CorroborationRow): CorroborationClaim[] =>
  Array.isArray(row.claims) ? (row.claims as CorroborationClaim[]).filter((c) => c && typeof c.value === "string") : [];

/**
 * The deterministic bar. Only rows that are already clean on every check the
 * server can make alone are worth an independent read: the audit passed, the
 * date was read off the document, no claim was demoted or flagged, and every
 * excerpt is found VERBATIM in the source text — a fuzzy-matched excerpt is a
 * reviewer's question, not a corroboration candidate.
 *
 * Note on excerpt LENGTH: there is deliberately no minimum. The ≥12-character
 * floor belongs to fuzzy matching, where a short string can fall inside an
 * edit budget by coincidence; here the test is exact containment, and an exact
 * hit on "99233" or "$3,275.00" is a real citation. Carrying the floor over
 * excluded every billing row in the corpus — eleven of seventeen candidates on
 * the first live run — for a reason that did not apply.
 */
export function meetsCorroborationBar(row: CorroborationRow, docText: string): boolean {
  if (row.status !== "AI_AUDIT_PASSED") return false;
  if (row.dateStatus !== "DOCUMENTED") return false;
  if (Array.isArray(row.warnings) && row.warnings.length > 0) return false;
  const claims = claimsOf(row);
  if (!claims.length) return false;
  return claims.every((c) => !c.warning && typeof c.excerpt === "string" && c.excerpt.trim().length > 0 && docText.includes(c.excerpt));
}

/** The source span the row's pages cover, bounded; the whole text as fallback. */
export function spanTextFor(row: CorroborationRow, docText: string, cap = 14_000): string {
  const marks = pageMarks(docText);
  const first = row.page;
  if (first != null && marks.length) {
    const last = row.pageEnd ?? first;
    const start = marks.find((m) => m.page === first)?.offset ?? 0;
    const after = marks.find((m) => m.page === last + 1)?.offset ?? docText.length;
    if (after > start) return docText.slice(start, Math.min(after, start + cap));
  }
  // No usable page markers: anchor on the first excerpt.
  const anchor = claimsOf(row)[0]?.excerpt;
  const at = anchor ? docText.indexOf(anchor) : -1;
  if (at >= 0) return docText.slice(Math.max(0, at - cap / 2), at + cap / 2);
  return docText.slice(0, cap);
}

const STOP = new Set(["the", "and", "was", "were", "with", "for", "his", "her", "their", "has", "had", "have", "this", "that", "from", "into", "onto", "patient"]);

const tokensOf = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );

// ── Discriminants: the features that may never be approximated ───────────────
//
// Token overlap alone certified the OPPOSITE of the record. "no acute
// fracture" and "acute fracture" share every token the comparison could see,
// because a two-letter word was filtered out as noise before the two
// statements were compared — so a negated finding corroborated its positive.
// "Gabapentin 10 mg" and "Gabapentin 100 mg" agreed for the same reason: the
// numbers were tokens like any other, and one differing token stayed above a
// 70% bar.
//
// So these features are extracted and compared EXACTLY, before any semantic
// comparison runs. They are the ones where being approximately right is being
// wrong: whether a thing was found or ruled out, which side of the body,
// which anatomy, when, how much, and whether care was delivered or only
// proposed.

// NOTE: the boolean discriminants are tested with NON-GLOBAL patterns on
// purpose. `RegExp.test` on a /g regex advances lastIndex and is therefore
// stateful across calls — the same statement answered differently on
// alternate invocations, which silently flipped negation and
// delivered-versus-proposed. Only the set extractors below use /g, and they
// use matchAll, which does not share that hazard.
const NEGATION_SRC =
  String.raw`\b(?:no|not|non|none|negative|without|absent|denies|denied|deny|ruled out|r/o|unremarkable|nil|never|declined|refused|discontinued|stopped|withheld)\b`;
const STATUS_PLANNED_SRC = String.raw`\b(?:recommend\w*|plan\w*|propos\w*|advis\w*|schedul\w*|consider\w*|offer\w*|candidate for)\b`;
const STATUS_DONE_SRC =
  String.raw`\b(?:perform\w*|complet\w*|underwent|administered|administer|given|received|inject(?:ed|ion\s+was\s+(?:given|performed))|excised|repaired|resected|delivered|done)\b`;
const NEGATION_TEST = new RegExp(NEGATION_SRC, "i");
const STATUS_PLANNED_TEST = new RegExp(STATUS_PLANNED_SRC, "i");
const STATUS_DONE_TEST = new RegExp(STATUS_DONE_SRC, "i");
const LATERALITY_RE = /\b(?:left|right|bilateral|lft|rt|unilateral)\b/gi;
const ANATOMY_RE =
  /\b(?:c[1-8]|t(?:1[0-2]|[1-9])|l[1-5]|s[1-5])(?:\s*-\s*(?:c[1-8]|t(?:1[0-2]|[1-9])|l[1-5]|s[1-5]))?\b|\b(?:cervical|thoracic|lumbar|lumbosacral|sacral|coccyx|knee|hip|shoulder|ankle|wrist|elbow|foot|hand|neck|back|head|brain|chest|abdomen)\b/gi;
const DATE_RE = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g;
/** A number, with its unit when one follows — "10 mg" and "100 mg" differ. */
const QUANTITY_RE = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\b/g;
/** "1,000.00", "1000.00" and "1000" are one amount, not three. */
const normalizeNumber = (raw: string): string => {
  const plain = raw.replace(/,/g, "");
  return plain.includes(".") ? plain.replace(/0+$/, "").replace(/\.$/, "") : plain;
};
/**
 * Counts written as words. Records say "two views" as readily as "2 views",
 * and a comparison that only saw digits let "Two views" corroborate against
 * "Three views" — found by the safeguard-claims suite on its first run.
 * Normalized to digits so "two views" and "2 views" still agree.
 */
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};
// Only when the word QUANTIFIES something ("two views"), never the pronoun
// use ("one of the notes"), which would fire on ordinary prose.
const NUMBER_WORD_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?!of\b)(?=[a-z])/gi;

const setOf = (s: string, re: RegExp): Set<string> => {
  const out = new Set<string>();
  for (const m of s.toLowerCase().matchAll(re)) out.add(m[0].replace(/\s+/g, "").replace(/,/g, ""));
  return out;
};

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** The safety-critical features of a statement, for exact comparison. */
export function discriminantsOf(text: string): {
  negated: boolean;
  laterality: Set<string>;
  anatomy: Set<string>;
  dates: Set<string>;
  quantities: Set<string>;
  planned: boolean;
  performed: boolean;
} {
  const lower = text.toLowerCase();
  return {
    negated: NEGATION_TEST.test(lower),
    laterality: setOf(text, LATERALITY_RE),
    anatomy: setOf(text, ANATOMY_RE),
    dates: setOf(text, DATE_RE),
    quantities: new Set([
      ...[...text.matchAll(QUANTITY_RE)].map((m) => normalizeNumber(m[0])),
      ...[...text.toLowerCase().matchAll(NUMBER_WORD_RE)].map((m) => NUMBER_WORDS[m[1]]),
    ]),
    planned: STATUS_PLANNED_TEST.test(lower),
    performed: STATUS_DONE_TEST.test(lower),
  };
}

/**
 * Do two statements agree on every feature that may not be approximated?
 *
 * Deliberately asymmetric on ANATOMY and DATES: an independent reading may
 * state a fact in a fuller sentence that mentions more anatomy or carries the
 * encounter date, and that is not disagreement. What is forbidden is the
 * claim asserting something the reading does not contain — and, for negation,
 * laterality and delivered-versus-proposed status, any difference at all.
 */
export function discriminantsAgree(claimValue: string, fact: string): boolean {
  const c = discriminantsOf(claimValue);
  const f = discriminantsOf(fact);
  if (c.negated !== f.negated) return false;
  // DELIVERED-versus-not is the discriminant that matters, and it catches the
  // dangerous direction both ways: care recorded as performed against a
  // reading that only proposes it, and the reverse. Comparing "planned"
  // separately does not — an independent reading naturally paraphrases a plan
  // claim as "the plan is to…", which is agreement, not contradiction.
  if (c.performed !== f.performed) return false;
  if (!sameSet(c.laterality, f.laterality)) return false;
  // Every quantity the CLAIM asserts must appear in the reading, exactly.
  // Directional on purpose: a reading that states the amount alongside a date
  // and a code has not disagreed about the amount, and demanding set equality
  // rejected every billing row in the corpus. The dangerous direction is
  // still closed — "10 mg" is not among {100 mg}, so it cannot pass.
  for (const q of c.quantities) if (!f.quantities.has(q)) return false;
  // Every anatomy and date the CLAIM asserts must appear in the reading.
  for (const a of c.anatomy) if (!f.anatomy.has(a)) return false;
  for (const d of c.dates) if (!f.dates.has(d)) return false;
  return true;
}

/**
 * Is a stored claim's substance present in the independent reading?
 *
 * Two gates, in order. The reading must agree on every discriminant above —
 * exactly — and only then may wording differ: some single reproduced fact
 * must also cover at least 70% of the claim's distinctive tokens.
 */
export function claimReproduced(claimValue: string, facts: readonly string[]): boolean {
  const claim = tokensOf(claimValue);
  if (!claim.size) return false;
  const needed = Math.ceil(claim.size * 0.7);
  return facts.some((fact) => {
    if (!discriminantsAgree(claimValue, fact)) return false;
    const have = tokensOf(fact);
    let covered = 0;
    for (const t of claim) if (have.has(t)) covered++;
    return covered >= needed;
  });
}

const readingSchema = z.object({
  facts: z.array(z.object({ statement: z.string().min(3).max(500) })).max(80),
});

const SYSTEM = `You are reading an excerpt of a medical record production. Independently list every distinct fact the text states about the patient's encounters: dates of service, providers, facilities, complaints, findings, diagnoses, procedures, treatments, medications, dispositions, work status, and billed services.

State each fact in one plain sentence, staying strictly within what the text says. Do not interpret, do not summarize across facts, do not add anything the text does not state. Include administrative facts (forms, consents, billing lines) as stated.

Reply with JSON only:
{"facts": [{"statement": "<one fact>"}, ...]}`;

const extractJson = (raw: string): string => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
};

export interface CorroborationOutcome {
  candidates: number;
  asked: number;
  corroborated: number;
  failed: number;
  /** Verdicts by row id, only for rows that were asked about successfully. */
  verdicts: Map<string, CorroborationVerdict>;
}

/**
 * Corroborate a document's qualifying rows against an independent reading.
 *
 * One blind read per row's span; the comparison is entirely server-side.
 * Never throws; every failure leaves the row unrecorded and in the queue.
 */
export async function corroborateRows(
  rows: readonly CorroborationRow[],
  docText: string,
  options: { provider?: LlmProvider; concurrency?: number; model?: string | null; sourceFingerprint?: string | null } = {},
): Promise<CorroborationOutcome> {
  const candidates = rows.filter((r) => meetsCorroborationBar(r, docText));
  const outcome: CorroborationOutcome = { candidates: candidates.length, asked: 0, corroborated: 0, failed: 0, verdicts: new Map() };
  if (!candidates.length) return outcome;

  let llm: LlmProvider;
  try {
    llm = options.provider ?? getProvider();
  } catch {
    return outcome; // no provider: nothing recorded, the human queue stands
  }

  const concurrency = options.concurrency ?? 3;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (row) => {
        outcome.asked++;
        try {
          const raw = await llm.complete({
            system: SYSTEM,
            messages: [{ role: "user", content: spanTextFor(row, docText) }],
            temperature: 0,
            maxTokens: 4000,
          });
          const parsed = readingSchema.safeParse(JSON.parse(extractJson(raw)));
          if (!parsed.success) {
            outcome.failed++;
            return;
          }
          const facts = parsed.data.facts.map((f) => f.statement);
          const claims = claimsOf(row);
          const unreproduced = claims.filter((c) => !claimReproduced(c.value, facts));
          const verdict: CorroborationVerdict = {
            result: unreproduced.length === 0 ? "CORROBORATED" : "NOT_CORROBORATED",
            at: new Date().toISOString(),
            // The resolved model, passed in by the caller that configured the
            // provider. Reading it off the provider produced "unknown" on
            // every production row, because LlmProvider carries no model.
            model: options.model ?? (llm as { model?: string }).model ?? "unrecorded",
            distinctModel: Boolean(configuredCorroborationModel()),
            promptVersion: CORROBORATION_PROMPT_VERSION,
            comparatorVersion: CORROBORATION_COMPARATOR_VERSION,
            sourceFingerprint: options.sourceFingerprint ?? null,
            reproduced: claims.length - unreproduced.length,
            total: claims.length,
            unreproducedFields: [...new Set(unreproduced.map((c) => c.field))].slice(0, 20),
          };
          if (verdict.result === "CORROBORATED") outcome.corroborated++;
          outcome.verdicts.set(row.id, verdict);
        } catch {
          outcome.failed++;
        }
      }),
    );
  }
  return outcome;
}
