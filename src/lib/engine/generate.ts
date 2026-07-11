import { prisma } from "@/lib/db";
import { packFor, type CareTemplate } from "@/lib/engine/specialty";
import { CONDITION_CARE, BASELINE_CARE, resolveConditionKeys } from "@/lib/engine/careLibrary";
import { project, type CaseAssumptions } from "@/lib/engine/cost";
import { buildChronologyFromRecords } from "@/lib/engine/chronology";
import { findArticles, pubmedReachable, type Article } from "@/lib/literature/pubmed";
import { Prisma } from "@/generated/prisma";
import type { Case, CareCategory } from "@/generated/prisma";

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/**
 * Paraphrased summary of the medical-necessity point for a care item. When a
 * physician modifies the item and adds information, the same helper is re-run
 * with `extra` so the summary automatically folds in an appropriate version of
 * the newly added information.
 */
export function paraphraseSummary(
  o: { service: string; rationale?: string | null; probability: string; frequencyPerYear: number; isLifetime?: boolean | null; durationYears?: number | null; evidenceStrength?: string | null },
  extra?: string | null,
): string {
  const freq = o.isLifetime ? `${o.frequencyPerYear}×/yr across the life expectancy` : o.durationYears ? `${o.frequencyPerYear}×/yr for ${o.durationYears} year${o.durationYears === 1 ? "" : "s"}` : "on a one-time basis";
  let s = `${o.service} is recommended${o.rationale ? ` because ${o.rationale.replace(/\.$/, "").toLowerCase()}` : ""}. It is offered as ${o.probability.toLowerCase()} within a reasonable degree of medical probability, ${freq}${o.evidenceStrength ? `, and is ${o.evidenceStrength.toLowerCase()}` : ""}.`;
  const info = (extra ?? "").trim();
  if (info) s += ` Incorporating the physician's input: ${info}${/[.!?]$/.test(info) ? "" : "."}`;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// The generation pipeline. Turns a case (+ its records) into a chronology,
// causation map, future-care plan with costs, and adversarial reviews. Uses the
// deterministic specialty library so it runs with no API keys; a real LLM plugs
// in behind src/lib/llm without changing callers.
// ─────────────────────────────────────────────────────────────────────────────

export function assumptionsFor(c: Case): CaseAssumptions {
  let life = c.lifeExpectancyYears ?? undefined;
  if (life === undefined) {
    if (c.dateOfBirth) {
      const age = (Date.now() - c.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000);
      life = Math.max(1, 82 - age);
    } else {
      life = 40;
    }
  }
  return {
    lifeExpectancyYears: life,
    discountRate: c.discountRate,
    medicalInflation: c.medicalInflation,
    geographicFactor: c.geographicFactor,
  };
}

// Document ingestion (extraction + content classification) lives in
// src/lib/documents/ingest.ts.

// ── Plan generation (Modules 4–9) ────────────────────────────────────────────

export interface PlanResult {
  conditions: number;
  chronology: number;
  futureCare: number;
  totalLifetime: number;
  totalPresentValue: number;
}

export async function generatePlan(caseId: string): Promise<PlanResult> {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const a = assumptionsFor(c);
  const pack = packFor(c.injurySpecialty, c.diagnosis);
  const anchor = c.dateOfInjury ?? c.createdAt;

  // Regenerate: clear prior AI output (human edits are re-run explicitly).
  await prisma.$transaction([
    prisma.reviewFinding.deleteMany({ where: { caseId } }),
    prisma.futureCareItem.deleteMany({ where: { caseId } }),
    prisma.condition.deleteMany({ where: { caseId } }),
    prisma.chronologyEvent.deleteMany({ where: { caseId } }),
  ]);

  // Every injury-related diagnosis: the intake primary + additional diagnoses
  // and the specialty-pack conditions, so the causation map is comprehensive.
  const additionalDx = (Array.isArray(c.additionalDiagnoses) ? c.additionalDiagnoses : []) as { diagnosis?: string; icd10Code?: string }[];
  const conditions: { id: string }[] = [];
  const seenNames = new Set<string>();
  async function addCondition(data: { name: string; relatedness: "RELATED" | "AGGRAVATION" | "PREEXISTING_UNRELATED" | "SUBSEQUENT_UNRELATED" | "UNCLEAR"; confidence: number; reasoning: string; objectiveEvidence: string; missingInfo: string | null }) {
    const key = data.name.trim().toLowerCase();
    if (!key || seenNames.has(key)) return;
    seenNames.add(key);
    const cond = await prisma.condition.create({ data: { caseId, supportingRecords: "Derived from ingested records (see chronology).", ...data } });
    conditions.push(cond);
  }
  if (c.diagnosis) await addCondition({ name: c.diagnosis, relatedness: "RELATED", confidence: 78, reasoning: "Primary diagnosis of record, attributed to the reported injury mechanism.", objectiveEvidence: "See medical records and imaging.", missingInfo: null });
  for (const d of additionalDx) if (d?.diagnosis) await addCondition({ name: d.diagnosis, relatedness: "RELATED", confidence: 70, reasoning: "Injury-related secondary diagnosis pending physician confirmation.", objectiveEvidence: "See medical records.", missingInfo: "Physician confirmation recommended." });
  for (const t of pack.conditions) await addCondition({ name: t.name, relatedness: t.relatedness, confidence: t.confidence, reasoning: t.reasoning, objectiveEvidence: t.objectiveEvidence, missingInfo: t.confidence < 65 ? "Additional records / specialist opinion needed." : null });
  const primaryConditionId = conditions[0]?.id ?? null;

  // Chronology — records are screened for relevance to the complaint; only the
  // relevant clinical events go on the timeline, each with a one-sentence finding
  // and a link to its source document. Falls back to the specialty template only
  // when no relevant records exist yet.
  const chronoResult = await buildChronologyFromRecords(caseId);
  let chronologyCount = chronoResult.kept;
  if (chronologyCount === 0) {
    for (const e of pack.chronology) {
      await prisma.chronologyEvent.create({
        data: {
          caseId,
          eventDate: new Date(anchor.getTime() + e.dayOffset * 24 * 3600 * 1000),
          provider: e.provider,
          specialty: e.specialty,
          recordType: e.recordType,
          summary: e.summary,
          objectiveFindings: e.objectiveFindings,
          diagnosis: e.diagnosis,
          treatment: e.treatment,
          imagingFindings: e.imagingFindings,
          relevanceScore: e.relevanceScore,
          relatedness: "RELATED",
          sourcePage: 1,
        },
      });
    }
    chronologyCount = pack.chronology.length;
  }

  // Future care — comprehensive, DIAGNOSIS-DRIVEN, but restricted to
  // INJURY-RELATED diagnoses only. The corpus is the primary diagnosis, the
  // additional diagnoses (both entered as diagnoses of the injury), and the
  // specialty-pack conditions whose relatedness is RELATED or AGGRAVATION.
  // Pre-existing / unrelated / subsequent-unrelated conditions and the raw
  // mechanism are deliberately excluded so future care is not driven by
  // non-injury diagnoses (apportionment principle).
  const injuryRelated = pack.conditions.filter((pc) => pc.relatedness === "RELATED" || pc.relatedness === "AGGRAVATION");
  const corpus = [c.diagnosis, ...additionalDx.map((d) => d?.diagnosis), ...injuryRelated.map((pc) => pc.name)].filter(Boolean).join(" ; ");
  const matchedKeys = resolveConditionKeys(corpus);
  let care: CareTemplate[] = [];
  if (matchedKeys.length > 0) {
    for (const k of matchedKeys) care.push(...CONDITION_CARE[k]);
    care.push(...BASELINE_CARE);
  } else {
    care = pack.care;
  }
  const seenService = new Set<string>();
  const careItems = care.filter((t) => {
    const k = t.service.trim().toLowerCase();
    if (seenService.has(k)) return false;
    seenService.add(k);
    return true;
  });

  let totalLifetime = 0;
  let totalPresentValue = 0;
  for (const t of careItems) {
    const p = project(
      { category: t.category, unitCost: t.unitCost, frequencyPerYear: t.frequencyPerYear, durationYears: t.durationYears, isLifetime: !!t.isLifetime },
      a,
    );
    totalLifetime += p.lifetimeCost;
    totalPresentValue += p.presentValue;
    await prisma.futureCareItem.create({
      data: {
        caseId,
        conditionId: primaryConditionId,
        category: t.category,
        service: t.service,
        specialty: t.specialty,
        rationale: t.rationale,
        cptCode: t.cptCode ?? p.cptCode,
        probability: t.probability,
        confidence: t.confidence,
        frequencyPerYear: t.frequencyPerYear,
        durationYears: t.durationYears ?? null,
        isLifetime: !!t.isLifetime,
        unitCost: p.unitCost,
        annualCost: p.annualCost,
        lifetimeCost: p.lifetimeCost,
        presentValue: p.presentValue,
        lowCost: p.lowCost,
        highCost: p.highCost,
        pricingSource: p.pricingSource,
        evidenceStrength: t.evidenceStrength,
        literatureSupport: t.literatureSupport,
        lowerCostAlternative: t.lowerCostAlternative,
        defenseVulnerability: t.defenseVulnerability,
        missingSupport: t.probability === "SPECULATIVE" || t.confidence < 60 ? "Physician confirmation of medical necessity required." : null,
        plaintiffValue: t.probability === "PROBABLE" ? "Well-supported; core plan item." : "Supports comprehensive future care.",
        physicianSummary: paraphraseSummary(t),
      },
    });
  }

  await generateReviews(caseId);

  // Attach the strongest real supporting article (PubMed) to each item.
  // Best-effort — never blocks or fabricates; skipped when PubMed is unreachable.
  await enrichCitations(caseId).catch(() => {});

  return {
    conditions: conditions.length,
    chronology: chronologyCount,
    futureCare: careItems.length,
    totalLifetime: Math.round(totalLifetime),
    totalPresentValue: Math.round(totalPresentValue),
  };
}

/**
 * For each future-care item, find the TWO most service-specific real supporting
 * articles from PubMed. A candidate pool is gathered from a specificity-ordered
 * query chain and every candidate is scored on how directly it supports THIS
 * service (service terms present in the title, matching anatomical region,
 * evidence level, recency, and how specific the query that surfaced it was); the
 * two highest-scoring on-topic articles are stored. Requests are globally
 * rate-limited/retried in the pubmed module. Returns the number of items cited.
 */
// Keep parenthetical qualifiers ("(neurogenic bladder)") — they carry meaning.
const CLEAN_SERVICE = (s: string) => s.replace(/[()\/,&]/g, " ").replace(/\s+/g, " ").trim();
const REGION = /\b(lumbar|cervical|thoracic|spinal cord|spine|spinal|knee|hip|shoulder|brain|amputation|rotator cuff|radiculopath\w*|neuropath\w*|migraine|headache|concussion|arthroplasty)/i;
// Generic clinical filler that must NOT count as a service-specific hit on its
// own — otherwise an off-topic article whose title merely contains "follow-up"
// or "surveillance" would be scored as if it supported the recommendation.
const CITE_STOP = new Set([
  "with", "from", "after", "hours", "ongoing", "episodes", "follow", "followup", "office", "per", "one", "anticipated",
  "management", "outcomes", "outcome", "medical", "equipment", "supplies", "supply", "unit", "units", "device", "devices", "care",
  "health", "chronic", "disease", "illness", "prevention", "clinical", "patient", "patients", "guideline",
  "guidelines", "treatment", "therapy", "intervention", "interventions", "visits", "visit", "maintenance",
  "post", "operative", "serial", "surgery", "surgical", "home", "services", "service", "study", "studies",
  // clinical-process words: describe the encounter, not the specific service
  "referral", "specialty", "specialist", "routine", "consultation", "consult", "evaluation", "assessment",
  "monitoring", "surveillance", "screening", "education", "documentation", "total", "general", "annual",
  "periodic", "review", "reviews", "coordination", "ongoing", "adherence", "case", "report",
]);
// Broader body-region synonyms accepted by the relevance guard.
const REGION_SYN: Record<string, string[]> = {
  lumbar: ["spine", "spinal", "low back", "back pain"],
  cervical: ["spine", "spinal", "neck"],
  "spinal cord": ["spinal", "paraplegia", "tetraplegia", "sci"],
  knee: ["arthroplasty", "tka"],
  hip: ["arthroplasty", "tha"],
  brain: ["tbi", "concussion", "head injury"],
};
// Per-category fallback topic — short queries with at least one SPECIFIC term so
// the guard can distinguish a real match from generic filler.
const CATEGORY_TOPIC: Record<string, string> = {
  PHYSICIAN_VISIT: "physician follow-up adherence",
  SPECIALIST_VISIT: "specialty referral follow-up",
  PRIMARY_CARE: "care coordination",
  ORTHOPEDIC_SURGERY: "orthopedic surgery rehabilitation",
  NEUROSURGERY: "spine surgery rehabilitation",
  NEUROLOGY: "neurologic rehabilitation",
  PMR: "physiatry rehabilitation",
  PAIN_MANAGEMENT: "chronic pain rehabilitation",
  PSYCH: "psychotherapy trauma",
  PHYSICAL_THERAPY: "physical exercise rehabilitation",
  OCCUPATIONAL_THERAPY: "occupational therapy rehabilitation",
  SPEECH_THERAPY: "speech language rehabilitation",
  COGNITIVE_THERAPY: "cognitive rehabilitation",
  MEDICATION: "analgesic pharmacotherapy pain",
  INJECTION: "corticosteroid injection pain",
  IMAGING: "imaging surveillance",
  LABS: "laboratory monitoring",
  DME: "orthosis brace rehabilitation",
  ORTHOTICS_PROSTHETICS: "prosthesis orthosis rehabilitation",
  MOBILITY_AID: "wheelchair mobility rehabilitation",
  HOME_MODIFICATION: "home modification accessibility",
  VEHICLE_MODIFICATION: "driving adaptation disability",
  ATTENDANT_CARE: "personal assistance disability",
  SKILLED_NURSING: "home nursing rehabilitation",
  CASE_MANAGEMENT: "nurse manager care coordination",
  VOCATIONAL_REHAB: "vocational rehabilitation employment",
  FUTURE_SURGERY: "reoperation outcomes",
  REVISION_SURGERY: "revision arthroplasty reoperation",
  COMPLICATION_MANAGEMENT: "complication prevention rehabilitation",
  ASSISTIVE_TECH: "assistive technology disability",
  SUPPLIES: "neurogenic bladder bowel continence supplies",
  TRANSPORTATION: "transportation barriers disability",
  MISC: "rehabilitation",
};

// Administrative / non-anatomical services: their literature is about the
// service CONCEPT (care coordination, case management, personal-care attendant),
// not the patient's body region — so the anatomical region must not dominate.
const ADMIN_CATEGORIES = new Set<string>([
  "PRIMARY_CARE", "CASE_MANAGEMENT", "ATTENDANT_CARE", "SKILLED_NURSING", "TRANSPORTATION",
  "HOME_MODIFICATION", "VEHICLE_MODIFICATION", "VOCATIONAL_REHAB", "SUPPLIES", "MISC",
]);
// Distinctive words of a category topic (kept even when they are generic-clinical
// filler elsewhere) — for administrative items these ARE the service concept.
const TOPIC_STOP = new Set([
  "care", "disability", "rehabilitation", "chronic", "pain", "and", "the", "of", "for", "with",
  "case", "report", "home", "management", "services", "medical", "general",
]);
const topicTerms = (topic: string) => (topic.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((t) => !TOPIC_STOP.has(t));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Canonical anatomical region for a clinical phrase — understands vertebral
// level shorthand (L1, C5, T7) and "SCI", which the plain regex misses.
function regionOf(s: string): string {
  const m = s.match(REGION)?.[0]?.toLowerCase();
  if (m) return m;
  if (/\bsci\b/i.test(s)) return "spinal cord";
  if (/\bl[1-5]\b/i.test(s)) return "lumbar";
  if (/\bc[2-7]\b/i.test(s)) return "cervical";
  if (/\bt(1[0-2]|[1-9])\b/i.test(s)) return "thoracic";
  return "";
}
// Word-boundary, plural-insensitive term hit ("radiograph" ⊂ "radiographic",
// but "tens" no longer matches "hypertension").
const termHit = (hay: string, t: string) => new RegExp(`\\b${escapeRe(t.replace(/s$/, ""))}`).test(hay);
// Region match: multi-word regions ("spinal cord") by substring, single words by
// word boundary so "sci" cannot match "conscious"/"fascia".
const regionHit = (hay: string, r: string) => (r.includes(" ") ? hay.includes(r) : new RegExp(`\\b${escapeRe(r)}\\b`).test(hay));

// Significant, service-specific terms of a service name — the words a truly
// on-point article must speak to. Hyphenated tokens are split so "follow-up"
// contributes only its parts (both filtered out), never a spurious whole token;
// region words and generic clinical filler are removed. 3-char tokens are kept
// so specific acronyms survive (MRI, EMG, TKA, LSO, TENS).
function serviceTerms(svc: string): string[] {
  const out = new Set<string>();
  for (const tok of svc.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
    for (const part of tok.split("-")) {
      if (part.length >= 3 && !CITE_STOP.has(part) && !REGION.test(part)) out.add(part);
    }
  }
  return [...out];
}

// Evidence-level weight from PubMed publication types (guideline > meta-analysis
// ≈ systematic review > RCT > narrative review).
function evidenceScore(a: Article): number {
  const pts = (a.pubtype ?? []).map((p) => p.toLowerCase());
  const t = a.title.toLowerCase();
  if (pts.some((p) => p.includes("guideline")) || /\bguideline/.test(t)) return 8;
  if (pts.some((p) => p.includes("meta-analysis")) || /meta-analysis/.test(t)) return 7;
  if (pts.some((p) => p.includes("systematic")) || /systematic review/.test(t)) return 6;
  if (pts.some((p) => p.includes("randomized"))) return 4;
  if (pts.some((p) => p.includes("review"))) return 2;
  return 0;
}

interface Scored { art: Article; score: number; strong: boolean }

// Score one candidate for how specifically it supports THIS service. A candidate
// with none of the service terms AND no regional match is off-topic → null.
// When the anatomical region is known it dominates the score, so an article on
// the WRONG body region can never outrank an on-region one on the strength of a
// single generic shared word; service-term hits then rank the on-region pool by
// how precisely each addresses the specific service.
function scoreCandidate(a: Article, terms: string[], regions: string[], regionDominant: boolean, tierBonus: number, yearNow: number): Scored | null {
  const title = a.title.toLowerCase();
  const journal = a.journal.toLowerCase();
  const svcHits = terms.filter((t) => termHit(title, t)).length;
  const regionInTitle = regions.some((r) => regionHit(title, r));
  const regionInJournal = regions.some((r) => regionHit(journal, r));
  if (svcHits === 0 && !regionInTitle && !regionInJournal) return null; // off-topic
  const year = parseInt(a.year, 10) || 0;
  const recency = year >= yearNow - 5 ? 3 : year >= yearNow - 12 ? 2 : year >= 2000 ? 1 : 0;
  // When the service has an anatomical target, region dominates so a wrong-region
  // article can't win on one shared word; for administrative services the service
  // concept (terms) leads and region is only a mild tie-breaker.
  const regionPts = regionDominant ? (regionInTitle ? 40 : regionInJournal ? 15 : 0) : regionInTitle ? 8 : regionInJournal ? 4 : 0;
  // The query-specificity bonus is earned only when the candidate actually names
  // a service term — a region-only match from a specific query is not itself
  // service-specific and must not out-rank an on-concept article.
  const score = regionPts + svcHits * 10 + evidenceScore(a) + recency + (svcHits > 0 ? tierBonus : 0);
  const strong = regionDominant ? regionInTitle || regionInJournal || svcHits >= 2 : svcHits > 0;
  return { art: a, score, strong };
}

export async function enrichCitations(caseId: string): Promise<number> {
  if (!(await pubmedReachable())) return 0;
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  const items = await prisma.futureCareItem.findMany({ where: { caseId }, include: { condition: true } });
  const yearNow = new Date().getFullYear();
  // Cache the candidate pool per query so repeated lookups cost one fetch.
  const cache = new Map<string, Article[]>();
  const pool = async (query: string): Promise<Article[]> => {
    const key = query.toLowerCase();
    if (!cache.has(key)) cache.set(key, await findArticles(query, 12));
    return cache.get(key)!;
  };
  let n = 0;
  for (const it of items) {
    const context = it.condition?.name ?? c?.diagnosis ?? "";
    // Prefer the region named by the service itself (a knee item on a spine
    // case should search knee literature), else the condition's region.
    const region = regionOf(it.service) || regionOf(context);
    const regions = region ? [region, ...(REGION_SYN[region] ?? [])] : [];
    const svc = CLEAN_SERVICE(it.service);
    const catTopic = CATEGORY_TOPIC[it.category] ?? "rehabilitation";
    const isAdmin = ADMIN_CATEGORIES.has(it.category);
    // For administrative services fold the category concept into the scored terms
    // so the service concept (coordination, case management, attendant) can win.
    const terms = isAdmin ? [...new Set([...serviceTerms(svc), ...topicTerms(catTopic)])] : serviceTerms(svc);
    const regionDominant = !!region && !isAdmin;
    // Specificity-ordered query chain; the tier bonus rewards candidates that
    // surface from the more specific queries.
    const svcHasRegion = region ? new RegExp(`\\b${escapeRe(region)}\\b`, "i").test(svc) : true;
    const chain: { q: string; bonus: number }[] = [
      { q: svcHasRegion ? svc : `${svc} ${region}`.trim(), bonus: 6 },
      { q: svc, bonus: 5 },
      { q: `${catTopic} ${region}`.trim(), bonus: 1 },
      { q: catTopic, bonus: 0 },
      { q: context, bonus: 0 },
    ].filter((e, i, arr) => e.q.trim() && arr.findIndex((x) => x.q.toLowerCase() === e.q.toLowerCase()) === i);

    const best = new Map<string, Scored>(); // pmid → best score across tiers
    for (const { q, bonus } of chain) {
      for (const a of await pool(q)) {
        const s = scoreCandidate(a, terms, regions, regionDominant, bonus, yearNow);
        if (!s) continue;
        const prev = best.get(a.pmid);
        if (!prev || s.score > prev.score) best.set(a.pmid, s);
      }
      // Stop early once we hold two confidently on-topic articles.
      if ([...best.values()].filter((s) => s.strong).length >= 2) break;
    }

    const picks = [...best.values()].sort((x, y) => y.score - x.score).slice(0, 2).map((s) => s.art);
    await prisma.futureCareItem.update({
      where: { id: it.id },
      data: { citation: picks.length ? (picks as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    if (picks.length) n++;
  }
  return n;
}

// ── Adversarial reviews (Modules 10 & 11) ────────────────────────────────────

export async function generateReviews(caseId: string): Promise<void> {
  await prisma.reviewFinding.deleteMany({ where: { caseId } });
  const items = await prisma.futureCareItem.findMany({ where: { caseId } });
  const conditions = await prisma.condition.findMany({ where: { caseId } });
  const docCount = await prisma.document.count({ where: { caseId } });
  const objEvidence = conditions.map((x) => x.objectiveEvidence).filter(Boolean)[0] ?? "the ingested medical records and imaging";

  type Point = {
    kind: "DEFENSE" | "COMPLETENESS";
    side: "DEFENSE" | "PLAINTIFF";
    category: string;
    description: string;
    sourceRef: string;
    counterArgument: string;
    counterSource: string;
    counterCitation: string;
    vulnerability: "LOW" | "MODERATE" | "HIGH";
    relatedItemId?: string;
  };
  const points: Point[] = [];

  // Honest, citable authorities for the counter's support (no fabricated
  // article-level cites). These mirror the report's References section.
  const CITE = {
    NATURAL_HISTORY: "StatPearls / NCBI Bookshelf and peer-reviewed natural-history and complication-rate literature for the diagnosis.",
    ODG: "Official Disability Guidelines (ODG), Work Loss Data Institute — evidence-based treatment guidelines.",
    PRICING: "FAIR Health (fairhealth.org) billed-charge benchmarks by CPT/geography; CMS RVU/DMEPOS fee schedules.",
    LCP_STANDARDS: "Life Care Planning and Case Management Across the Lifespan, 5th ed. (ICHCC, 2024); A Physician's Guide to Life Care Planning, AAPLCP (2017).",
    RECORDS: "Medical records reviewed (see Records-Reviewed index) and treating-provider documentation.",
  };

  // Defense-raised challenges to INCLUDED items, each with a plaintiff counter.
  const speculative = items.filter((i) => i.probability === "SPECULATIVE" || i.probability === "NOT_SUPPORTED");
  for (const it of speculative) {
    points.push({
      kind: "DEFENSE", side: "DEFENSE", vulnerability: "HIGH", relatedItemId: it.id,
      category: `Speculative — ${it.service}`,
      description: `The defense will argue that "${it.service}" is ${it.probability.toLowerCase()} and is not established to a reasonable degree of medical probability.`,
      sourceRef: `Plan basis: evidence "${it.evidenceStrength ?? "case-specific"}"; ${it.missingSupport ?? "supporting documentation is limited."}`,
      counterArgument: `The item is reserved for treating-physician confirmation and priced conservatively (${money(it.lifetimeCost)} lifetime). Such care is a foreseeable, recognized sequela of the injury.`,
      counterSource: it.literatureSupport ?? "Injury-specific registry and complication-rate literature; " + objEvidence,
      counterCitation: CITE.NATURAL_HISTORY,
    });
  }

  const lifetimePossible = items.filter((i) => i.isLifetime && i.probability === "POSSIBLE").sort((a, b) => b.lifetimeCost - a.lifetimeCost).slice(0, 4);
  for (const it of lifetimePossible) {
    points.push({
      kind: "DEFENSE", side: "DEFENSE", vulnerability: "MODERATE", relatedItemId: it.id,
      category: `Lifetime duration — ${it.service}`,
      description: `The defense will argue that "${it.service}" is projected across the full life expectancy on a "possible" basis, overstating duration and cost.`,
      sourceRef: `Plan basis: ${it.frequencyPerYear}/yr over the lifetime horizon; unit cost ${money(it.unitCost)} (${it.pricingSource ?? "UCR"}).`,
      counterArgument: `The underlying condition is chronic and progressive; the projected frequency reflects averaged utilization with periodic flare-ups, and lifetime need is supported by the natural history of the diagnosis.`,
      counterSource: it.literatureSupport ?? "Natural-history / chronic-progression literature; " + objEvidence,
      counterCitation: CITE.NATURAL_HISTORY,
    });
  }

  const withAlt = items.filter((i) => i.lowerCostAlternative).slice(0, 4);
  for (const it of withAlt) {
    points.push({
      kind: "DEFENSE", side: "DEFENSE", vulnerability: "MODERATE", relatedItemId: it.id,
      category: `Cost / alternative — ${it.service}`,
      description: `The defense will argue a lower-cost alternative exists: ${it.lowerCostAlternative}`,
      sourceRef: `Plan basis: unit cost ${money(it.unitCost)} (${it.pricingSource ?? "UCR"}).`,
      counterArgument: `The recommended item reflects the accepted standard of care for the diagnosis; the proposed alternative is not clinically equivalent and does not meet the same medical need.`,
      counterSource: it.literatureSupport ?? (it.pricingSource ? `Benchmark pricing (${it.pricingSource}).` : "Benchmark pricing (FAIR Health / CMS)."),
      counterCitation: `${CITE.ODG} ${CITE.PRICING}`,
    });
  }

  if (docCount < 3) {
    points.push({
      kind: "DEFENSE", side: "DEFENSE", vulnerability: "HIGH",
      category: "Incomplete record set",
      description: `The defense will argue the plan rests on an incomplete record set (${docCount} record${docCount === 1 ? "" : "s"} reviewed).`,
      sourceRef: `Records reviewed: ${docCount}.`,
      counterArgument: `Outstanding records can be requested and incorporated; the current projections are grounded in the available documentation and the recognized natural history of the injuries.`,
      counterSource: "Records-reviewed list; treating-provider documentation.",
      counterCitation: CITE.RECORDS,
    });
  }

  // Plaintiff-raised challenges to OMISSIONS, each with a defense counter.
  const present = new Set(items.map((i) => i.category));
  const expected: [CareCategory, string, "LOW" | "MODERATE" | "HIGH"][] = [
    ["MEDICATION", "medication costs", "MODERATE"],
    ["PSYCH", "psychological care", "MODERATE"],
    ["PAIN_MANAGEMENT", "pain management", "MODERATE"],
    ["IMAGING", "imaging surveillance", "LOW"],
    ["HOME_MODIFICATION", "home modifications", "MODERATE"],
    ["TRANSPORTATION", "transportation", "LOW"],
    ["CASE_MANAGEMENT", "case management", "LOW"],
    ["ATTENDANT_CARE", "attendant care", "HIGH"],
  ];
  for (const [cat, label, sev] of expected) {
    if (present.has(cat)) continue;
    points.push({
      kind: "COMPLETENESS", side: "PLAINTIFF", vulnerability: sev,
      category: `Omitted — ${label}`,
      description: `The plaintiff will argue the plan should include ${label}, which is commonly required for injuries of this nature.`,
      sourceRef: `Standard life-care-planning practice and treatment guidelines for the diagnosis.`,
      counterArgument: `The defense will respond that, absent supporting documentation in the reviewed records, inclusion of ${label} would be speculative.`,
      counterSource: "Records-reviewed list; ODG guidance on medical necessity.",
      counterCitation: `${CITE.ODG} ${CITE.LCP_STANDARDS}`,
    });
  }

  if (points.length) await prisma.reviewFinding.createMany({ data: points.map((p) => ({ caseId, ...p })) });
}

/** Recompute all cost projections after assumption edits (Module 8 editable). */
export async function recomputeCosts(caseId: string): Promise<{ totalLifetime: number; totalPresentValue: number }> {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const a = assumptionsFor(c);
  const items = await prisma.futureCareItem.findMany({ where: { caseId } });
  let totalLifetime = 0;
  let totalPresentValue = 0;
  for (const it of items) {
    const p = project(
      { category: it.category, unitCost: it.unitCost, frequencyPerYear: it.frequencyPerYear, durationYears: it.durationYears, isLifetime: it.isLifetime },
      a,
    );
    totalLifetime += p.lifetimeCost;
    totalPresentValue += p.presentValue;
    await prisma.futureCareItem.update({
      where: { id: it.id },
      data: { annualCost: p.annualCost, lifetimeCost: p.lifetimeCost, presentValue: p.presentValue, lowCost: p.lowCost, highCost: p.highCost },
    });
  }
  return { totalLifetime: Math.round(totalLifetime), totalPresentValue: Math.round(totalPresentValue) };
}
