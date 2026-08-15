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
  model: string;
  promptVersion: string;
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

/**
 * Is a stored claim's substance present in the independent reading?
 * Deterministic: some single reproduced fact must cover at least 70% of the
 * claim's distinctive tokens. Wording may differ; the facts may not.
 */
export function claimReproduced(claimValue: string, facts: readonly string[]): boolean {
  const claim = tokensOf(claimValue);
  if (!claim.size) return false;
  const needed = Math.ceil(claim.size * 0.7);
  return facts.some((fact) => {
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
  options: { provider?: LlmProvider; concurrency?: number } = {},
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
            model: (llm as { model?: string }).model ?? "unknown",
            promptVersion: CORROBORATION_PROMPT_VERSION,
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
