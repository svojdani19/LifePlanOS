import { prisma } from "@/lib/db";
import { packFor, type CareTemplate } from "@/lib/engine/specialty";
import { CONDITION_CARE, BASELINE_CARE, resolveConditionKeys } from "@/lib/engine/careLibrary";
import { project, type CaseAssumptions } from "@/lib/engine/cost";
import { buildChronologyFromRecords } from "@/lib/engine/chronology";
import { locateConditionEvidence } from "@/lib/engine/evidence";
import { generateStandardOfCare } from "@/lib/engine/standardOfCare";
import { mapRecommendationToCondition, type CondInput } from "@/lib/engine/integrity";
import { planRegeneration } from "@/lib/engine/lifecycle";
import { rebuildEvidenceGraph } from "@/lib/engine/evidenceGraph";
import { citationCompatible, evaluateArticle, selectPrimary } from "@/lib/engine/citationQuality";
import { findCandidates, literatureReachable, activeSources, type Article } from "@/lib/literature";
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
  /** reviewed items preserved as superseded versions (P2.R1) */
  superseded: number;
}

export async function generatePlan(caseId: string, actor?: { userId?: string; role?: string }): Promise<PlanResult> {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const a = assumptionsFor(c);
  const pack = packFor(c.injurySpecialty, c.diagnosis);
  const anchor = c.dateOfInjury ?? c.createdAt;

  // Regenerate: clear prior AI output — but NEVER delete a recommendation with
  // review history (P2.R1). Reviewed items are marked superseded (their review
  // actions preserved verbatim); only untouched AI drafts are replaced.
  const priorItems = await prisma.futureCareItem.findMany({
    where: { caseId, supersededAt: null },
    select: { id: true, service: true, lineageId: true, version: true, physicianStatus: true, physicianNote: true, edited: true, lifecycleStatus: true },
  });
  const regen = planRegeneration(priorItems);
  const now = new Date();
  await prisma.$transaction([
    prisma.reviewFinding.deleteMany({ where: { caseId } }),
    ...(regen.deleteIds.length ? [prisma.futureCareItem.deleteMany({ where: { caseId, id: { in: regen.deleteIds } } })] : []),
    ...(regen.supersede.length
      ? [prisma.futureCareItem.updateMany({ where: { caseId, id: { in: regen.supersede.map((i) => i.id) } }, data: { supersededAt: now, lifecycleStatus: "SUPERSEDED" } })]
      : []),
    prisma.condition.deleteMany({ where: { caseId } }),
    prisma.chronologyEvent.deleteMany({ where: { caseId } }),
  ]);
  // Ledger: one supersession transition per preserved item (P2.R1 §4).
  if (regen.supersede.length) {
    await prisma.recommendationTransition.createMany({
      data: regen.supersede.map((it) => ({
        caseId,
        firmId: c.firmId,
        lineageId: it.lineageId,
        itemId: it.id,
        userId: actor?.userId ?? null,
        role: actor?.role ?? "system",
        priorStatus: it.lifecycleStatus,
        newStatus: "SUPERSEDED",
        comment: "Plan regeneration — review history preserved on this version.",
      })),
    });
  }

  // Every injury-related diagnosis: the intake primary + additional diagnoses
  // and the specialty-pack conditions, so the causation map is comprehensive.
  const additionalDx = (Array.isArray(c.additionalDiagnoses) ? c.additionalDiagnoses : []) as { diagnosis?: string; icd10Code?: string }[];
  // Records once, for locating each condition's objective evidence (doc + page + quote).
  const caseDocs = await prisma.document.findMany({ where: { caseId }, select: { id: true, filename: true, type: true, extractedText: true, pageCount: true } });
  const conditions: { id: string }[] = [];
  const conditionNames: string[] = [];
  const seenNames = new Set<string>();
  async function addCondition(data: { name: string; relatedness: "RELATED" | "AGGRAVATION" | "PREEXISTING_UNRELATED" | "SUBSEQUENT_UNRELATED" | "UNCLEAR"; confidence: number; reasoning: string; objectiveEvidence: string; missingInfo: string | null }) {
    const key = data.name.trim().toLowerCase();
    if (!key || seenNames.has(key)) return;
    seenNames.add(key);
    // Locate the actual evidence in the records: document, page, verbatim quote.
    const sources = locateConditionEvidence(caseDocs, data.name);
    // A generic placeholder gives way to the strongest located quote.
    const objectiveEvidence =
      /^see medical records/i.test(data.objectiveEvidence) && sources[0]
        ? `"${sources[0].quote}" (${sources[0].filename}${sources[0].page ? `, p. ${sources[0].page}` : ""})`
        : data.objectiveEvidence;
    const supportingRecords = sources.length
      ? sources.map((s) => `${s.filename}${s.page ? ` p. ${s.page}` : ""}`).join("; ")
      : "Derived from ingested records (see chronology).";
    const cond = await prisma.condition.create({
      data: {
        caseId,
        supportingRecords,
        ...data,
        objectiveEvidence,
        evidenceSources: sources.length ? (sources as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    conditions.push(cond);
    conditionNames.push(data.name);
  }
  if (c.diagnosis) await addCondition({ name: c.diagnosis, relatedness: "RELATED", confidence: 78, reasoning: "Primary diagnosis of record, attributed to the reported injury mechanism.", objectiveEvidence: "See medical records and imaging.", missingInfo: null });
  for (const d of additionalDx) if (d?.diagnosis) await addCondition({ name: d.diagnosis, relatedness: "RELATED", confidence: 70, reasoning: "Injury-related secondary diagnosis pending physician confirmation.", objectiveEvidence: "See medical records.", missingInfo: "Physician confirmation recommended." });
  for (const t of pack.conditions) await addCondition({ name: t.name, relatedness: t.relatedness, confidence: t.confidence, reasoning: t.reasoning, objectiveEvidence: t.objectiveEvidence, missingInfo: t.confidence < 65 ? "Additional records / specialist opinion needed." : null });
  const primaryConditionId = conditions[0]?.id ?? null;

  // Future care — comprehensive, DIAGNOSIS-DRIVEN, but restricted to
  // INJURY-RELATED diagnoses only. The corpus is the primary diagnosis, the
  // additional diagnoses (both entered as diagnoses of the injury), and the
  // specialty-pack conditions whose relatedness is RELATED or AGGRAVATION.
  // Pre-existing / unrelated / subsequent-unrelated conditions and the raw
  // mechanism are deliberately excluded so future care is not driven by
  // non-injury diagnoses (apportionment principle). Resolved BEFORE the
  // chronology so the timeline can be tied to the anticipated care.
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

  // Chronology — records are screened for relevance; only pivotal events and
  // those bearing on a diagnosis or anticipated future-care item go on the
  // timeline, each described specifically and tied to the causation map & care
  // plan. Falls back to the specialty template only when no relevant records.
  const chronoResult = await buildChronologyFromRecords(caseId, { conditions: conditionNames, careServices: careItems.map((t) => t.service) });
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

  let totalLifetime = 0;
  let totalPresentValue = 0;
  for (const t of careItems) {
    const p = project(
      { category: t.category, unitCost: t.unitCost, frequencyPerYear: t.frequencyPerYear, durationYears: t.durationYears, isLifetime: !!t.isLifetime },
      a,
    );
    totalLifetime += p.lifetimeCost;
    totalPresentValue += p.presentValue;
    // Continue the lineage when a reviewed prior version of this service was
    // superseded above: same lineageId, version+1, forward pointer (P2.R1 §2).
    const lineage = regen.lineageForService.get(t.service.trim().toLowerCase());
    const created = await prisma.futureCareItem.create({
      data: {
        caseId,
        // Map each item to the diagnosis it actually belongs to (by body region),
        // rather than defaulting every item to the primary condition. Falls back
        // to the primary only for region-agnostic services.
        conditionId: mapRecommendationToCondition({ service: t.service, specialty: t.specialty }, conditions as unknown as CondInput[]).conditionId ?? primaryConditionId,
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
        ...(lineage ? { lineageId: lineage.lineageId, version: lineage.version + 1 } : {}),
      },
    });
    if (lineage) {
      await prisma.futureCareItem.update({ where: { id: lineage.priorId }, data: { supersededById: created.id } });
    }
  }

  await generateReviews(caseId);

  // Standard-of-care analysis per causation item: locate real clinical practice
  // guidelines, quote their direct language verbatim, and map the documented
  // care against them. Best-effort — never blocks or fabricates.
  await generateStandardOfCare(caseId).catch(() => {});

  // Attach the strongest real supporting article (PubMed) to each item.
  // Best-effort — never blocks or fabricates; skipped when PubMed is unreachable.
  await enrichCitations(caseId).catch(() => {});

  // Materialize the evidence graph from the structured output above (P2).
  await rebuildEvidenceGraph(caseId, c.firmId).catch(() => {});

  return {
    conditions: conditions.length,
    chronology: chronologyCount,
    futureCare: careItems.length,
    superseded: regen.supersede.length,
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
// Word-boundary term hit. Longer words match as a prefix and are plural-
// insensitive ("radiograph" ⊂ "radiographic"); short/acronym terms (≤4 chars,
// e.g. TENS, EMG, MRI, LSO) require a whole-word match so "tens" can't match
// "TENotomy"/"hyperTENSion" and "emg" can't match "EMGaged".
const termHit = (hay: string, t: string) => {
  const base = t.length >= 5 && t.endsWith("s") ? t.slice(0, -1) : t;
  const pat = base.length <= 4 ? `\\b${escapeRe(base)}\\b` : `\\b${escapeRe(base)}`;
  return new RegExp(pat).test(hay);
};
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

// Evidence-level weight from publication types across sources (guideline >
// meta-analysis ≈ systematic review > RCT > narrative review). Source pubtype
// vocabularies differ (PubMed "Meta-Analysis", Semantic Scholar "MetaAnalysis",
// Crossref "journal-article"), so title heuristics back up the type list.
function evidenceScore(a: Article): number {
  const pts = (a.pubtype ?? []).map((p) => p.toLowerCase());
  const t = a.title.toLowerCase();
  const has = (s: string) => pts.some((p) => p.includes(s));
  if (has("guideline") || /\bguideline/.test(t)) return 8;
  if (has("meta-analysis") || has("metaanalysis") || /meta-?analysis/.test(t)) return 7;
  if (has("systematic") || /systematic review/.test(t)) return 6;
  if (has("randomized") || has("clinicaltrial") || /randomi[sz]ed|\brct\b/.test(t)) return 4;
  if (has("review") || /\breview\b/.test(t)) return 2;
  return 0;
}

// Significant words of the patient's diagnosis/condition — the clinical problem
// an on-point article should actually concern. Lighter filtering than service
// terms (keeps clinical descriptors), region words are dropped since they are
// scored separately.
const COND_STOP = new Set([
  "severe", "chronic", "acute", "status", "post", "with", "and", "the", "mild", "moderate",
  "left", "right", "bilateral", "initial", "encounter", "unspecified", "history", "type",
]);
function conditionTerms(name: string): string[] {
  const out = new Set<string>();
  for (const tok of name.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
    for (const part of tok.split("-")) {
      if (part.length >= 3 && !COND_STOP.has(part) && !REGION.test(part)) out.add(part);
    }
  }
  return [...out];
}
// A compact diagnosis phrase for queries (drops severity/laterality fillers).
function condHint(name: string): string {
  return (name.match(/[a-z][a-z-]+/gi) ?? []).filter((w) => !COND_STOP.has(w.toLowerCase())).slice(0, 6).join(" ").trim();
}

interface ScoreCtx {
  terms: string[]; // service-specific terms
  condTerms: string[]; // diagnosis terms
  regions: string[]; // anatomical region + synonyms
  regionDominant: boolean;
  // Demote off-axis articles (wrong region, no diagnosis mention) — only for
  // clinical services; administrative services are scored on their concept, not
  // the patient's anatomy, so their ideal article won't name the diagnosis.
  applyAxisPenalty: boolean;
}
interface Scored { art: Article; score: number; strong: boolean }

// Score one candidate for how specifically it supports THIS service FOR THIS
// patient, judging on title AND abstract. An article that merely shares a
// service word but concerns the wrong body region / a different diagnosis (e.g.
// "Heel Pain" for a brain-injury pain item, or neuropsychiatric *lupus* for a
// TBI item) is pushed below anything actually on the patient's clinical axis.
function scoreCandidate(a: Article, ctx: ScoreCtx, tierBonus: number, yearNow: number): Scored | null {
  const T = a.title.toLowerCase();
  const A = (a.abstract ?? "").toLowerCase();
  const J = a.journal.toLowerCase();
  const hitBoth = (words: string[]) => {
    let t = 0, ab = 0;
    for (const w of words) {
      if (termHit(T, w)) t++;
      else if (A && termHit(A, w)) ab++;
    }
    return { t, ab };
  };
  const svc = hitBoth(ctx.terms);
  const cond = hitBoth(ctx.condTerms);
  const regT = ctx.regions.some((r) => regionHit(T, r));
  const regJ = ctx.regions.some((r) => regionHit(J, r));
  const regA = !regT && !!A && ctx.regions.some((r) => regionHit(A, r));
  const anyReg = regT || regJ || regA;
  const anySvc = svc.t > 0 || svc.ab > 0;
  const anyCond = cond.t > 0 || cond.ab > 0;
  // A citation must be about the SERVICE — a service term in its TITLE — or, for
  // anatomically-anchored services, its body region. A mere abstract mention or a
  // diagnosis match is NOT enough (a spasticity paper does not support a "pain
  // management" or "implant radiographs" line just because the patient is
  // spastic and the abstract says "pain"). Abstract/diagnosis are ranking bonuses.
  if (svc.t === 0 && !anyReg) return null;
  const onAxis = anyReg || anyCond; // also concerns the right region/diagnosis

  const year = parseInt(a.year, 10) || 0;
  const recency = year >= yearNow - 5 ? 3 : year >= yearNow - 12 ? 2 : year >= 2000 ? 1 : 0;
  const regionPts = ctx.regionDominant
    ? (regT ? 36 : regJ ? 15 : regA ? 12 : 0)
    : regT ? 10 : regA ? 6 : regJ ? 4 : 0;
  // Service match dominates; diagnosis match is a bonus that breaks ties toward
  // the article most on-point for THIS patient.
  const svcPts = svc.t * 14 + Math.min(svc.ab, 3) * 4;
  const condPts = cond.t > 0 ? 10 : cond.ab > 0 ? 4 : 0;
  const cc = a.citationCount ?? 0;
  const citePts = cc >= 1000 ? 6 : cc >= 200 ? 4 : cc >= 40 ? 2 : cc >= 5 ? 1 : 0;
  const tier = anySvc ? tierBonus : 0;
  // A weak, generic service match ("pain") on an article off the patient's axis
  // (wrong region, no diagnosis) is demoted so it can't beat an on-axis article.
  // A strong service match (≥2 terms) is exempt — its literature is naturally
  // patient-agnostic (e.g. "implant surveillance radiographs" technique papers).
  const offAxisPenalty = ctx.applyAxisPenalty && !onAxis && svc.t <= 1 && !regT ? -14 : 0;
  const score = regionPts + condPts + svcPts + evidenceScore(a) + recency + citePts + tier + offAxisPenalty;
  const strong = (onAxis && anySvc) || svc.t >= 2;
  return { art: a, score, strong };
}

export async function enrichCitations(caseId: string): Promise<number> {
  if (!(await literatureReachable())) return 0;
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  const items = await prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null }, include: { condition: true } });
  // Population gate: pediatric literature never supports an adult case.
  const adult = !c?.dateOfBirth || (Date.now() - c.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  const yearNow = new Date().getFullYear();
  console.log(`[citations] reviewing sources: ${activeSources().join(", ")}`);
  // Cache the merged candidate pool per query so repeated lookups cost one fan-out.
  const cache = new Map<string, Article[]>();
  const pool = async (query: string): Promise<Article[]> => {
    const key = query.toLowerCase();
    if (!cache.has(key)) cache.set(key, await findCandidates(query, 12));
    return cache.get(key)!;
  };
  let n = 0;
  // Track how many times each article is already used so ties break toward
  // variety — the same paper shouldn't be the top citation on many line items.
  const used = new Map<string, number>();
  for (const it of items) {
    const context = it.condition?.name ?? c?.diagnosis ?? "";
    // Prefer the region named by the service itself (a knee item on a TBI case
    // should search knee literature), else the linked diagnosis's region.
    const region = regionOf(it.service) || regionOf(context);
    const regions = region ? [region, ...(REGION_SYN[region] ?? [])] : [];
    const svc = CLEAN_SERVICE(it.service);
    const catTopic = CATEGORY_TOPIC[it.category] ?? "rehabilitation";
    const isAdmin = ADMIN_CATEGORIES.has(it.category);
    const terms = isAdmin ? [...new Set([...serviceTerms(svc), ...topicTerms(catTopic)])] : serviceTerms(svc);
    const condTerms = conditionTerms(context);
    const hint = condHint(context);
    const ctx: ScoreCtx = {
      terms,
      condTerms,
      regions,
      regionDominant: !!region && !isAdmin,
      applyAxisPenalty: !isAdmin && (regions.length > 0 || condTerms.length > 0),
    };
    // Specificity-ordered query chain; each query fans out to every source. The
    // diagnosis-anchored tiers keep the pool on the patient's clinical axis.
    const svcHasRegion = region ? new RegExp(`\\b${escapeRe(region)}\\b`, "i").test(svc) : true;
    const chain: { q: string; bonus: number }[] = [
      { q: svcHasRegion ? svc : `${svc} ${region}`.trim(), bonus: 6 },
      { q: hint ? `${svc} ${hint}` : svc, bonus: 6 },
      { q: svc, bonus: 5 },
      { q: `${catTopic} ${region || hint}`.trim(), bonus: 1 },
      { q: catTopic, bonus: 0 },
      { q: context, bonus: 0 },
    ].filter((e, i, arr) => e.q.trim() && arr.findIndex((x) => x.q.toLowerCase() === e.q.toLowerCase()) === i);

    const best = new Map<string, Scored>(); // dedup key → best score across tiers
    for (const { q, bonus } of chain) {
      for (const a of await pool(q)) {
        const s = scoreCandidate(a, ctx, bonus, yearNow);
        if (!s) continue;
        const prev = best.get(a.key);
        if (!prev || s.score > prev.score) best.set(a.key, s);
      }
      // Stop early once we hold two confidently on-axis, on-service articles.
      if ([...best.values()].filter((s) => s.strong).length >= 2) break;
    }

    // Clinical Evidence Sprint — the hard gate runs at SELECTION time, not just
    // display: every candidate must be region/procedure/population compatible
    // with THIS diagnosis + intervention and clear the explicit relevance
    // threshold. An article that only shares keywords is rejected here. The
    // same article may appear under another item only when it independently
    // passes that item's own gate (no automatic reuse across diagnoses).
    const clinicalCtx = { diagnosis: context || it.service, service: it.service, adult };
    const gated = [...best.values()]
      .map((s) => ({ ...s, relevance: evaluateArticle({ title: s.art.title, abstract: s.art.abstract, journal: s.art.journal, year: s.art.year, pubtype: s.art.pubtype, citationCount: s.art.citationCount }, clinicalCtx) }))
      .filter((s) => s.relevance.accepted);
    // Rank by relevance (variety-demoted), keep two, then order by the evidence
    // hierarchy so the PRIMARY citation is always the strongest evidence held.
    const chosen = selectPrimary(
      gated
        .sort((x, y) => y.relevance.score - (used.get(y.art.key) ?? 0) * 6 - (x.relevance.score - (used.get(x.art.key) ?? 0) * 6))
        .slice(0, 2),
    );
    for (const s of chosen) used.set(s.art.key, (used.get(s.art.key) ?? 0) + 1);
    // Store the display fields PLUS the transparent relevance record: why the
    // article was selected, what claim it supports, and its limitations.
    const picks = chosen.map(({ art, relevance }) => ({
        source: art.source,
        title: art.title,
        authors: art.authors,
        journal: art.journal,
        year: art.year,
        url: art.url,
        ...(art.pmid ? { pmid: art.pmid } : {}),
        ...(art.doi ? { doi: art.doi } : {}),
        relevance: {
          score: relevance.score,
          evidenceLevel: relevance.evidenceLevel,
          evidenceLabel: relevance.evidenceLabel,
          whyRelevant: relevance.whyRelevant,
          supports: relevance.supports,
          limitations: relevance.limitations,
        },
      }));
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
  const items = await prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null } });
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
  const items = await prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null } });
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
