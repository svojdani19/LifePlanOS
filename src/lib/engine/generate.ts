import { prisma } from "@/lib/db";
import { packFor } from "@/lib/engine/specialty";
import { project, type CaseAssumptions } from "@/lib/engine/cost";
import { buildChronologyFromRecords } from "@/lib/engine/chronology";
import type { Case, CareCategory } from "@/generated/prisma";

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

  // Conditions (causation map).
  const conditions = [];
  for (const t of pack.conditions) {
    const cond = await prisma.condition.create({
      data: {
        caseId,
        name: t.name,
        relatedness: t.relatedness,
        confidence: t.confidence,
        reasoning: t.reasoning,
        objectiveEvidence: t.objectiveEvidence,
        supportingRecords: "Derived from ingested records (see chronology).",
        missingInfo: t.confidence < 65 ? "Additional records / specialist opinion needed." : null,
      },
    });
    conditions.push(cond);
  }
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

  // Future care + costs.
  let totalLifetime = 0;
  let totalPresentValue = 0;
  for (const t of pack.care) {
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
        cptCode: p.cptCode,
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
      },
    });
  }

  await generateReviews(caseId);

  return {
    conditions: pack.conditions.length,
    chronology: chronologyCount,
    futureCare: pack.care.length,
    totalLifetime: Math.round(totalLifetime),
    totalPresentValue: Math.round(totalPresentValue),
  };
}

// ── Adversarial reviews (Modules 10 & 11) ────────────────────────────────────

export async function generateReviews(caseId: string): Promise<void> {
  await prisma.reviewFinding.deleteMany({ where: { caseId } });
  const items = await prisma.futureCareItem.findMany({ where: { caseId } });
  const docCount = await prisma.document.count({ where: { caseId } });

  const findings: {
    kind: "DEFENSE" | "COMPLETENESS";
    category: string;
    description: string;
    vulnerability: "LOW" | "MODERATE" | "HIGH";
    relatedItemId?: string;
  }[] = [];

  // Defense vulnerability critique.
  const seenCategory = new Map<CareCategory, string>();
  for (const it of items) {
    if (it.probability === "SPECULATIVE" || it.probability === "NOT_SUPPORTED") {
      findings.push({ kind: "DEFENSE", category: "Speculative recommendation", description: `"${it.service}" is labeled ${it.probability.toLowerCase()} — vulnerable absent stronger support.`, vulnerability: "HIGH", relatedItemId: it.id });
    }
    if (it.physicianStatus === "PENDING" && it.defenseVulnerability === "HIGH") {
      findings.push({ kind: "DEFENSE", category: "Missing physician support", description: `"${it.service}" carries high exposure and lacks physician sign-off.`, vulnerability: "HIGH", relatedItemId: it.id });
    }
    if (it.isLifetime && it.probability === "POSSIBLE") {
      findings.push({ kind: "DEFENSE", category: "Overbroad lifetime recommendation", description: `"${it.service}" is projected for the full life expectancy on a "possible" basis.`, vulnerability: "MODERATE", relatedItemId: it.id });
    }
    if (seenCategory.has(it.category)) {
      findings.push({ kind: "DEFENSE", category: "Duplicative services", description: `"${it.service}" overlaps with "${seenCategory.get(it.category)}" in the same category.`, vulnerability: "MODERATE", relatedItemId: it.id });
    } else {
      seenCategory.set(it.category, it.service);
    }
  }
  if (docCount < 3) {
    findings.push({ kind: "DEFENSE", category: "Missing records", description: `Only ${docCount} record(s) ingested — plan may rest on an incomplete record set.`, vulnerability: "HIGH" });
  }

  // Plaintiff completeness check — flag commonly-expected categories that are absent.
  const present = new Set(items.map((i) => i.category));
  const expected: [CareCategory, string, "LOW" | "MODERATE" | "HIGH"][] = [
    ["MEDICATION", "Omitted medication costs", "MODERATE"],
    ["PSYCH", "Omitted psychological care", "MODERATE"],
    ["PAIN_MANAGEMENT", "Omitted pain management", "MODERATE"],
    ["IMAGING", "Omitted imaging surveillance", "LOW"],
    ["HOME_MODIFICATION", "Omitted home modifications", "MODERATE"],
    ["TRANSPORTATION", "Omitted transportation", "LOW"],
    ["CASE_MANAGEMENT", "Omitted case management", "LOW"],
  ];
  for (const [cat, label, sev] of expected) {
    if (!present.has(cat)) {
      findings.push({ kind: "COMPLETENESS", category: label, description: `No ${label.replace("Omitted ", "")} item is present — confirm whether the injury warrants it.`, vulnerability: sev });
    }
  }

  if (findings.length) {
    await prisma.reviewFinding.createMany({ data: findings.map((f) => ({ caseId, ...f })) });
  }
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
