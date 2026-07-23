// ─────────────────────────────────────────────────────────────────────────────
// Narrative sanity — "does this make sense to say in this situation?"
//
// A deterministic linter run over every generated narrative field, checking
// the TEXT against the STRUCTURED state it was generated from. It catches the
// classes of nonsense a reader notices instantly:
//   • anatomy incoherence — the text names anatomy incompatible with the
//     item's own region/level/side/sub-structure;
//   • state contradictions — the text asserts something the structured state
//     denies (approved vs pending, lifetime vs fixed course, included vs
//     contingency);
//   • numeric mismatches — a frequency/duration in the text that differs from
//     the item's structured values;
//   • broken citations — "(file.pdf, p. " with no page number, or a citation
//     truncated mid-parenthesis;
//   • garbled text — dangling clauses, doubled words, unbalanced quotes or
//     parentheses, placeholder leakage (undefined/null/NaN/[object Object]).
//
// It cannot judge open-ended clinical sense — that authority remains the
// physician's. Every hit becomes a named, explained issue.
// ─────────────────────────────────────────────────────────────────────────────

import { bodyRegion, anatomyCompatible, type BodyRegion } from "./integrity";

export interface NarrativeIssue {
  field: string;
  rule: string;
  severity: "High" | "Moderate" | "Low";
  excerpt: string;
  explanation: string;
}

export interface NarrativeContext {
  service: string;
  region: BodyRegion | string;
  physicianStatus?: string;
  isLifetime?: boolean;
  durationYears?: number | null;
  frequencyPerYear?: number;
  inclusionInTotalsStatus?: string;
  diagnosis?: string | null;
}

const PLACEHOLDER = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\$\{|\bfunction\s*\(/;
const BROKEN_PAGE = /\bp\.(?!\s*[0-9])/; // "p." not followed by a page number
const DOUBLED_WORD = /\b(\w{3,})\s+\1\b/i;
const DANGLING_END = /(?:—|–|,|;|:|\(|\bthe\b|\band\b|\bto\b|\bof\b|\bfor\b|\bwith\b)\s*$/i;

function excerpt(text: string, around?: number): string {
  if (around == null) return text.slice(0, 90);
  const start = Math.max(0, around - 40);
  return text.slice(start, start + 90);
}

/** Lint one narrative field against its structured context. Pure. */
export function lintNarrative(field: string, text: string | null | undefined, ctx: NarrativeContext): NarrativeIssue[] {
  if (!text || !text.trim()) return [];
  const issues: NarrativeIssue[] = [];
  const t = text.trim();

  // ── Garble / formatting ────────────────────────────────────────────────────
  const ph = t.match(PLACEHOLDER);
  if (ph) issues.push({ field, rule: "placeholder_leak", severity: "High", excerpt: excerpt(t, ph.index), explanation: "A programming placeholder leaked into reader-facing text." });
  const bp = t.match(BROKEN_PAGE);
  if (bp) issues.push({ field, rule: "broken_citation", severity: "Moderate", excerpt: excerpt(t, bp.index), explanation: 'A page citation ("p.") is not followed by a page number — the citation was truncated or malformed.' });
  if ((t.match(/\(/g) ?? []).length !== (t.match(/\)/g) ?? []).length)
    issues.push({ field, rule: "unbalanced_parens", severity: "Moderate", excerpt: excerpt(t), explanation: "Unbalanced parentheses — a clause or citation was cut off mid-sentence." });
  if ((t.match(/“/g) ?? []).length !== (t.match(/”/g) ?? []).length)
    issues.push({ field, rule: "unbalanced_quotes", severity: "Moderate", excerpt: excerpt(t), explanation: "An opening quotation mark is never closed — quoted record text was truncated." });
  const dw = t.match(DOUBLED_WORD);
  if (dw && !/that that/i.test(dw[0])) issues.push({ field, rule: "doubled_word", severity: "Low", excerpt: excerpt(t, dw.index), explanation: `The word "${dw[1]}" is repeated back-to-back.` });
  if (DANGLING_END.test(t)) issues.push({ field, rule: "dangling_clause", severity: "Moderate", excerpt: t.slice(-70), explanation: "The text ends mid-clause — a sentence was cut off." });

  // ── Anatomy coherence ──────────────────────────────────────────────────────
  // A sentence that presents anatomy as the item's EVIDENTIARY ANCHOR must be
  // compatible with the item's own anatomy (region + level + side +
  // sub-structure). Passing mentions of a multi-injury patient's other regions
  // are legitimate (a follow-up visit narrative may reference knee arthritis
  // even when the item's coarse region is spine) — only anchoring assertions
  // are held to the strict gate. brain/head and psych are treated as one
  // clinical neighborhood, not a mismatch.
  const ANCHOR = /\b(?:rests on|anchored (?:on|in|by)|concrete finding|pertinent finding|grounded in|supported by|documented (?:by|in)|evidenced by)\b/i;
  const RELATED = new Set(["brain_head|psych", "psych|brain_head"]);
  if (ctx.region && ctx.region !== "general") {
    const dxText = `${ctx.service} ${ctx.diagnosis ?? ""}`;
    for (const sentence of t.split(/(?<=[.!?])\s+/)) {
      if (!ANCHOR.test(sentence)) continue;
      const r = bodyRegion(sentence);
      if (r === "general" || RELATED.has(`${r}|${ctx.region}`)) continue;
      const incompatible = r !== ctx.region || !anatomyCompatible(ctx.region as BodyRegion, dxText, sentence);
      if (incompatible) {
        issues.push({ field, rule: "anatomy_incoherence", severity: "High", excerpt: excerpt(sentence), explanation: `The text invokes ${r.replace(/_/g, "/")} anatomy incompatible with this ${String(ctx.region).replace(/_/g, "/")} recommendation.` });
        break; // one per field is enough to force review
      }
    }
  }

  // ── State contradictions ───────────────────────────────────────────────────
  if (ctx.physicianStatus === "PENDING" && /physician (?:has )?(?:approved|endorsed|signed off)|approved by the (?:reviewing )?physician/i.test(t))
    issues.push({ field, rule: "state_contradiction", severity: "High", excerpt: excerpt(t), explanation: "The text asserts physician approval, but the item is still awaiting review." });
  if (ctx.physicianStatus === "REJECTED" && /physician (?:has )?approved/i.test(t))
    issues.push({ field, rule: "state_contradiction", severity: "High", excerpt: excerpt(t), explanation: "The text asserts physician approval, but the physician rejected this item." });
  if (ctx.isLifetime === false && ctx.durationYears != null && /\b(?:lifelong|for life|across the (?:patient'?s )?lifetime|life expectancy horizon)\b/i.test(t))
    issues.push({ field, rule: "duration_contradiction", severity: "High", excerpt: excerpt(t), explanation: `The text asserts lifetime duration, but the item is structured as a ${ctx.durationYears}-year course.` });
  if (ctx.inclusionInTotalsStatus === "contingency" && /included in (?:the )?totals?\b/i.test(t) && !/not (?:entered|included)/i.test(t))
    issues.push({ field, rule: "inclusion_contradiction", severity: "High", excerpt: excerpt(t), explanation: "The text asserts inclusion in totals, but the item is a disclosed contingency." });

  // ── Numeric coherence ──────────────────────────────────────────────────────
  if (ctx.frequencyPerYear != null) {
    const m = t.match(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:×|x|times)\s*(?:\/|per\s*)(?:yr|year)/i);
    if (m && Number(m[1]) !== ctx.frequencyPerYear)
      issues.push({ field, rule: "frequency_mismatch", severity: "High", excerpt: excerpt(t, m.index), explanation: `The text states ${m[1]}×/yr but the item's structured frequency is ${ctx.frequencyPerYear}×/yr.` });
  }

  return issues;
}

/** The narrative fields of an assessment-like object worth linting. */
const NARRATIVE_FIELDS = [
  "medicalNecessityRationale",
  "frequencyRationale",
  "durationRationale",
  "inclusionRationale",
  "timingRationale",
  "leastIntensiveRationale",
  "noTreatmentRisk",
  "literatureSynthesis",
  "residualUncertainty",
  "confidenceExplanation",
] as const;

/** Lint every narrative field of one assessment. Pure. */
export function lintAssessmentNarratives(
  a: Record<string, unknown> & { recommendationService: string; bodyRegion?: string | null },
  ctx: Omit<NarrativeContext, "region" | "service">,
): NarrativeIssue[] {
  const base: NarrativeContext = { ...ctx, service: a.recommendationService, region: (a.bodyRegion as string) ?? "general" };
  const out: NarrativeIssue[] = [];
  for (const f of NARRATIVE_FIELDS) out.push(...lintNarrative(f, a[f] as string | null | undefined, base));
  return out;
}
