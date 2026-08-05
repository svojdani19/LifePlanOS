// ─────────────────────────────────────────────────────────────────────────────
// Synthesis that cannot say anything the claims do not support.
//
// The model is given ONLY validated claims and asked to write prose plus a
// machine-readable map from each sentence to the claim ids supporting it. Every
// sentence is then checked deterministically. A sentence that fails is not
// edited or excused — the whole synthesis is retried once with the reasons,
// and if it fails again the encounter falls back to a deterministic rendering
// straight from the claims.
//
// The fallback is the point: there is always a correct thing to show, so the
// system is never under pressure to accept prose it cannot verify.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { getProvider, type LlmProvider } from "@/lib/llm";
import { CERTAINTY_RE, HEDGE_RE, COMPLETED_TYPES, NOT_DELIVERED_TYPES } from "@/lib/llm/claimTypes";
import { splitSentences } from "@/lib/llm/factualAudit";

export const SYNTHESIS_PROMPT_VERSION = "rex-synth-1.0";

export interface SynthClaim {
  id: string;
  field: string;
  claimType?: string;
  value: string;
  excerpt: string;
  page: number | null;
}

const synthesisSchema = z
  .object({
    sentences: z
      .array(
        z
          .object({
            text: z.string().min(3).max(400),
            claimIds: z.array(z.string().max(64)).min(1).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

export interface SynthesisResult {
  text: string | null;
  sentenceClaimMap: Record<string, string[]>;
  rejections: string[];
  /** True when the deterministic fallback produced the text. */
  fallback: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const LATERALITY_RE = /\b(left|right|bilateral)\b/gi;
const DATE_RE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g;

/**
 * Check ONE sentence against the claims it cites. Returns a rejection reason,
 * or null when the sentence is fully supported.
 */
export function checkSentence(sentence: string, claimIds: string[], byId: Map<string, SynthClaim>): string | null {
  const cited = claimIds.map((id) => byId.get(id)).filter((c): c is SynthClaim => !!c);
  if (cited.length !== claimIds.length) return "cites a claim id that is not part of this encounter";
  if (!cited.length) return "has no supporting claim";

  const support = norm(cited.map((c) => `${c.value} ${c.excerpt}`).join(" "));
  const s = norm(sentence);

  // Laterality may not be introduced or switched.
  for (const side of new Set((sentence.match(LATERALITY_RE) ?? []).map((x) => x.toLowerCase()))) {
    if (!support.includes(side)) return `states "${side}" laterality that the cited claims do not support`;
  }
  // No new dates.
  for (const d of sentence.match(DATE_RE) ?? []) {
    if (!support.includes(norm(d))) return "introduces a date the cited claims do not contain";
  }
  // No new numbers (dosages, measurements, counts).
  for (const n of sentence.match(/\b\d+(?:\.\d+)?\b/g) ?? []) {
    if (!support.includes(` ${n} `) && !support.startsWith(`${n} `) && !support.endsWith(` ${n}`) && !support.includes(n)) {
      return `introduces the figure "${n}" that the cited claims do not contain`;
    }
  }
  // No new proper names (providers, facilities).
  for (const name of sentence.match(/\b[A-Z][a-z]{2,} [A-Z][a-z]{2,}\b/g) ?? []) {
    if (!support.includes(norm(name))) return `introduces the name "${name}" that the cited claims do not contain`;
  }
  // Certainty may not be manufactured, and the record's hedging may not be dropped.
  if (CERTAINTY_RE.test(sentence) && !CERTAINTY_RE.test(cited.map((c) => c.excerpt).join(" "))) {
    return "asserts certainty the cited claims do not express";
  }
  if (cited.every((c) => HEDGE_RE.test(c.excerpt)) && !HEDGE_RE.test(sentence)) {
    return "drops the hedging the cited source expresses";
  }
  // Contemplated care may not be narrated as delivered.
  const performedLanguage = /\b(?:underwent|was performed|were performed|received|administered|had (?:a |an )?(?:surgery|procedure|injection))\b/i;
  if (performedLanguage.test(sentence) && cited.every((c) => NOT_DELIVERED_TYPES.has(c.claimType ?? ""))) {
    return "describes care as delivered when the cited claims record it only as recommended or planned";
  }
  // A recommendation may not be narrated as a completed fact either way round.
  const recommendLanguage = /\b(?:recommended|advised|planned|scheduled)\b/i;
  if (recommendLanguage.test(sentence) && cited.every((c) => COMPLETED_TYPES.has(c.claimType ?? ""))) {
    return "describes delivered care as merely recommended";
  }
  return null;
}

/** Deterministic rendering used when synthesis cannot be verified. */
export function deterministicSummary(claims: SynthClaim[]): string {
  const parts = claims.slice(0, 6).map((c) => `${c.value.replace(/\s+$/, "").replace(/\.$/, "")}`);
  return parts.length ? `${parts.join(". ")}.` : "No reliable clinical summary could be generated from the available extracted text. Source review is required.";
}

function buildPrompt(claims: SynthClaim[]): { system: string; user: string } {
  const system = [
    `You write a short, neutral factual summary of ONE clinical encounter. Synthesis prompt version ${SYNTHESIS_PROMPT_VERSION}.`,
    `You may use ONLY the validated claims supplied below. You may not add any fact, name, date, figure, diagnosis, procedure or treatment that is not in them, and you may not consult outside medical knowledge.`,
    `Preserve exactly what the claims say: keep hedging ("possible", "suggestive of") as hedging, keep negatives as negatives, keep recommended care as recommended, and keep delivered care as delivered.`,
    `Return ONLY: {"sentences":[{"text":"one sentence","claimIds":["id",...]}]}. Every sentence must list the claim ids that support it. A sentence you cannot attribute must not be written.`,
  ].join("\n\n");
  const user = `VALIDATED CLAIMS (the only permitted content):\n${claims
    .map((c) => `[${c.id}] (${c.field}${c.claimType ? `/${c.claimType}` : ""}) ${c.value}  ⟵ "${c.excerpt.slice(0, 200)}"`)
    .join("\n")}`;
  return { system, user };
}

function parseJson(raw: string): unknown {
  return JSON.parse(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, ""),
  );
}

/**
 * Synthesize an encounter summary. One retry with the specific rejections,
 * then deterministic fallback. Never returns unverified prose.
 */
export async function synthesizeEncounter(claims: SynthClaim[], opts: { provider?: LlmProvider } = {}): Promise<SynthesisResult> {
  if (!claims.length) {
    return { text: null, sentenceClaimMap: {}, rejections: ["no validated claims to summarize"], fallback: true };
  }
  const provider = opts.provider ?? getProvider();
  if (provider.name === "mock") {
    return { text: deterministicSummary(claims), sentenceClaimMap: {}, rejections: ["synthesis unavailable: provider not configured"], fallback: true };
  }
  const byId = new Map(claims.map((c) => [c.id, c]));
  const { system, user } = buildPrompt(claims);

  const attempt = async (extra?: string): Promise<{ ok: true; text: string; map: Record<string, string[]> } | { ok: false; reasons: string[] }> => {
    const raw = await provider.complete({
      system,
      messages: [{ role: "user", content: extra ? `${user}\n\n${extra}` : user }],
      temperature: 0,
      maxTokens: 1500,
    });
    const parsed = synthesisSchema.safeParse(parseJson(raw));
    if (!parsed.success) return { ok: false, reasons: ["output did not match the required schema"] };
    const reasons: string[] = [];
    const map: Record<string, string[]> = {};
    for (const s of parsed.data.sentences) {
      const problem = checkSentence(s.text, s.claimIds, byId);
      if (problem) reasons.push(`"${s.text.slice(0, 60)}…" ${problem}`);
      else map[s.text.trim()] = s.claimIds;
    }
    if (reasons.length) return { ok: false, reasons };
    const text = parsed.data.sentences.map((s) => s.text.trim()).join(" ");
    // Belt and braces: the assembled prose must split back into the sentences
    // we mapped, or the mapping does not describe what will be displayed.
    for (const sentence of splitSentences(text)) {
      if (!map[sentence]) return { ok: false, reasons: [`assembled text contains an unmapped sentence: "${sentence.slice(0, 60)}…"`] };
    }
    return { ok: true, text, map };
  };

  try {
    const first = await attempt();
    if (first.ok) return { text: first.text, sentenceClaimMap: first.map, rejections: [], fallback: false };
    const second = await attempt(
      `Your previous output was rejected for these reasons:\n${first.reasons.map((r) => `- ${r}`).join("\n")}\nRewrite using ONLY the validated claims, attributing every sentence. Return ONLY the JSON object.`,
    );
    if (second.ok) return { text: second.text, sentenceClaimMap: second.map, rejections: first.reasons, fallback: false };
    return {
      text: deterministicSummary(claims),
      sentenceClaimMap: {},
      rejections: [...first.reasons, ...second.reasons],
      fallback: true,
    };
  } catch {
    return { text: deterministicSummary(claims), sentenceClaimMap: {}, rejections: ["synthesis provider error"], fallback: true };
  }
}
