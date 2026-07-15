// ─────────────────────────────────────────────────────────────────────────────
// Citation quality (Clinical Evidence Sprint). Pure, unit-tested logic that
// makes every citation clinically appropriate, relevant, transparent, and
// defensible:
//   • citationCompatible(): the HARD display gate — same diagnosis/body region,
//     same procedure family, same population. Keyword overlap alone never
//     qualifies an article; an incompatible article is hidden, everywhere.
//   • evaluateArticle(): the explicit relevance score (diagnosis, procedure,
//     region, population, clinical question, outcome, evidence level,
//     publication quality, recency) with the stored reason for selection, the
//     claim it supports, and its limitations.
//   • EVIDENCE_HIERARCHY: the 10-tier preference order; selectPrimary()
//     enforces that lower-level evidence is never the primary citation when
//     stronger evidence exists in the same set.
//   • structuredConfidence(): High / Moderate / Low / Indeterminate from record
//     quality, objective findings, physician support, guideline support,
//     literature quality, consistency, and missing information.
// ─────────────────────────────────────────────────────────────────────────────

import { bodyRegion, type BodyRegion } from "./integrity";

// ── Evidence hierarchy (sprint order, 1 = strongest) ─────────────────────────
export const EVIDENCE_HIERARCHY: { level: number; label: string; re: RegExp }[] = [
  { level: 1, label: "Clinical practice guideline", re: /\b(clinical practice guideline|practice guideline|guidelines? (?:for|on)|practice advisory|appropriate use criteria)\b/i },
  { level: 2, label: "Consensus statement", re: /\b(consensus statement|consensus recommendations?|expert consensus|position statement|delphi consensus)\b/i },
  { level: 3, label: "Systematic review", re: /\bsystematic review\b/i },
  { level: 4, label: "Meta-analysis", re: /\bmeta-?analys[ei]s\b/i },
  { level: 5, label: "Randomized controlled trial", re: /\b(randomi[sz]ed|\brct\b|controlled trial)\b/i },
  { level: 6, label: "Large prospective study", re: /\bprospective\b/i },
  { level: 7, label: "Registry study", re: /\b(registry|survivorship)\b/i },
  { level: 8, label: "Cohort study", re: /\b(cohort|longitudinal|retrospective (?:study|review|analysis))\b/i },
  { level: 9, label: "Case series", re: /\b(case series|retrospective series)\b/i },
  { level: 10, label: "Case report", re: /\b(case report|a case of|report of a case)\b/i },
];
const DEFAULT_TIER = { level: 8, label: "Clinical study" }; // unclassifiable → treat as observational

export function evidenceTier(text: string): { level: number; label: string } {
  for (const t of EVIDENCE_HIERARCHY) if (t.re.test(text)) return { level: t.level, label: t.label };
  return DEFAULT_TIER;
}

// ── Procedure families (article ↔ recommendation procedure compatibility) ────
const PROCEDURE_FAMILIES: { key: string; re: RegExp }[] = [
  { key: "arthroplasty", re: /\b(arthroplast|joint replacement|\btka\b|\btha\b|knee replacement|hip replacement|prosthes)\w*/i },
  { key: "fusion", re: /\b(fusion|arthrodesis|interbody|instrument(?:ed|ation))\b/i },
  { key: "decompression", re: /\b(discectom|laminectom|decompress|foraminotom)\w*/i },
  { key: "soft_tissue_repair", re: /\b(rotator cuff|tendon repair|ligament reconstruction|\bacl reconstruction|meniscus repair|labral repair)\b/i },
  { key: "injection", re: /\b(injection|epidural|nerve block|radiofrequency|ablation|viscosupplement|neuromodulat|nerve stimulat|spinal cord stimulat|\bscs\b)\w*/i },
  { key: "electrodiagnostics", re: /\b(\bemg\b|nerve conduction|electrodiagnos)\w*/i },
  { key: "imaging", re: /\b(\bmri\b|magnetic resonance|\bct\b|computed tomography|radiograph|x-?ray|ultrasound)\b/i },
  { key: "therapy", re: /\b(physical therapy|physiotherapy|occupational therapy|rehabilitation|exercise therapy|gait training)\b/i },
  // "non-pharmacological" is a negation and "medication-overuse headache" is a
  // disease name — neither marks a pharmacological intervention.
  { key: "medication", re: /\b(?:(?<!non-)pharmacolog\w*|medication(?!-overuse)|analgesi\w*|opioid\w*|gabapentin|nsaid\w*)/i },
  { key: "attendant_care", re: /\b(attendant care|home care|caregiver|nursing care)\b/i },
];
/** True for a longitudinal-management / office-visit / monitoring recommendation
 *  that has no procedure of its own — its literature is about frequency,
 *  follow-up, and medical necessity, not an operation. */
export function isManagementService(service: string): boolean {
  return MANAGEMENT_SERVICE.test(service) && procedureFamilies(service).length === 0;
}
export function procedureFamily(text: string): string | null {
  for (const f of PROCEDURE_FAMILIES) if (f.re.test(text)) return f.key;
  return null;
}
/** ALL procedure families named in the text — a combined service like
 *  "Lumbar decompression / fusion" legitimately spans two. */
export function procedureFamilies(text: string): string[] {
  return PROCEDURE_FAMILIES.filter((f) => f.re.test(text)).map((f) => f.key);
}

// A recommendation that is longitudinal management / office visits / monitoring
// rather than a discrete procedure — its literature is about frequency, follow-
// up, and medical necessity, not about performing an operation.
const MANAGEMENT_SERVICE = /\b(office visit|follow-?up|management visit|management|monitoring|surveillance|evaluation|consultation|clinic visit|\bvisits?\b|case management|coordination)\b/i;
// Discrete surgical/interventional families that a pure management rec cannot
// borrow (imaging, therapy, medication, attendant care are fine).
const PROCEDURAL_FAMILIES = new Set(["arthroplasty", "revision_arthroplasty", "fusion", "decompression", "soft_tissue_repair", "injection", "fracture_fixation"]);

// ── Population ───────────────────────────────────────────────────────────────
const PEDIATRIC = /\b(pediatric|paediatric|congenital|neonat\w*|infant|adolescen\w*|in children|childhood|\bchild\b|juvenile)\b/i;
// CRE v1 §12 — pregnancy/obstetric literature cannot support routine care for a
// non-pregnant (or male) patient without an explicit applicability analysis.
const OBSTETRIC = /\b(pregnan\w*|obstetric\w*|gestation\w*|peripartum|postpartum|antenatal|prenatal|in pregnancy)\b/i;

export interface ClinicalContext {
  /** the diagnosis the citation must speak to */
  diagnosis: string;
  /** the recommended service / intervention */
  service: string;
  /** patient is an adult (default true) */
  adult?: boolean;
  /** override region when the caller already resolved it */
  region?: BodyRegion;
}

interface ArticleLike { title?: string; abstract?: string; journal?: string; year?: string; pubtype?: string[]; citationCount?: number }

const STOP = new Set(["and", "the", "of", "with", "for", "due", "initial", "encounter", "unspecified", "chronic", "acute", "status", "post", "left", "right", "bilateral", "severe", "mild", "moderate", "pain", "injury", "fracture", "disorder", "syndrome", "care", "management", "treatment", "visits", "visit", "follow", "followup"]);
const terms = (s: string) => [...new Set((s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];

/**
 * HARD compatibility gate — must pass before an article may be displayed or
 * stored under a diagnosis/recommendation. Rejects keyword-only matches:
 *   1. Body region must match (a knee arthroplasty paper can never appear
 *      under lumbar fusion; rotator cuff never under THA).
 *   2. When both sides declare a procedure family, the families must match.
 *   3. Pediatric/congenital literature cannot support an adult recommendation
 *      unless the case itself is pediatric.
 */
export function citationCompatible(article: ArticleLike, ctx: ClinicalContext): { compatible: boolean; reason: string } {
  const hay = `${article.title ?? ""} ${(article.pubtype ?? []).join(" ")} ${article.abstract ?? ""}`;
  const artRegion = bodyRegion(hay);
  const ctxRegion = ctx.region ?? (bodyRegion(`${ctx.service} ${ctx.diagnosis}`) as BodyRegion);
  // 1 — region: when both sides are region-specific they must agree.
  if (artRegion !== "general" && ctxRegion !== "general" && artRegion !== ctxRegion) {
    return { compatible: false, reason: `body-region mismatch (article: ${artRegion.replace(/_/g, "/")}, recommendation: ${ctxRegion.replace(/_/g, "/")})` };
  }
  // 2 — procedure family: when both declare families, they must INTERSECT (a
  // combined service like "decompression / fusion" spans two families and is
  // compatible with an article in either).
  const artProcs = procedureFamilies(hay);
  const ctxProcs = procedureFamilies(ctx.service); // the RECOMMENDATION's own families
  if (artProcs.length && ctxProcs.length && !artProcs.some((f) => ctxProcs.includes(f))) {
    return { compatible: false, reason: `procedure mismatch (article: ${artProcs.join("/").replace(/_/g, " ")}, recommendation: ${ctxProcs.join("/").replace(/_/g, " ")})` };
  }
  // 2b — scope: a pure management / office-visit / monitoring recommendation
  // (no procedure of its own) is NOT supported by a study of a specific
  // surgical or interventional procedure. Pain-management office visits must
  // draw on management/follow-up literature — never a lumbar fusion or nerve-
  // stimulation trial. Imaging/therapy/medication studies remain compatible.
  const isManagement = MANAGEMENT_SERVICE.test(ctx.service) && ctxProcs.length === 0;
  if (isManagement && artProcs.some((f) => PROCEDURAL_FAMILIES.has(f))) {
    return { compatible: false, reason: `scope mismatch (a ${artProcs.find((f) => PROCEDURAL_FAMILIES.has(f))!.replace(/_/g, " ")} procedure study for a management/office-visit recommendation)` };
  }
  // 3 — population: pediatric literature cannot support an adult recommendation.
  const adult = ctx.adult !== false;
  if (adult && PEDIATRIC.test(`${article.title ?? ""} ${(article.pubtype ?? []).join(" ")}`)) {
    return { compatible: false, reason: "population mismatch (pediatric/congenital literature; adult recommendation)" };
  }
  // 3b — population: pregnancy/obstetric literature cannot support routine care
  // unless the recommendation or diagnosis is itself obstetric.
  const ctxObstetric = OBSTETRIC.test(`${ctx.service} ${ctx.diagnosis}`);
  if (!ctxObstetric && OBSTETRIC.test(`${article.title ?? ""} ${(article.pubtype ?? []).join(" ")}`)) {
    return { compatible: false, reason: "population mismatch (pregnancy/obstetric literature; non-obstetric recommendation)" };
  }
  return { compatible: true, reason: "region, procedure, and population compatible" };
}

// ── Full relevance evaluation ────────────────────────────────────────────────
export interface CitationRelevance {
  score: number; // 0..100
  evidenceLevel: number; // 1 (guideline) .. 10 (case report)
  evidenceLabel: string;
  diagnosisMatch: boolean;
  procedureMatch: boolean;
  regionMatch: boolean;
  populationMatch: boolean;
  questionMatch: boolean; // addresses necessity/frequency/duration/outcome/risk
  outcomeMatch: boolean;
  whyRelevant: string;
  /** the claim this citation supports (never a bare article listing) */
  supports: string;
  limitations: string | null;
  accepted: boolean;
}

/** The claim a citation is asked to support for a recommendation. */
export function claimFor(service: string, diagnosis: string): string {
  return `${service} is reasonable and necessary future care for ${diagnosis}, at the stated frequency and duration`;
}

const QUESTION = /\b(indicat\w+|necessit\w+|effectiv\w+|efficac\w+|outcome|frequen\w+|duration|interval|surveillance|follow-?up|complication|revision rate|survivorship|natural history|prognos\w+|recommend\w+)\b/i;

export function evaluateArticle(article: ArticleLike, ctx: ClinicalContext): CitationRelevance {
  const hay = `${article.title ?? ""} ${(article.pubtype ?? []).join(" ")}`;
  const abs = article.abstract ?? "";
  const both = `${hay} ${abs}`.toLowerCase();
  const gate = citationCompatible(article, ctx);
  const tier = evidenceTier(hay);

  const dxTerms = terms(ctx.diagnosis);
  const svcTerms = terms(ctx.service);
  const ctxRegion = ctx.region ?? bodyRegion(`${ctx.service} ${ctx.diagnosis}`);
  const diagnosisMatch = dxTerms.some((t) => both.includes(t));
  const procedureMatch = svcTerms.some((t) => both.includes(t)) || procedureFamilies(hay).some((f) => procedureFamilies(ctx.service).includes(f));
  const regionMatch = ctxRegion === "general" || bodyRegion(hay) === ctxRegion;
  const populationMatch = ctx.adult === false || !PEDIATRIC.test(hay);
  const questionMatch = QUESTION.test(both);
  const outcomeMatch = /\b(outcome|survivorship|complication|function\w*|improvement|revision|mortality|quality of life)\b/i.test(both);

  // Explicit factor scoring (each factor visible, none hidden).
  let score = 0;
  score += diagnosisMatch ? 24 : 0; // diagnosis relevance
  score += procedureMatch ? 22 : 0; // procedure/intervention relevance
  score += regionMatch ? 14 : 0; // body-region relevance
  score += populationMatch ? 8 : 0; // population relevance
  score += questionMatch ? 10 : 0; // clinical-question relevance
  score += Math.max(0, 12 - tier.level); // evidence level (guideline 11 … case report 2)
  const cc = article.citationCount ?? 0;
  score += cc >= 500 ? 5 : cc >= 100 ? 3 : cc >= 10 ? 1 : 0; // publication quality
  const year = parseInt(article.year ?? "", 10) || 0;
  const age = year ? new Date().getFullYear() - year : 99;
  score += age <= 5 ? 5 : age <= 12 ? 3 : age <= 20 ? 1 : 0; // recency
  score = Math.max(0, Math.min(100, score));

  // Acceptance requires the hard gate PLUS genuine clinical anchoring:
  // an article must speak to the diagnosis or the procedure — shared generic
  // keywords are not enough — and clear the overall threshold.
  const accepted = gate.compatible && (diagnosisMatch || procedureMatch) && score >= 45;

  const why = accepted
    ? [
        tier.label,
        diagnosisMatch ? "addresses the diagnosis" : null,
        procedureMatch ? "addresses the intervention" : null,
        questionMatch ? "speaks to necessity/frequency/outcomes" : null,
      ].filter(Boolean).join("; ")
    : gate.compatible
      ? `insufficient clinical anchoring (score ${score}; diagnosis ${diagnosisMatch ? "✓" : "✗"}, procedure ${procedureMatch ? "✓" : "✗"})`
      : gate.reason;

  const limitations = [
    tier.level >= 9 ? `${tier.label}-level evidence — low on the hierarchy; interpret cautiously` : null,
    !diagnosisMatch && procedureMatch ? "addresses the intervention generally, not this specific diagnosis" : null,
    !questionMatch ? "does not directly address necessity, frequency, or outcomes" : null,
    age > 12 && year ? `published ${year} — older literature` : null,
  ].filter(Boolean).join("; ") || null;

  return {
    score,
    evidenceLevel: tier.level,
    evidenceLabel: tier.label,
    diagnosisMatch,
    procedureMatch,
    regionMatch,
    populationMatch,
    questionMatch,
    outcomeMatch,
    whyRelevant: why,
    supports: claimFor(ctx.service, ctx.diagnosis),
    limitations,
    accepted,
  };
}

/**
 * Hierarchy enforcement: order accepted citations so the strongest evidence is
 * primary. Lower-level evidence is never primary when stronger exists.
 */
export function selectPrimary<T extends { relevance: { evidenceLevel: number; score: number } }>(cites: T[]): T[] {
  return [...cites].sort((a, b) => a.relevance.evidenceLevel - b.relevance.evidenceLevel || b.relevance.score - a.relevance.score);
}

// ── Structured confidence ────────────────────────────────────────────────────
export type ConfidenceLevel = "Very High" | "High" | "Moderate" | "Low" | "Indeterminate";
export interface ConfidenceInput {
  /** page-cited evidence sources on the supporting diagnosis */
  recordEvidenceCount: number;
  /** objective findings documented (imaging/exam/operative) */
  hasObjectiveFindings: boolean;
  /** a physician approval/modification action exists */
  physicianSupport: boolean;
  /** a guideline/consensus-level source supports it */
  guidelineSupport: boolean;
  /** best evidence level among accepted citations (1..10; null = none) */
  bestEvidenceLevel: number | null;
  /** contradictory evidence recorded */
  hasContradictoryEvidence: boolean;
  /** an open missing-information note exists */
  hasMissingInfo: boolean;
}
export interface ConfidenceResult { level: ConfidenceLevel; score: number; factors: string[] }

export function structuredConfidence(i: ConfidenceInput): ConfidenceResult {
  const factors: string[] = [];
  let score = 0;
  if (i.recordEvidenceCount >= 2) { score += 25; factors.push(`record support (${i.recordEvidenceCount} page-cited sources)`); }
  else if (i.recordEvidenceCount === 1) { score += 14; factors.push("record support (single source)"); }
  else factors.push("no page-cited record support");
  if (i.hasObjectiveFindings) { score += 15; factors.push("objective findings documented"); }
  if (i.physicianSupport) { score += 25; factors.push("physician review on file"); }
  if (i.guidelineSupport) { score += 15; factors.push("guideline/consensus support"); }
  if (i.bestEvidenceLevel != null) {
    const pts = Math.max(0, 12 - i.bestEvidenceLevel);
    score += pts;
    factors.push(`literature support (${EVIDENCE_HIERARCHY.find((t) => t.level === i.bestEvidenceLevel)?.label ?? "clinical study"})`);
  } else factors.push("no accepted literature");
  if (i.hasContradictoryEvidence) { score -= 15; factors.push("contradictory evidence on record"); }
  if (i.hasMissingInfo) { score -= 10; factors.push("open missing-information note"); }
  score = Math.max(0, Math.min(100, score));

  // Indeterminate: nothing to reason from (no records, no literature, no physician).
  const nothing = i.recordEvidenceCount === 0 && i.bestEvidenceLevel == null && !i.physicianSupport && !i.hasObjectiveFindings;
  const level: ConfidenceLevel = nothing ? "Indeterminate" : score >= 85 ? "Very High" : score >= 70 ? "High" : score >= 45 ? "Moderate" : "Low";
  return { level, score, factors };
}

// ── Evidence validation (wired into the case validation service) ─────────────
export interface EvidenceFinding {
  recommendation: string;
  result: string;
  issue: string;
  severity: "Critical" | "High" | "Moderate" | "Low";
  suggestedCorrection: string;
  exportBlocking: boolean;
}
interface ItemWithCitations {
  service: string;
  citation?: unknown;
  condition?: { name: string } | null;
  supersededAt?: Date | null;
}

/**
 * Validate the citations actually stored on a case's recommendations:
 *   • an incompatible citation (region/procedure/population vs. its own
 *     diagnosis+service) is Critical and blocks export;
 *   • weak evidence (case series / case report) held as the PRIMARY citation
 *     while stronger evidence sits in the same set is a High finding;
 *   • the same article reused across recommendations with different body
 *     regions is High (reuse is legitimate only within a compatible context).
 */
export function validateEvidenceQuality(items: ItemWithCitations[], adult: boolean): EvidenceFinding[] {
  const findings: EvidenceFinding[] = [];
  const useRegions = new Map<string, Set<string>>(); // article key → regions it appears under
  for (const it of items) {
    if (it.supersededAt) continue;
    const dx = it.condition?.name ?? it.service;
    const ctx: ClinicalContext = { diagnosis: dx, service: it.service, adult };
    const ctxRegion = bodyRegion(`${it.service} ${dx}`);
    const cites = (Array.isArray(it.citation) ? it.citation : it.citation ? [it.citation] : []) as { title?: string; pmid?: string; doi?: string; relevance?: { evidenceLevel?: number } }[];
    for (const cc of cites) {
      if (!cc?.title) continue;
      const gate = citationCompatible({ title: cc.title }, ctx);
      if (!gate.compatible) {
        findings.push({
          recommendation: it.service,
          result: "Incompatible citation",
          issue: `"${cc.title.slice(0, 90)}" — ${gate.reason}.`,
          severity: "Critical",
          suggestedCorrection: "Remove the citation or replace it with literature that addresses this diagnosis, region, and population.",
          exportBlocking: true,
        });
      }
      const key = (cc.pmid || cc.doi || cc.title).toLowerCase();
      if (!useRegions.has(key)) useRegions.set(key, new Set());
      useRegions.get(key)!.add(ctxRegion);
    }
    // Hierarchy enforcement on the stored set: primary must be the strongest.
    const levels = cites.map((cc) => cc.relevance?.evidenceLevel).filter((n): n is number => typeof n === "number");
    if (levels.length >= 2) {
      const primary = levels[0];
      const best = Math.min(...levels);
      if (primary >= 9 && best < primary) {
        findings.push({
          recommendation: it.service,
          result: "Weak primary citation",
          issue: `A ${primary === 10 ? "case report" : "case series"} is the primary citation while stronger evidence (level ${best}) exists in the same set.`,
          severity: "High",
          suggestedCorrection: "Reorder so the strongest evidence is primary (selectPrimary).",
          exportBlocking: false,
        });
      }
    }
  }
  // Cross-recommendation reuse across DIFFERENT body regions is never automatic.
  for (const [key, regions] of useRegions) {
    const specific = [...regions].filter((r) => r !== "general");
    if (new Set(specific).size > 1) {
      findings.push({
        recommendation: "(multiple)",
        result: "Cross-region article reuse",
        issue: `The same article (${key.slice(0, 60)}) is cited under recommendations in different body regions (${specific.join(", ")}).`,
        severity: "High",
        suggestedCorrection: "Keep the article only where it is region-compatible; find region-appropriate literature for the rest.",
        exportBlocking: false,
      });
    }
  }
  return findings;
}
