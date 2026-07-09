import { prisma } from "@/lib/db";
import { packFor, type CareTemplate } from "@/lib/engine/specialty";
import { CONDITION_CARE, BASELINE_CARE, resolveConditionKeys } from "@/lib/engine/careLibrary";
import { project, type CaseAssumptions } from "@/lib/engine/cost";
import { buildChronologyFromRecords } from "@/lib/engine/chronology";
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

  return {
    conditions: conditions.length,
    chronology: chronologyCount,
    futureCare: careItems.length,
    totalLifetime: Math.round(totalLifetime),
    totalPresentValue: Math.round(totalPresentValue),
  };
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
