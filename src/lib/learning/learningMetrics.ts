// ─────────────────────────────────────────────────────────────────────────────
// What the loop is actually doing, counted without looking at a patient.
//
// A learning system that cannot be measured cannot be trusted, and the two
// numbers that matter most are uncomfortable ones: how often the critic cries
// wolf, and how often the same defect comes back after the program supposedly
// learned from it. A repeat-failure rate that does not fall is the honest
// signal that a lesson did nothing.
//
// Everything here counts rows and dates. No metric reads a claim value, a
// record excerpt, a patient identifier or a model response — the aggregate is
// derived from state, code and timestamp alone, which is what makes it safe to
// log, chart and export.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { FAILURE_CODES, type FailureCode } from "@/lib/learning/failureTaxonomy";

export interface LearningMetrics {
  /** How many findings of each code, whatever their state. */
  failureCountByCode: Record<string, number>;
  /**
   * Share of findings that are a RECURRENCE — the same code, same firm, same
   * document class, seen before. New failures and recurring ones are different
   * problems: the first is discovery, the second is a lesson that did not work.
   */
  repeatFailureRate: number;
  repeatByCode: Record<string, number>;
  /** Of confirmed defects, how many the targeted retry actually fixed. */
  repairSuccessRate: number;
  /** Share of allegations a validator threw out. High means a noisy critic. */
  falsePositiveCriticRate: number;
  candidateAdoptionRate: number;
  candidateRollbackRate: number;
  /** How many generated outputs recorded applying a lesson. */
  learningRuleApplications: number;
  /** Share of findings whose validation came from a human rather than a check. */
  humanCorrectionRate: number;
  /** Mean number of changed fields per correction — a proxy for edit distance. */
  meanCorrectionSize: number;
  /** Findings still open, which block an unqualified audit pass. */
  unresolvedCount: number;
  totalFindings: number;
}

export interface MetricsWindow {
  firmId: string;
  since?: Date;
  until?: Date;
}

const zeroed = (): Record<string, number> => Object.fromEntries(FAILURE_CODES.map((c) => [c, 0]));

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;

/**
 * Aggregate the loop for one firm.
 *
 * Firm-scoped like everything else: a metric computed across tenants would leak
 * one firm's error profile into another's dashboard, which is a smaller version
 * of the same boundary the retrieval path defends.
 */
export async function computeLearningMetrics(window: MetricsWindow): Promise<LearningMetrics> {
  if (!window.firmId) throw new Error("learning metrics are firm-scoped");
  const createdAt =
    window.since || window.until
      ? { ...(window.since ? { gte: window.since } : {}), ...(window.until ? { lte: window.until } : {}) }
      : undefined;

  const findings = await prisma.learningFinding.findMany({
    where: { firmId: window.firmId, ...(createdAt ? { createdAt } : {}) },
    select: {
      failureCode: true,
      documentClass: true,
      state: true,
      validatorKind: true,
      validatorResult: true,
      repairAttempts: true,
      correctionDelta: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const candidates = await prisma.learningCandidate.findMany({
    where: { firmId: window.firmId },
    select: { status: true, applicationCount: true },
  });

  const failureCountByCode = zeroed();
  const repeatByCode = zeroed();
  const seen = new Set<string>();
  let repeats = 0;
  let validated = 0;
  let repaired = 0;
  let rejected = 0;
  let adjudicated = 0;
  let humanValidated = 0;
  let deltaFields = 0;
  let deltaCount = 0;
  let unresolved = 0;

  for (const f of findings) {
    failureCountByCode[f.failureCode] = (failureCountByCode[f.failureCode] ?? 0) + 1;

    // Recurrence is per code and document class: the same defect returning in
    // the same kind of record is what a lesson was supposed to prevent.
    const key = `${f.failureCode}::${f.documentClass ?? "-"}`;
    if (seen.has(key)) {
      repeats++;
      repeatByCode[f.failureCode] = (repeatByCode[f.failureCode] ?? 0) + 1;
    } else {
      seen.add(key);
    }

    if (f.validatorResult === "CONFIRMED") {
      validated++;
      adjudicated++;
      if (f.validatorKind !== "DETERMINISTIC") humanValidated++;
    } else if (f.validatorResult === "REJECTED") {
      rejected++;
      adjudicated++;
    }

    if (f.state === "REPAIRED") repaired++;
    if (f.state === "VALIDATED" || f.state === "UNRESOLVED") unresolved++;

    const delta = Array.isArray(f.correctionDelta) ? (f.correctionDelta as unknown[]) : [];
    if (delta.length) {
      deltaFields += delta.length;
      deltaCount++;
    }
  }

  const adopted = candidates.filter((c) => c.status === "ADOPTED").length;
  const retired = candidates.filter((c) => c.status === "RETIRED").length;
  const judged = candidates.filter((c) => c.status !== "DRAFT").length;

  return {
    failureCountByCode,
    repeatFailureRate: rate(repeats, findings.length),
    repeatByCode,
    // Of the defects worth repairing, how many the retry actually fixed.
    repairSuccessRate: rate(repaired, validated + repaired),
    falsePositiveCriticRate: rate(rejected, adjudicated),
    candidateAdoptionRate: rate(adopted, judged),
    candidateRollbackRate: rate(retired, adopted + retired),
    learningRuleApplications: candidates.reduce((n, c) => n + c.applicationCount, 0),
    humanCorrectionRate: rate(humanValidated, adjudicated),
    meanCorrectionSize: deltaCount === 0 ? 0 : Math.round((deltaFields / deltaCount) * 100) / 100,
    unresolvedCount: unresolved,
    totalFindings: findings.length,
  };
}

/**
 * Is this defect a recurrence, or the first time we have seen it?
 *
 * Asked at detection time so a finding can be routed differently: a first
 * occurrence is discovery, while the same code returning in the same kind of
 * record after a lesson was adopted is evidence the lesson failed and should be
 * reconsidered rather than reinforced.
 */
export async function isRepeatFailure(
  firmId: string,
  failureCode: FailureCode,
  documentClass: string | null,
): Promise<boolean> {
  const prior = await prisma.learningFinding.count({
    where: {
      firmId,
      failureCode,
      documentClass: documentClass ?? undefined,
      validatorResult: "CONFIRMED",
    },
  });
  return prior > 0;
}
