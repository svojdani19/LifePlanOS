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
  const [items, conditions] = await Promise.all([
    prisma.futureCareItem.findMany({ where: { caseId } }),
    prisma.condition.findMany({ where: { caseId } }),
  ]);
  const report = runIntegrityCheck({
    recommendations: items as unknown as RecInput[],
    conditions: conditions as unknown as CondInput[],
    hasRecordSupport: (rec, matched) =>
      hasPatientRecordSupport(
        rec as { missingSupport?: string | null; confidence?: number },
        matched as (CondInput & { evidenceSources?: unknown }) | null,
      ),
  });
  return {
    findings: report.findings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    blocking: report.blocking,
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
