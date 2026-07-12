// ─────────────────────────────────────────────────────────────────────────────
// Standard-of-Care analysis (per causation item). For each condition on the
// causation map, locates REAL clinical practice guidelines / consensus
// statements across the literature sources and quotes their DIRECT LANGUAGE
// verbatim from the retrieved source — never composed, never fabricated — then
// maps the care documented in the chronology against that guidance.
//
// Framing is deliberately conservative: the module reports what the cited
// guidance says and what the record documents. Whether the care MET the
// standard is a physician determination and is labeled as such.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { findCandidates, literatureReachable, type Article } from "@/lib/literature";
import { hasTerm, sigTerms } from "./chronology";
import { Prisma } from "@/generated/prisma";
import { citationCompatible, evaluateArticle, structuredConfidence, EVIDENCE_HIERARCHY, type ConfidenceResult } from "@/lib/engine/citationQuality";

export interface SocGuideline {
  source: string; // "Europe PMC" | "Crossref" | "User-provided" | …
  title: string;
  journal: string;
  year: string;
  authors: string;
  url: string;
  pmid?: string;
  doi?: string;
  /** VERBATIM sentence(s) from the retrieved abstract / added source */
  quote: string;
  /** true when the source was added by the user (never auto-refreshed away) */
  userProvided?: boolean;
  /** the SocUserInput id, so the UI can remove it */
  userInputId?: string;
  /** Clinical Evidence Sprint — why this source was selected, what it supports,
   *  and its limitations. Absent on user-provided sources and legacy rows. */
  relevance?: {
    score: number;
    evidenceLevel: number;
    evidenceLabel: string;
    whyRelevant: string;
    supports: string;
    limitations: string | null;
  };
}

export interface SocUserNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface SocRecordSupport {
  date: string; // ISO yyyy-mm-dd
  summary: string;
  page: number | null;
  eventType: string | null;
}

export type SocDocumentation = "DOCUMENTED" | "LIMITED" | "NOT_DOCUMENTED";

// The actual analysis conclusion — whether the documented/planned care aligns
// with the cited guidance. A preliminary, evidence-grounded assessment for the
// reviewing physician, not a legal conclusion of breach.
export type SocVerdict = "CONSISTENT" | "PARTIAL" | "POTENTIAL_GAP" | "INDETERMINATE";

export interface SocAlignmentPoint {
  /** the guideline the recommendation comes from (short title) */
  guideline: string;
  /** whether the documented/planned care evidences this guidance */
  addressed: boolean;
  /** the record entry (or planned care) that evidences it, when addressed */
  support: string | null;
}

export interface SocAssessment {
  verdict: SocVerdict;
  /** the actual standard-of-care analysis narrative (one-paragraph summary) */
  narrative: string;
  /** a deposition-style, case-specific expert rationale (one string per
   *  paragraph): what the standard requires for this diagnosis, which decision
   *  points the record evidences vs. does not, and the reasoned conclusion —
   *  composed only from the cited guideline language and the documented record */
  opinion: string[];
  points: SocAlignmentPoint[];
  /** honest evidence posture for this conclusion (never overstated) */
  evidence?: {
    strength: string; // e.g. "Clinical practice guideline", "Cohort study", "None located"
    limitations: string[];
    unknowns: string[];
    confidence: "High" | "Moderate" | "Low" | "Indeterminate";
    confidenceFactors: string[];
  };
}

export interface SocAnalysis {
  /** framing statement — what was located */
  standard: string;
  guidelines: SocGuideline[];
  recordSupport: SocRecordSupport[];
  documentation: SocDocumentation;
  /** whether the standard of care appears met, with reasoning */
  assessment: SocAssessment;
  /** free-text notes the user added; joined into the evidence corpus */
  userNotes: SocUserNote[];
  rationale: string;
  gaps: string | null;
}

/** A user-supplied input row (note or added source). */
export interface UserInputRow {
  id: string;
  kind: string; // "note" | "source"
  text: string;
  title?: string | null;
  url?: string | null;
  filename?: string | null;
  createdAt: Date;
}

const VERDICT_LABEL: Record<SocVerdict, string> = {
  CONSISTENT: "Consistent with cited guidance",
  PARTIAL: "Partially consistent — gaps noted",
  POTENTIAL_GAP: "Potential gap — recommended care not documented",
  INDETERMINATE: "Indeterminate — insufficient documentation",
};
export function socVerdictLabel(v: SocVerdict): string {
  return VERDICT_LABEL[v] ?? v;
}

const SOURCE_LABEL: Record<string, string> = { europepmc: "Europe PMC", crossref: "Crossref", semanticscholar: "Semantic Scholar" };

// Papers ABOUT guidelines (AI/LLM concordance studies, adherence audits) are not
// the guidance itself — exclude them even though their titles say "guideline".
const NOT_GUIDANCE = /\b(chatgpt|gpt-?[0-9]|large language model|\bllm\b|artificial intelligence|\bai\b|concordance with|adherence to|performance of|alignment with|awareness of|survey of|bibliometric|scoping review of guidelines)\b/i;

// Is this article actual practice guidance (not a trial, narrative, or a study
// evaluating guidelines)?
function isGuidance(a: Article): boolean {
  if (NOT_GUIDANCE.test(a.title)) return false;
  const pts = (a.pubtype ?? []).map((p) => p.toLowerCase());
  if (pts.some((p) => p.includes("guideline") || p.includes("consensus"))) return true;
  return /\b(guidelines?|consensus|recommendations?|position statement|practice advisory|appropriate use criteria|clinical pathway)\b/i.test(a.title);
}

// Split an abstract into sentences, including structured-abstract headers that
// arrive glued to the prior sentence ("criteria.ResultsArticle 1:"). Section
// labels at the start of a sentence are stripped so the real content leads.
const SECTION_LABEL = /^(?:and\s+)?(background|objectives?|methods?|results?|conclusions?|introduction|purpose|aims?|discussion|findings|study design|design|setting|interpretation)\b[:.\s-]*/i;
const HEADER_WORD = /\b(Background|Objectives?|Methods?|Results?|Conclusions?|Findings|Interpretation|Discussion|Introduction|Purpose|Aims?|Design|Setting)/g;
function splitSentences(abstract: string): string[] {
  return abstract
    .replace(/([.!?])(?=[A-Z][a-z])/g, "$1 ") // unglue "criteria.Results"
    .replace(HEADER_WORD, (m, _w, off, str) => (off > 0 && /[A-Za-z]/.test(str[off - 1]) ? ". " + m : m)) // "...qualityBackground" → header on its own
    .replace(/\b(Results?|Conclusions?|Background|Objectives?|Methods?|Findings|Interpretation|Discussion)(?=[A-Z])/g, "$1: ") // "ResultsArticle" → "Results: Article"
    .replace(/\s{2,}/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(SECTION_LABEL, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Guidance verbs that mark normative sentences — the language worth quoting.
const NORMATIVE = /\b(recommend(?:s|ed|ation)?s?|should|must|is indicated|are indicated|first-line|standard of care|strongly|suggest(?:s|ed)?|advise[sd]?|indicated for|contraindicated|mainstay|treatment of choice)\b/i;

// Generic clinical nouns that appear in thousands of unrelated guidelines — a
// match on these alone does NOT mean the guidance is about THIS condition.
const SOC_GENERIC = new Set([
  "infection", "infections", "inflammatory", "inflammation", "reaction", "injury", "injuries", "fracture", "fractures",
  "pain", "disorder", "disorders", "syndrome", "disease", "chronic", "acute", "management", "treatment", "care",
  "internal", "external", "primary", "secondary", "unspecified", "initial", "encounter", "status", "post", "residual",
  "deficit", "complication", "complications", "surgical", "surgery", "procedure", "clinical", "medical", "patient", "adult",
  "traumatic", "posttraumatic", "sequela", "sequelae", "displaced", "closed", "open", "affected", "level", "due",
  // "spine"/"spinal" appear in cervical, thoracic, lumbar AND pediatric guidance
  // alike — too broad to establish that a guideline is about THIS diagnosis; the
  // anatomically specific term ("thoracolumbar", "lumbar", "cord") carries it.
  "spine", "spinal",
]);
// Distinctive (anatomy/procedure/pathology) terms of a diagnosis — the words a
// truly on-point guideline must speak to. Generic clinical nouns removed.
function distinctiveTerms(name: string): string[] {
  return sigTerms(name).filter((t) => !SOC_GENERIC.has(t));
}
// Weak, process-y words that must NOT count as a documented "intervention"
// (they appear in almost any note and cause cross-topic false matches).
const MATCH_STOP = new Set([
  "therapy", "therapies", "therapeutic", "function", "functional", "improvement", "improvements", "improve", "advised",
  "program", "exercise", "exercises", "evaluation", "assessment", "recommendation", "recommendations", "recommend",
  "guideline", "guidelines", "guidance", "clinical", "patient", "patients", "standard", "evidence", "study", "review",
  "general", "follow", "followup", "visit", "visits", "consider", "considering", "including", "increased", "reduced",
  "outcome", "outcomes", "quality", "safety", "should", "options", "provider", "providers",
]);

// Compact query phrase from a diagnosis name (drops severity/laterality filler).
const HINT_STOP = new Set(["severe", "chronic", "acute", "status", "post", "with", "and", "the", "mild", "moderate", "left", "right", "bilateral", "initial", "encounter", "unspecified", "history", "type", "residual", "deficit", "anticipated", "due", "internal", "affected"]);
function condHint(name: string): string {
  return (name.match(/[a-z][a-z-]+/gi) ?? []).filter((w) => !HINT_STOP.has(w.toLowerCase())).slice(0, 6).join(" ").trim();
}

// ICD/chart phrasing → the clinical concept a guideline is actually indexed
// under. An ICD-verbatim diagnosis ("Infection … due to internal right knee
// prosthesis") makes a poor guideline query; the concept ("periprosthetic joint
// infection") finds the AAOS/consensus guidance. First match wins.
const GUIDELINE_CONCEPTS: { re: RegExp; query: string }[] = [
  { re: /prosthe|periprosthetic|hardware.*infection|infected.*(joint|knee|hip|arthroplasty)/i, query: "periprosthetic joint infection" },
  { re: /(knee|hip).*(osteoarthritis|arthritis)|osteoarthritis.*(knee|hip)/i, query: "osteoarthritis of the knee" },
  { re: /total knee arthroplasty|knee replacement|\btka\b/i, query: "total knee arthroplasty osteoarthritis" },
  { re: /total hip arthroplasty|hip replacement|\btha\b/i, query: "total hip arthroplasty osteoarthritis" },
  { re: /(?:burst|compression|wedge)\s+fracture|\bfractur[a-z]*\b[^.]{0,28}\b(?:lumbar|thoracic|thoracolumbar|vertebra)\b|\b(?:lumbar|thoracic|thoracolumbar|vertebra)\b[^.]{0,28}\bfractur/i, query: "thoracolumbar spine fracture" },
  { re: /spinal cord injur|\bsci\b|\btsci\b|tetraplegia|paraplegia|quadripar/i, query: "acute traumatic spinal cord injury" },
  { re: /spastic|spasticity|tetrapar|hemipar|hemipleg|paraparesis|diplegia|hypertonia/i, query: "spasticity management" },
  { re: /neurogenic bladder|neuromuscular dysfunction of bladder/i, query: "neurogenic bladder" },
  { re: /tibial plateau/i, query: "tibial plateau fracture" },
  { re: /rotator cuff/i, query: "rotator cuff tear" },
  { re: /traumatic brain injur|\btbi\b|concussion/i, query: "traumatic brain injury" },
  { re: /anterior cruciate|\bacl\b/i, query: "anterior cruciate ligament injury" },
  { re: /transtibial|below.knee amputation|amputat/i, query: "lower limb amputation rehabilitation" },
  { re: /complex regional pain|\bcrps\b/i, query: "complex regional pain syndrome" },
  { re: /radiculopath|herniat|disc (disorder|displacement)/i, query: "lumbar radiculopathy" },
];
// The queries to try for a condition — its mapped clinical concept(s) plus its
// own distinctive terms, so guideline lookup isn't hostage to ICD phrasing.
function guidelineQueries(name: string): string[] {
  const qs: string[] = [];
  for (const g of GUIDELINE_CONCEPTS) if (g.re.test(name)) qs.push(g.query);
  const distinctive = distinctiveTerms(name).join(" ");
  if (distinctive) qs.push(distinctive);
  const hint = condHint(name);
  if (hint) qs.push(hint);
  // Up to 3 queries: a condition can legitimately map to more than one concept
  // (e.g. "TBI with spastic quadriparesis" → brain injury + spasticity), and
  // capping at 2 silently dropped a pertinent one. Concept queries lead, so the
  // distinctive/hint fallbacks are only used when few concepts matched.
  return [...new Set(qs)].slice(0, 3);
}
// The canonical clinical vocabulary of a condition's mapped concept(s). An
// ICD-verbatim name ("Severe TBI with spastic quadriparesis") yields idiosyncratic
// terms; a real guideline speaks in standard terms ("traumatic brain injury").
// Folding the concept's own distinctive terms into the on-topic vocabulary lets
// the located guidance be recognized as pertinent instead of rejected.
function conceptTerms(name: string): string[] {
  const out: string[] = [];
  for (const g of GUIDELINE_CONCEPTS) if (g.re.test(name)) out.push(...distinctiveTerms(g.query));
  return out;
}
// Terms a guideline must speak to for THIS condition: its own distinctive terms
// plus its mapped concept's canonical terms.
function guidanceTerms(name: string): string[] {
  return [...new Set([...distinctiveTerms(name), ...conceptTerms(name)])];
}

/**
 * The best verbatim quote from the article's abstract for this condition:
 * 1–2 contiguous sentences scored by condition-term hits and normative
 * guidance language. Returns null when the abstract has no pertinent sentence
 * (the article is then not cited — no quote, no citation).
 */
// Abstract boilerplate that is never the actual recommendation.
const ABSTRACT_BOILERPLATE = /^(study design|objectives?|background|introduction|methods?|purpose|aim|this study|we (?:aimed|sought|evaluated|assessed|conducted)|differences? (?:across|between))/i;
// Statistics / methods sentences — data, not guidance.
const STATS_METHODS = /\b(statistical|p\s*[<>=]|p-?value|\bn\s*=|a total of|were (?:identified|enrolled|included|analy[sz]ed|recruited)|aims? to|we (?:aim|sought|analy|enroll|includ|recruit)|this (?:study|project|analysis|review|paper) (?:aim|assess|evaluat|examin|employ|present)|retrospective|prospective cohort|database|evidence mapping|prevalence of|odds ratio|confidence interval)\b/i;
// Scope sentences that state what the guideline recommends/covers — pertinent
// direct language even without an imperative verb.
const SCOPE = /\b(guideline|recommendations?|consensus|guidance|clinical practice)\b/i;

export interface QuoteResult { quote: string; score: number }

export function extractGuidelineQuote(abstract: string, conditionName: string, maxLen = 360): QuoteResult | null {
  const terms = guidanceTerms(conditionName);
  if (!terms.length) return null;
  const sentences = splitSentences(abstract).filter((s) => s.length >= 40 && s.length <= 420);
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < sentences.length; i++) {
    const lower = sentences[i].toLowerCase();
    const termHits = terms.filter((t) => hasTerm(lower, t)).length;
    if (termHits === 0) continue; // a quote MUST be about this condition
    const normative = NORMATIVE.test(sentences[i]) ? 5 : 0;
    const scope = !normative && SCOPE.test(sentences[i]) ? 2 : 0;
    const stats = STATS_METHODS.test(sentences[i]) ? -6 : 0;
    const boilerplate = ABSTRACT_BOILERPLATE.test(sentences[i]) ? -3 : 0;
    const position = i >= sentences.length - 3 ? 1 : 0;
    const score = termHits * 3 + normative + scope + stats + boilerplate + position;
    if (!best || score > best.score) best = { i, score };
  }
  if (!best || best.score <= 0) return null; // no pertinent, non-stats sentence
  // Include the following sentence when it continues the guidance and fits.
  let quote = sentences[best.i];
  const next = sentences[best.i + 1];
  if (next && quote.length + next.length + 1 <= maxLen && NORMATIVE.test(next)) quote += " " + next;
  return { quote: quote.length > maxLen ? quote.slice(0, maxLen - 1).trimEnd() + "…" : quote, score: best.score };
}

// A guideline is on-topic for the condition only if its TITLE names a
// distinctive term, or its abstract names ≥2 — so "infection" alone can't attach
// an H. pylori guideline to a knee-prosthesis infection.
function guidanceOnTopic(a: Article, conditionName: string): boolean {
  const terms = guidanceTerms(conditionName);
  if (!terms.length) return false;
  const title = a.title.toLowerCase();
  if (terms.some((t) => hasTerm(title, t))) return true;
  const abs = (a.abstract ?? "").toLowerCase();
  return terms.filter((t) => hasTerm(abs, t)).length >= 2;
}

/** Rank guidance candidates for a condition: title term match, recency, reach. */
function rankGuidance(a: Article, conditionName: string, yearNow: number): number {
  const title = a.title.toLowerCase();
  const termHits = guidanceTerms(conditionName).filter((t) => hasTerm(title, t)).length;
  const year = parseInt(a.year, 10) || 0;
  const recency = year >= yearNow - 5 ? 3 : year >= yearNow - 12 ? 2 : year >= 2000 ? 1 : 0;
  const cc = a.citationCount ?? 0;
  const reach = cc >= 500 ? 3 : cc >= 100 ? 2 : cc >= 10 ? 1 : 0;
  return termHits * 10 + recency + reach;
}

/**
 * Build the standard-of-care analysis for every condition on the case.
 * Best-effort: offline → conditions get an honest "no guideline located"
 * analysis rather than an invented one. Returns conditions analyzed.
 */
export async function generateStandardOfCare(caseId: string): Promise<number> {
  const conditions = await prisma.condition.findMany({ where: { caseId } });
  if (!conditions.length) return 0;
  // Population gate: pediatric/congenital guidance never supports an adult case.
  const kase = await prisma.case.findUnique({ where: { id: caseId }, select: { dateOfBirth: true } });
  const adult = !kase?.dateOfBirth || (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  const events = await prisma.chronologyEvent.findMany({ where: { caseId }, orderBy: { eventDate: "asc" } });
  // Planned future care counts toward the standard (e.g. a documented plan for
  // revision arthroplasty). Items are diagnosis-driven and linked to the primary
  // condition, so they apply case-wide unless the service names another region.
  const careItems = await prisma.futureCareItem.findMany({ where: { caseId }, select: { service: true } });
  const careServices = careItems.map((i) => i.service);
  const primaryConditionId = conditions[0]?.id;
  const online = await literatureReachable();
  const yearNow = new Date().getFullYear();

  let n = 0;
  for (const cond of conditions) {
    const queries = guidelineQueries(cond.name);

    // ── Locate real guidance and quote its direct language. ──────────────────
    const located: SocGuideline[] = [];
    if (online && queries.length) {
      // Concept-mapped phrasings widen the guideline pool; results merge &
      // de-dupe in the literature layer, then gate to on-topic practice guidance.
      const pools = await Promise.all(queries.map((q) => findCandidates(`${q} clinical practice guideline recommendations`, 12)));
      const seen = new Set<string>();
      const pool = pools.flat().filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)));
      // Extract each on-topic guidance candidate's best verbatim quote, then rank
      // by QUOTE QUALITY (a real recommendation beats a scope sentence beats a
      // stats sentence) with the title/recency rank as a secondary signal.
      const scored = pool
        .filter((a) => isGuidance(a) && (a.abstract?.length ?? 0) >= 120 && guidanceOnTopic(a, cond.name))
        // HARD compatibility gate (region/procedure/population) — keyword
        // overlap alone can never seat a guideline under this diagnosis.
        .filter((a) => citationCompatible({ title: a.title, abstract: a.abstract, pubtype: a.pubtype }, { diagnosis: cond.name, service: cond.name, adult }).compatible)
        .map((a) => ({ a, q: extractGuidelineQuote(a.abstract!, cond.name) }))
        .filter((x): x is { a: Article; q: QuoteResult } => x.q !== null)
        .sort((x, y) => y.q.score * 10 + rankGuidance(y.a, cond.name, yearNow) - (x.q.score * 10 + rankGuidance(x.a, cond.name, yearNow)));
      const titleSeen = new Set<string>();
      for (const { a, q } of scored) {
        const tkey = a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 45);
        if (titleSeen.has(tkey)) continue; // drop near-identical part I/II duplicates
        titleSeen.add(tkey);
        const rel = evaluateArticle({ title: a.title, abstract: a.abstract, journal: a.journal, year: a.year, pubtype: a.pubtype, citationCount: a.citationCount }, { diagnosis: cond.name, service: cond.name, adult });
        located.push({
          source: SOURCE_LABEL[a.source] ?? a.source,
          title: a.title,
          journal: a.journal,
          year: a.year,
          authors: a.authors,
          url: a.url,
          pmid: a.pmid,
          doi: a.doi,
          quote: q.quote,
          relevance: {
            score: rel.score,
            evidenceLevel: rel.evidenceLevel,
            evidenceLabel: rel.evidenceLabel,
            whyRelevant: rel.whyRelevant,
            supports: `the clinical basis and future-care relevance of ${cond.name}`,
            limitations: rel.limitations,
          },
        });
        if (located.length >= 3) break;
      }
    }

    const userInputs = await prisma.socUserInput.findMany({ where: { caseId, conditionName: cond.name }, orderBy: { createdAt: "asc" } });
    const soc = assembleAnalysis(cond.name, cond.id === primaryConditionId, located, events, careServices, userInputs, online, {
      evidenceCount: Array.isArray(cond.evidenceSources) ? (cond.evidenceSources as unknown[]).length : 0,
      hasObjective: !!cond.objectiveEvidence,
      hasOpposing: !!cond.opposingRecords,
      hasMissingInfo: !!cond.missingInfo,
      physicianConfirmed: cond.physicianConfirmed,
    });
    await prisma.condition.update({ where: { id: cond.id }, data: { socAnalysis: soc as unknown as Prisma.InputJsonValue } });
    n++;
  }
  return n;
}

// ── Assembly: turn located guidance + records + planned care + USER INPUTS into
//    the analysis. User-added sources join the cited guidance; user notes join
//    the evidence corpus (so a note that documents an intervention can mark a
//    guideline addressed). Pure — no network — so it can recompute on demand.
type EventRow = { eventDate: Date; summary: string; sourcePage: number | null; eventType: string | null; treatment: string | null; diagnosis: string | null; clinicalSignificance: string | null };

// ── Deposition-style expert rationale ────────────────────────────────────────
// Scope / methods / title-fragment sentences that describe a guideline rather
// than state a recommendation — never surfaced as a "decision point".
const SNIPPET_SKIP = /^(?:article\s*\d+\b|results?\b|conclusions?\b|background\b|methods?\b|findings\b|this (?:study|research|review|narrative|guideline|paper|article|consensus|document)\b|we (?:aim|sought|present|develop|conduct|report)|recommendations? (?:were|are) (?:generated|developed|made|presented|formulated)|(?:the )?(?:aim|objective|purpose)\b|this (?:guideline|document) contains|the introduced algorithm)/i;
function cleanFragment(s: string): string {
  return s
    .replace(/^\s*article\s*\d+\s*[:.]\s*/i, "")
    .replace(/^(?:results?|conclusions?|background|methods?|findings|interpretation)\s*[:.]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
// The concrete recommendation ("decision point") a guideline quote states, or
// null when the quote is only scope/methods/boilerplate. Prefers a genuine
// normative sentence, else the first non-boilerplate sentence.
function recSnippet(quote: string, maxLen = 150): string | null {
  const sents = quote.split(/(?<=[.!?])\s+/).map(cleanFragment).filter(Boolean);
  const pick = sents.find((s) => NORMATIVE.test(s) && !SNIPPET_SKIP.test(s)) ?? sents.find((s) => !SNIPPET_SKIP.test(s)) ?? null;
  if (!pick) return null;
  const t = pick.replace(/[.;,]+$/, "");
  return t.length > maxLen ? t.slice(0, maxLen - 1).trimEnd() + "…" : t;
}
const lc0 = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const shortTitle = (t: string) => (t.length > 84 ? t.slice(0, 83).trimEnd() + "…" : t);

// Build the case-specific expert rationale as an ordered set of paragraphs. It
// is composed strictly from the cited guideline language and the documented
// record — the "expert voice" is a framing of the deterministic mapping, not an
// invented clinical opinion; the final determination stays the physician's.
function buildExpertRationale(
  condName: string,
  verdict: SocVerdict,
  guidelines: SocGuideline[],
  points: SocAlignmentPoint[],
  recordSupport: SocRecordSupport[],
  documentation: SocDocumentation,
  plannedAddresses: boolean,
  online: boolean,
): string[] {
  if (!guidelines.length) {
    return [
      online
        ? `The diagnosis at issue is ${condName}. No indexed clinical practice guideline with quotable recommendations was located for this specific diagnosis, so the governing standard of care cannot be stated from the literature on the present record. The reviewing physician should identify the controlling specialty standard — or the reviewer may add the governing source below — before an opinion on whether the standard was met can be offered.`
        : `The diagnosis at issue is ${condName}. Guideline lookup was unavailable, so the governing standard of care could not be retrieved. The analysis should be re-run with literature access, or the controlling source added below, before an opinion can be offered.`,
    ];
  }

  const paras: string[] = [];
  const zipped = guidelines.map((g, i) => ({ g, p: points[i] })).filter((x) => x.p);
  const addressed = zipped.filter((x) => x.p.addressed);
  const missing = zipped.filter((x) => !x.p.addressed);
  const lead = guidelines[0];
  // "per [Guideline], [recommendation]" — leads with the source, falls back to
  // naming the guideline when its quote states no crisp recommendation.
  const decisionPoint = (g: SocGuideline, withRec = true): string => {
    const rec = withRec ? recSnippet(g.quote, 120) : null;
    return rec ? `per ${shortTitle(g.title)}, ${lc0(rec)}` : `the guidance in ${shortTitle(g.title)}`;
  };

  // 1 — the standard of care for this diagnosis, as it applies to this case.
  const leadRec = recSnippet(lead.quote);
  paras.push(
    `The diagnosis at issue is ${condName}. The recognized standard of care is drawn from ${guidelines.length} cited clinical practice ${guidelines.length === 1 ? "guideline" : "guidelines"}. Principally, ${shortTitle(lead.title)}${lead.year ? ` (${lead.year})` : ""}${leadRec ? ` provides that ${lc0(leadRec)}` : ` addresses the management of this diagnosis`}. Read together, these sources establish the decision points a treating provider was expected to address for this diagnosis.`,
  );

  // 2 — decision points that were appropriately addressed.
  if (addressed.length) {
    const items = addressed.slice(0, 4).map((x) => `${decisionPoint(x.g)} (${x.p.support ?? "documented in the record"})`);
    paras.push(
      `The following decision points were appropriately addressed on the reviewed record: ${items.join("; ")}. Each is consistent with the cited standard as applied to this patient.`,
    );
  } else {
    paras.push(
      `None of the decision points the cited standard requires are affirmatively documented on the reviewed record — the specific interventions the guidance calls for cannot be matched to any entry in the records produced.`,
    );
  }

  // 3 — what should have been done but is not documented (potential departures).
  if (missing.length) {
    const items = missing.slice(0, 4).map((x) => decisionPoint(x.g));
    paras.push(
      `Conversely, the reviewed records do not evidence the following element${missing.length === 1 ? "" : "s"} the standard calls for: ${items.join("; ")}. If ${missing.length === 1 ? "this measure was" : "these measures were"} not undertaken, that would represent a departure from the standard of care for this diagnosis. It may alternatively reflect treating records not yet produced; those records should be obtained before any element is treated as a confirmed departure.`,
    );
  } else if (plannedAddresses) {
    paras.push(
      `The elements the standard calls for are accounted for by the documented care together with the projected care plan; none is left unaddressed on the present record.`,
    );
  } else {
    paras.push(`No recommended element of the cited standard is missing from the documented care on this record.`);
  }

  // 4 — the reasoned conclusion, tied to the verdict.
  const docPhrase =
    documentation === "DOCUMENTED"
      ? `across ${recordSupport.length} dated encounter${recordSupport.length === 1 ? "" : "s"}`
      : documentation === "LIMITED"
        ? `in a single encounter (thin documentation)`
        : `in no encounter in the reviewed records`;
  const concl: Record<SocVerdict, string> = {
    CONSISTENT: `Weighing the documented care ${docPhrase} against the cited standard, the care reflected in the present record is consistent with the standard of care for this diagnosis.`,
    PARTIAL: `Weighing the documented care ${docPhrase} against the cited standard, the care is partially consistent: some decision points are met while others cannot be confirmed from the records produced.`,
    POTENTIAL_GAP: `Weighing the cited standard against a record that documents management ${docPhrase}, there is a potential gap — the diagnosis-specific care the standard requires is not evidenced. The care may have been rendered and simply not produced, so the complete treating records should be obtained.`,
    INDETERMINATE: `The documentation is insufficient to assess concordance with the cited standard for this diagnosis on the present record.`,
  };
  paras.push(`${concl[verdict]} The ultimate determination of whether the standard of care was met is reserved to the reviewing physician.`);

  return paras;
}

export function assembleAnalysis(
  condName: string,
  isPrimary: boolean,
  located: SocGuideline[],
  events: EventRow[],
  careServices: string[],
  userInputs: UserInputRow[],
  online: boolean,
  condMeta?: { evidenceCount: number; hasObjective: boolean; hasOpposing: boolean; hasMissingInfo: boolean; physicianConfirmed: boolean },
): SocAnalysis {
  // User-added sources become cited guidance; user notes join the corpus.
  const userSources: SocGuideline[] = userInputs
    .filter((u) => u.kind === "source")
    .map((u) => ({
      source: "User-provided",
      title: u.title || u.filename || "User-added source",
      journal: "",
      year: "",
      authors: "",
      url: u.url || "",
      quote: u.text,
      userProvided: true,
      userInputId: u.id,
    }));
  const guidelines: SocGuideline[] = [...located, ...userSources];
  const userNotes: SocUserNote[] = userInputs
    .filter((u) => u.kind === "note")
    .map((u) => ({ id: u.id, text: u.text, createdAt: u.createdAt.toISOString() }));
  const noteCorpus = userInputs.map((u) => u.text).join("\n").toLowerCase();

  const condDistinct = distinctiveTerms(condName);
  const condTerms = new Set(condDistinct);
  const recordPertains = (e: EventRow): boolean => {
    if (!condDistinct.length) return false;
    const hay = [e.summary, e.diagnosis, e.treatment, e.clinicalSignificance].filter(Boolean).join("\n").toLowerCase();
    return condDistinct.some((t) => hasTerm(hay, t));
  };
  const recordSupport: SocRecordSupport[] = events.filter(recordPertains).map((e) => ({
    date: e.eventDate.toISOString().slice(0, 10),
    summary: e.summary,
    page: e.sourcePage,
    eventType: e.eventType,
  }));
  const documentation: SocDocumentation = recordSupport.length >= 2 ? "DOCUMENTED" : recordSupport.length === 1 ? "LIMITED" : "NOT_DOCUMENTED";

  const carePlanned = careServices.filter((s) => isPrimary || condDistinct.some((t) => hasTerm(s.toLowerCase(), t)));
  const pertinentEvents = events.filter(recordPertains).map((e) => ({
    date: e.eventDate.toISOString().slice(0, 10),
    summary: e.summary,
    page: e.sourcePage,
    text: [e.summary, e.treatment, e.diagnosis, e.clinicalSignificance].filter(Boolean).join(" ").toLowerCase(),
  }));

  const points: SocAlignmentPoint[] = guidelines.map((g) => {
    const interventions = sigTerms(g.quote).filter((t) => t.length >= 5 && !SOC_GENERIC.has(t) && !MATCH_STOP.has(t) && !condTerms.has(t));
    const rec = pertinentEvents.find((e) => interventions.some((t) => hasTerm(e.text, t)));
    const planned = !rec ? carePlanned.find((s) => interventions.some((t) => hasTerm(s.toLowerCase(), t))) : undefined;
    // A user note that documents the intervention also satisfies the point.
    const noteHit = !rec && !planned && noteCorpus ? interventions.find((t) => hasTerm(noteCorpus, t)) : undefined;
    return {
      guideline: g.title.length > 90 ? g.title.slice(0, 89) + "…" : g.title,
      addressed: !!rec || !!planned || !!noteHit,
      support: rec ? `${rec.date}: ${rec.summary}${rec.page ? ` (p. ${rec.page})` : ""}` : planned ? `Planned care: ${planned}` : noteHit ? "Per user-added note/source" : null,
    };
  });

  const addressed = points.filter((p) => p.addressed).length;
  const total = points.length;
  const plannedAddresses = points.some((p) => p.addressed && (p.support?.startsWith("Planned care") || p.support?.startsWith("Per user")));
  const userNote = userNotes.length ? ` The reviewer added ${userNotes.length} note${userNotes.length === 1 ? "" : "s"}${userSources.length ? ` and ${userSources.length} source${userSources.length === 1 ? "" : "s"}` : ""}, incorporated below.` : userSources.length ? ` The reviewer added ${userSources.length} source${userSources.length === 1 ? "" : "s"}, incorporated below.` : "";
  let verdict: SocVerdict;
  let narrative: string;
  if (total === 0) {
    verdict = "INDETERMINATE";
    narrative = (online
      ? "No indexed clinical practice guideline with pertinent quotable language was located for this diagnosis, so concordance with a published standard cannot be assessed. The reviewing physician should identify the applicable specialty standard, or add a source below."
      : "Guideline lookup was unavailable (offline), so the standard of care could not be assessed. Re-run with network access, or add a source below.") + userNote;
  } else if (recordSupport.length === 0 && !plannedAddresses) {
    verdict = "POTENTIAL_GAP";
    narrative = `${total} applicable clinical practice ${total === 1 ? "guideline was" : "guidelines were"} identified, but the reviewed records do not document evaluation or management of this diagnosis. This is a potential gap against the cited standard — the care may have been rendered but is not in the reviewed records; obtain the complete treating records or physician review before drawing any conclusion.${userNote}`;
  } else if (recordSupport.length === 0 && plannedAddresses) {
    verdict = "PARTIAL";
    narrative = `${total} applicable ${total === 1 ? "guideline was" : "guidelines were"} identified. The reviewed records do not document past management of this diagnosis, though the projected care plan${noteCorpus ? "/reviewer input" : ""} addresses the cited guidance. Whether guideline-concordant care was rendered cannot be confirmed from the present record — obtain the treating providers' records.${userNote}`;
  } else if (addressed === total) {
    verdict = documentation === "DOCUMENTED" ? "CONSISTENT" : "PARTIAL";
    narrative =
      (documentation === "DOCUMENTED"
        ? `The documented and planned care corresponds to the interventions the cited ${total === 1 ? "guideline recommends" : "guidelines recommend"} for this diagnosis, across ${recordSupport.length} dated encounters plus the projected plan. On the reviewed record the care appears consistent with the cited standard of care; final concordance is the reviewing physician's determination.`
        : `The documented and planned care aligns with the cited guidance, but management is documented in only a single encounter — thin documentation. It appears consistent as far as the record goes; obtain the full treating records to confirm.`) + userNote;
  } else if (addressed > 0) {
    verdict = "PARTIAL";
    const missing = points.filter((p) => !p.addressed).map((p) => p.guideline);
    narrative = `The documented/planned care aligns with ${addressed} of ${total} cited ${total === 1 ? "guideline" : "guidelines"}; it appears partially consistent with the cited standard. Alignment with ${missing.slice(0, 2).join("; ")}${missing.length > 2 ? `, and ${missing.length - 2} more` : ""} could not be confirmed from the reviewed records — obtain the treating records addressing those elements or physician clarification.${userNote}`;
  } else {
    verdict = "PARTIAL";
    narrative = `The reviewed records document ${recordSupport.length} encounter${recordSupport.length === 1 ? "" : "s"} for this diagnosis, but the specific interventions in the cited guidance could not be automatically matched to the record's language. Concordance with the cited standard requires physician review of the records against the quoted guidance below.${userNote}`;
  }
  const opinion = buildExpertRationale(condName, verdict, guidelines, points, recordSupport, documentation, plannedAddresses, online);

  // ── Honest evidence posture (Clinical Evidence Sprint) ─────────────────────
  // Strength = the best tier actually held; limitations and unknowns are stated,
  // and confidence is structured — weak evidence is CALLED weak, never dressed up.
  const levels = guidelines.map((g) => g.relevance?.evidenceLevel).filter((n): n is number => typeof n === "number");
  const bestLevel = levels.length ? Math.min(...levels) : null;
  const strength = bestLevel != null
    ? EVIDENCE_HIERARCHY.find((t) => t.level === bestLevel)?.label ?? "Clinical study"
    : guidelines.length
      ? "Source on file (level not classified)"
      : "None located";
  const limitations = [
    ...new Set(guidelines.map((g) => g.relevance?.limitations).filter((x): x is string => !!x)),
    ...(bestLevel != null && bestLevel >= 8 ? ["the best available evidence for this conclusion is observational — a weak basis; treat the conclusion as provisional"] : []),
    ...(documentation === "LIMITED" ? ["management is documented in only a single encounter"] : []),
  ];
  const unknowns = [
    ...(documentation === "NOT_DOCUMENTED" ? ["whether the recommended care was rendered at all (records not produced)"] : []),
    ...(condMeta?.hasMissingInfo ? ["outstanding records or specialist confirmation identified for this diagnosis"] : []),
    ...points.filter((p) => !p.addressed).map((p) => `whether the care in "${p.guideline}" was undertaken`),
  ];
  const conf: ConfidenceResult = structuredConfidence({
    recordEvidenceCount: condMeta?.evidenceCount ?? recordSupport.length,
    hasObjectiveFindings: condMeta?.hasObjective ?? recordSupport.length > 0,
    physicianSupport: condMeta?.physicianConfirmed ?? false,
    guidelineSupport: bestLevel != null && bestLevel <= 2,
    bestEvidenceLevel: bestLevel,
    hasContradictoryEvidence: condMeta?.hasOpposing ?? false,
    hasMissingInfo: condMeta?.hasMissingInfo ?? false,
  });
  // The conclusion states its own evidentiary weight — in the rationale itself.
  opinion.push(
    `The evidentiary basis for this conclusion is ${strength.toLowerCase()}${bestLevel != null && bestLevel >= 8 ? " — weak evidence, and I characterize it as such" : ""}. ` +
      `${limitations.length ? `Limitations: ${limitations.join("; ")}. ` : ""}` +
      `${unknowns.length ? `What remains unknown: ${unknowns.join("; ")}. ` : ""}` +
      `My clinical confidence in this assessment is ${conf.level.toLowerCase()}${conf.level === "Indeterminate" ? " — there is not enough evidence to reason from" : ""}.`,
  );
  const assessment: SocAssessment = {
    verdict, narrative, opinion, points,
    evidence: { strength, limitations, unknowns, confidence: conf.level, confidenceFactors: conf.factors },
  };

  const rationale =
    documentation === "DOCUMENTED"
      ? `The chronology documents ${recordSupport.length} dated encounters addressing this diagnosis, mapped against the cited guidance below.`
      : documentation === "LIMITED"
        ? "A single dated encounter addressing this diagnosis appears in the reviewed records — thin documentation against the cited guidance."
        : "No dated encounter addressing this diagnosis was identified in the reviewed records.";
  const gaps =
    documentation === "NOT_DOCUMENTED"
      ? "The reviewed records do not document evaluation or management of this diagnosis; obtain the treating providers' records or physician clarification."
      : null;

  const standard = guidelines.length
    ? `${guidelines.length} clinical practice ${guidelines.length === 1 ? "guideline is" : "guidelines are"} cited for this diagnosis${userSources.length ? ` (${userSources.length} reviewer-added)` : ""}; the pertinent language is quoted verbatim below and the documented/planned care is assessed against it. The assessment is a preliminary, evidence-grounded aid — the final standard-of-care determination is the reviewing physician's.`
    : online
      ? "No clinical practice guideline with pertinent quotable language is on file for this diagnosis — the reviewing physician should identify the applicable specialty standard, or add a source below."
      : "Guideline lookup was unavailable (offline); re-run the pipeline with network access, or add a source below.";

  return { standard, guidelines, recordSupport, documentation, assessment, userNotes, rationale, gaps };
}

/**
 * Recompute the assessment for a case's conditions WITHOUT re-fetching guidance
 * from the network — reuses the located guidance already stored, merges the
 * current user inputs, and re-derives the verdict. Called after the user adds
 * or removes a note/source. Returns conditions updated.
 */
export async function recomputeSocForCase(caseId: string): Promise<number> {
  const conditions = await prisma.condition.findMany({ where: { caseId } });
  if (!conditions.length) return 0;
  const events = await prisma.chronologyEvent.findMany({ where: { caseId }, orderBy: { eventDate: "asc" } });
  const careServices = (await prisma.futureCareItem.findMany({ where: { caseId }, select: { service: true } })).map((i) => i.service);
  const primaryConditionId = conditions[0]?.id;
  const online = await literatureReachable().catch(() => true);
  let n = 0;
  for (const cond of conditions) {
    const prior = cond.socAnalysis as unknown as SocAnalysis | null;
    // Keep only the previously LOCATED guidance (drop prior user sources — they
    // are re-derived from the current user inputs).
    const located = (prior?.guidelines ?? []).filter((g) => !g.userProvided);
    const userInputs = await prisma.socUserInput.findMany({ where: { caseId, conditionName: cond.name }, orderBy: { createdAt: "asc" } });
    const soc = assembleAnalysis(cond.name, cond.id === primaryConditionId, located, events as EventRow[], careServices, userInputs, online, {
      evidenceCount: Array.isArray(cond.evidenceSources) ? (cond.evidenceSources as unknown[]).length : 0,
      hasObjective: !!cond.objectiveEvidence,
      hasOpposing: !!cond.opposingRecords,
      hasMissingInfo: !!cond.missingInfo,
      physicianConfirmed: cond.physicianConfirmed,
    });
    await prisma.condition.update({ where: { id: cond.id }, data: { socAnalysis: soc as unknown as Prisma.InputJsonValue } });
    n++;
  }
  return n;
}
