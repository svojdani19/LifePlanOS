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
import { checkIndication } from "@/lib/engine/indications";
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
import { baselineLifeExpectancy, lifeExpectancyFindings, parseBasis, type BasisSex } from "./lifeExpectancy";
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
    prisma.case.findUnique({
      where: { id: caseId },
      select: { dateOfBirth: true, sex: true, lifeExpectancyYears: true, lifeExpectancyBasis: true },
    }),
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
  // Life-expectancy basis — the projection horizon every totaled lifetime line
  // multiplies through must have a recorded, internally consistent basis
  // (actuarial baseline, documented adjustments, or physician determination).
  const ageYears = kase?.dateOfBirth ? (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) : null;
  const currentBaseline = ageYears != null ? baselineLifeExpectancy(ageYears, (kase?.sex ?? "UNKNOWN") as BasisSex) : null;
  const lifetimeIncluded = items.filter(
    (it) => includedIds.has((it as { id: string }).id) && (it as { isLifetime?: boolean }).isLifetime,
  );
  const leFindings = lifeExpectancyFindings({
    basis: parseBasis(kase?.lifeExpectancyBasis),
    yearsInUse: kase?.lifeExpectancyYears ?? currentBaseline?.years ?? 40,
    currentBaseline,
    lifetimePresentValue: lifetimeIncluded.reduce((s, it) => s + ((it as { presentValue?: number }).presentValue ?? 0), 0),
    lifetimeItemCount: lifetimeIncluded.length,
  });
  // Indication checklists — the record must document each service's clinical
  // prerequisite. Unmet checklists are advisory findings, never silent drops.
  const evidenceQuotes = conditions
    .flatMap((c) => (Array.isArray((c as { evidenceSources?: unknown }).evidenceSources) ? ((c as { evidenceSources?: unknown }).evidenceSources as { quote?: string }[]) : []))
    .map((e) => e.quote ?? "");
  const corpus = [
    ...conditions.map((c) => (c as { name?: string; diagnosis?: string }).name ?? (c as { diagnosis?: string }).diagnosis ?? ""),
    ...evidenceQuotes,
    ...chronology.map((e) => (e as { description?: string | null }).description ?? ""),
  ].join(" \n ");
  const indicationFindings = items.flatMap((it) => {
    const r = checkIndication((it as { service: string }).service, corpus);
    if (!r || r.met) return [];
    return [{
      service: (it as { service: string }).service,
      result: "Indication checklist",
      issue: `The record does not document the clinical prerequisite for this service: ${r.requirement}.`,
      severity: "Moderate",
      suggestion: "Document the indication in the record, attach supporting evidence, or have the physician confirm/reject the item.",
      exportBlocking: false,
    }];
  });
  // Claim-level re-verification — every stored evidence quote must still exist
  // verbatim in its source document's extracted text (guards against stale or
  // drifted citations surviving re-ingestion).
  const docTexts = new Map(
    (await prisma.document.findMany({ where: { caseId }, select: { id: true, extractedText: true } })).map((d) => [d.id, d.extractedText ?? ""]),
  );
  const claimFindings = conditions.flatMap((c) => {
    const sources = Array.isArray((c as { evidenceSources?: unknown }).evidenceSources)
      ? ((c as { evidenceSources?: unknown }).evidenceSources as { documentId?: string; filename?: string; quote?: string }[])
      : [];
    return sources.flatMap((src) => {
      if (!src.quote || !src.documentId) return [];
      const text = docTexts.get(src.documentId);
      if (text == null) return [];
      const normalize = (x: string) => x.replace(/\s+/g, " ").trim();
      if (normalize(text).includes(normalize(src.quote).replace(/…$/, ""))) return [];
      return [{
        service: (c as { name?: string }).name ?? "condition evidence",
        result: "Evidence citation drift",
        issue: `A stored evidence quote no longer appears in its source document (${src.filename ?? src.documentId}): "${src.quote.slice(0, 80)}".`,
        severity: "High",
        suggestion: "Re-run evidence location for this condition; the source document changed since the quote was captured.",
        exportBlocking: false,
      }];
    });
  });
  const findings = [
    ...indicationFindings,
    ...claimFindings,
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
    ...leFindings.map((f) => ({
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
