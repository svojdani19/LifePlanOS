// ─────────────────────────────────────────────────────────────────────────────
// Validation service — the server-side wrapper around the pure integrity check
// (src/lib/engine/integrity.ts). Loads a case's recommendations and diagnoses,
// runs the deterministic check, and PERSISTS the findings as ValidationFinding
// rows so the review workflow can display them without rebuilding a report.
//
// Findings are derived data: every run REPLACES the case's rows atomically.
// Called after plan (re)generation and on report export; also exposed via
// GET/POST /api/cases/:id/validation for on-demand refresh from the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import {
  runIntegrityCheck,
  hasPatientRecordSupport,
  type CondInput,
  type RecInput,
  type IntegrityReport,
} from "./integrity";
import { validateEvidenceQuality } from "./citationQuality";
import { buildRecommendationDossier, validateRecommendationCompleteness, type DossierChronoEvent, type DossierCondition } from "./medicalNecessity";
import { reasoningFindings, type ReasoningItem } from "./clinicalReasoning";
import type { CondInput as ReasoningCond } from "./integrity";

export interface CaseValidation {
  findings: {
    service: string;
    result: string;
    issue: string;
    severity: string;
    suggestion: string;
    exportBlocking: boolean;
  }[];
  blocking: boolean;
  counts: IntegrityReport["counts"];
}

/** Run the integrity check over a case's current data (no persistence). */
export async function validateCase(caseId: string): Promise<CaseValidation> {
  const [items, conditions, kase, chronology] = await Promise.all([
    prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null }, include: { condition: true } }),
    prisma.condition.findMany({ where: { caseId } }),
    prisma.case.findUnique({ where: { id: caseId }, select: { dateOfBirth: true } }),
    prisma.chronologyEvent.findMany({ where: { caseId } }),
  ]);
  const adult = !kase?.dateOfBirth || (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  const dossierCase = { subject: "the patient", pronounPoss: "the patient's", lifeExpectancyYears: 40, adult };
  const report = runIntegrityCheck({
    recommendations: items as unknown as RecInput[],
    conditions: conditions as unknown as CondInput[],
    hasRecordSupport: (rec, matched) =>
      hasPatientRecordSupport(
        rec as { missingSupport?: string | null; confidence?: number },
        matched as (CondInput & { evidenceSources?: unknown }) | null,
      ),
  });
  // Clinical Evidence Sprint — validate the stored citations themselves:
  // incompatible citations, weak primaries, cross-region article reuse.
  const evidenceFindings = validateEvidenceQuality(items as never, adult);
  // Refactor Sprint — each recommendation must be complete (supporting
  // diagnosis, objective evidence, medical-necessity rationale).
  const completenessFindings = items.flatMap((it) => {
    const cond = (it as { condition?: unknown }).condition as DossierCondition | null;
    const dossier = buildRecommendationDossier(it as never, cond, chronology as unknown as DossierChronoEvent[], dossierCase);
    return validateRecommendationCompleteness(it as never, dossier, !!cond);
  });
  // Clinical Reasoning Engine (Phase D) — reasoning-derived gating: double-count
  // detection (blocking) plus advisory frequency/support flags on totaled lines.
  const includedIds = new Set(items.filter((it) => report.perItem.get(it as unknown as RecInput)?.includedInTotal).map((it) => (it as { id: string }).id));
  const reasoning = reasoningFindings(
    items as unknown as ReasoningItem[],
    conditions as unknown as (ReasoningCond & { id: string })[],
    chronology as unknown as DossierChronoEvent[],
    dossierCase,
    includedIds,
  );
  const findings = [
    ...report.findings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    ...evidenceFindings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    ...completenessFindings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    ...reasoning.map((f) => ({
      service: f.service,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestion,
      exportBlocking: f.exportBlocking,
    })),
  ];
  return {
    findings,
    blocking: findings.some((f) => f.exportBlocking),
    counts: report.counts,
  };
}

/**
 * Validate and persist: atomically replace the case's ValidationFinding rows
 * with the current results. Returns the validation so callers can respond
 * without a second query.
 */
export async function persistCaseValidation(caseId: string, firmId: string): Promise<CaseValidation> {
  const v = await validateCase(caseId);
  await prisma.$transaction([
    prisma.validationFinding.deleteMany({ where: { caseId } }),
    ...(v.findings.length
      ? [prisma.validationFinding.createMany({ data: v.findings.map((f) => ({ ...f, caseId, firmId })) })]
      : []),
  ]);
  return v;
}
