// ─────────────────────────────────────────────────────────────────────────────
// Clinical assertion classification (NegEx-style). Given a sentence and a term
// that appears in it, decides whether the term is actually ASSERTED for the
// patient — or negated ("no acute fracture"), hypothetical ("rule out
// concussion"), historical ("history of prior lumbar fusion"), or a
// family-history mention ("family history of diabetes").
//
// Deterministic and conservative in the citation-safe direction: a term is only
// demoted from "affirmed" when a clear trigger is within word-window scope,
// because the dangerous failure mode is quoting a negated/hypothetical/family
// finding as supporting evidence — never the reverse. A conjunction or clause
// boundary (but, however, although, except, aside from, ";") between a trigger
// and the term ends the trigger's scope, so "No fracture, but severe effusion"
// still affirms the effusion.
//
// Precedence: family > negated > hypothetical > historical > affirmed — a
// family-history mention is never patient evidence regardless of other cues
// ("no family history of cancer" is a family statement, not a patient one).
//
// Pure functions, regex-based, no LLM calls. Trigger wording mirrors the
// PRIOR_QUALIFIER idea in src/lib/intake/preExisting.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type Assertion = "affirmed" | "negated" | "hypothetical" | "historical" | "family";

// A conjunction/clause boundary between a trigger and the term ENDS the
// trigger's scope.
const SCOPE_BREAK = /\b(?:but|however|although|except|aside from)\b|;/i;

// Pre-negation triggers — negate a term appearing within ~6 words AFTER them.
// "rules out / ruled out" (past or third-person) is a completed negation; the
// bare imperative "rule out" is hypothetical and handled below.
const PRE_NEG =
  /\b(?:no evidence of|no signs? of|negative for|unremarkable for|free of|rules out|ruled out|denies|denied|without|absent|resolved|no)\b/gi;

// Post-negation triggers — negate a term appearing within ~3 words BEFORE them.
const POST_NEG =
  /\b(?:(?:is|was|were|are)\s+absent|not\s+(?:seen|identified|appreciated)|within\s+normal\s+limits|unremarkable)\b/gi;

// Hypothetical / differential triggers preceding the term. "at risk for/of" is
// the prognostic phrasing that counts; a bare "risk of" does not.
const PRE_HYP =
  /\b(?:rule out|r\/o|differential (?:diagnos[ie]s )?includes|possible|concern for|cannot exclude|at risk (?:for|of)|if (?:the )?(?:he|she|patient) develops)\b/gi;
// "fracture vs. contusion" — differential phrasing on either side of the term.
const VS = /\bvs\b\.?|\bversus\b/gi;
// "should <term> occur" — matched as a should…occur bracket around the term.
const SHOULD = /\bshould\b/gi;
const OCCUR = /\boccurs?\b/gi;

// Historical qualifiers that directly scope the term (within ~4 words before
// it) — mirrors PRIOR_QUALIFIER in src/lib/intake/preExisting.ts. "prior to"
// is temporal ("prior to the accident"), not historical, and "-old" inside
// "45-year-old" is an age, so both are excluded.
const PRE_HIST =
  /\b(?:history of|h\/o|hx of|prior(?!\s+to\b)|previous|remote|(?<!-)old|healed|status[- ]post|s\/p)\b/gi;

// Family-history triggers — the mention describes a relative, not the patient.
const FAMILY =
  /\b(?:family (?:history|hx)(?: of)?|fhx?\s*:|(?:mother|father|brother|sister|parent|sibling|grandmother|grandfather)(?:'s)?\s+(?:with|had|has|history of))\b/gi;

interface Span {
  start: number;
  end: number;
}

// Locate the term's first occurrence in the sentence. String terms match as
// whole words with an optional plural (same idea as hasTerm in chronology.ts)
// so "cord" can't match inside "record". RegExp terms are used as given, made
// case-insensitive and non-global for a single positional match.
function findTerm(sentence: string, term: string | RegExp): Span | null {
  let re: RegExp;
  if (typeof term === "string") {
    const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) return null;
    re = new RegExp(`\\b${escaped}s?\\b`, "i");
  } else {
    const flags = term.flags.replace(/[gy]/g, "");
    re = new RegExp(term.source, flags.includes("i") ? flags : flags + "i");
  }
  const m = re.exec(sentence);
  return m && m[0].length ? { start: m.index, end: m.index + m[0].length } : null;
}

// Words in the stretch between a trigger and the term (punctuation ignored;
// hyphenated compounds like "post-traumatic" count once).
function gapWords(between: string): number {
  return (between.match(/[A-Za-z0-9][\w'\-\/]*/g) ?? []).length;
}

// True when a trigger match BEFORE the term sits within `maxGap` words of it
// with no scope-breaking conjunction/clause boundary in between.
function preTriggerInScope(sentence: string, span: Span, trigger: RegExp, maxGap: number): boolean {
  trigger.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = trigger.exec(sentence))) {
    if (m.index >= span.start) break;
    const between = sentence.slice(m.index + m[0].length, span.start);
    if (gapWords(between) <= maxGap && !SCOPE_BREAK.test(between)) return true;
    if (m.index === trigger.lastIndex) trigger.lastIndex++;
  }
  return false;
}

// True when a trigger match AFTER the term sits within `maxGap` words of it
// with no scope breaker in between ("edema was absent", "within normal limits").
function postTriggerInScope(sentence: string, span: Span, trigger: RegExp, maxGap: number): boolean {
  trigger.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = trigger.exec(sentence))) {
    if (m.index >= span.end) {
      const between = sentence.slice(span.end, m.index);
      if (gapWords(between) <= maxGap && !SCOPE_BREAK.test(between)) return true;
    }
    if (m.index === trigger.lastIndex) trigger.lastIndex++;
  }
  return false;
}

function isHypothetical(sentence: string, span: Span): boolean {
  if (preTriggerInScope(sentence, span, PRE_HYP, 6)) return true;
  // Differential phrasing on either side: "fracture vs. contusion".
  if (preTriggerInScope(sentence, span, VS, 2) || postTriggerInScope(sentence, span, VS, 2)) return true;
  // "should <term> occur" — conditional future event.
  if (preTriggerInScope(sentence, span, SHOULD, 6) && postTriggerInScope(sentence, span, OCCUR, 2)) return true;
  return false;
}

/**
 * Assertion status of `term` WITHIN `sentence`. When the term is not found in
 * the sentence (or no trigger is in scope) the answer is "affirmed" — a term is
 * only demoted on a clear, in-scope trigger.
 */
export function assertionOf(sentence: string, term: string | RegExp): Assertion {
  const span = findTerm(sentence, term);
  if (!span) return "affirmed";

  if (preTriggerInScope(sentence, span, FAMILY, 6)) return "family";
  if (preTriggerInScope(sentence, span, PRE_NEG, 6) || postTriggerInScope(sentence, span, POST_NEG, 3)) return "negated";
  if (isHypothetical(sentence, span)) return "hypothetical";
  if (preTriggerInScope(sentence, span, PRE_HIST, 4)) return "historical";
  return "affirmed";
}

/**
 * May this sentence be QUOTED as evidence for the term? Only affirmed and
 * historical mentions are patient facts; negated, hypothetical, and
 * family-history mentions must never be cited as support.
 */
export function isCitableEvidence(sentence: string, term: string | RegExp): boolean {
  const a = assertionOf(sentence, term);
  return a === "affirmed" || a === "historical";
}
