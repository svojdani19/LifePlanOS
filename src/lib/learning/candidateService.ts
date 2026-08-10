// ─────────────────────────────────────────────────────────────────────────────
// From a confirmed defect to a change in behaviour — and back again.
//
// The gate this file exists to hold: NOTHING IS ADOPTED BECAUSE IT IMPROVED THE
// CASE THAT PRODUCED IT. A lesson drawn from one case, measured on that same
// case, is a restatement of the correction rather than evidence of anything. So
// a candidate is scored on cases it did not come from, and a candidate that
// regresses a safety-critical metric is rejected however much it improves
// elsewhere — those regressions are wrong clinical assertions under the
// program's signature, and there is nothing to trade them against.
//
// One correction is also not a clinical truth. A firm-scoped prior — how often
// this firm's physicians order a service, how long they continue it — changes
// what a draft proposes to a doctor, so it requires repeated, consistent
// correction before it may even be proposed.
//
// Retrieval is the other half. Guidance is fetched by firm, always, with no
// path that omits the filter; it is bounded in count and length; and it is
// sanitized again on the way out, because the cheapest place to catch a lesson
// carrying patient detail is immediately before it enters a prompt.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { assertPhiFree, MAX_GUIDANCE_CHARS } from "@/lib/learning/findingService";
import { profileFor, type FailureCode, type LearningMechanism } from "@/lib/learning/failureTaxonomy";

/**
 * How many independent corrections a firm must make before a clinical prior may
 * be proposed. One physician changing one number is a case decision.
 */
export const MIN_SUPPORT_FOR_CLINICAL_PRIOR = 3;

/** Retrieval bounds. A prompt is a budget, and guidance is the least of it. */
export const MAX_RETRIEVED_GUIDANCE = 5;
export const MAX_GUIDANCE_TOKENS = 400;

export interface CandidateInput {
  firmId: string;
  findingId: string;
  guidance: string;
  payload?: Record<string, unknown>;
}

/**
 * Propose a lesson from a confirmed defect.
 *
 * Refuses on an unvalidated or rejected finding, refuses when the failure code
 * has no mechanism that generalizes, and refuses a clinical prior until the
 * firm has corrected the same thing enough times to mean it.
 */
export async function promoteToCandidate(input: CandidateInput) {
  const finding = await prisma.learningFinding.findFirst({
    where: { id: input.findingId, firmId: input.firmId },
  });
  if (!finding) throw new Error("finding not found in this firm");
  if (finding.state !== "VALIDATED" && finding.state !== "REPAIRED") {
    throw new Error(`only a confirmed finding can become a lesson; this one is ${finding.state}`);
  }

  const code = finding.failureCode as FailureCode;
  const profile = profileFor(code);
  if (profile.mechanism === "NONE") {
    throw new Error(`${code} does not generalize beyond the case that produced it`);
  }

  assertPhiFree(input.guidance);

  if (profile.mechanism === "CLINICAL_PRIOR") {
    const support = await countSupportingFindings(input.firmId, code, finding.documentClass);
    if (support < MIN_SUPPORT_FOR_CLINICAL_PRIOR) {
      throw new Error(
        `a firm-scoped clinical prior needs ${MIN_SUPPORT_FOR_CLINICAL_PRIOR} consistent corrections; this firm has ${support}`,
      );
    }
  }

  const support = await countSupportingFindings(input.firmId, code, finding.documentClass);
  const candidate = await prisma.learningCandidate.create({
    data: {
      firmId: input.firmId,
      mechanism: profile.mechanism,
      failureCode: code,
      guidance: input.guidance,
      payload: (input.payload ?? {}) as unknown as object,
      documentClass: finding.documentClass,
      sectionType: finding.sectionType,
      scope: profile.scope,
      supportCount: Math.max(1, support),
      status: "DRAFT",
    },
  });

  await prisma.learningFinding.update({
    where: { id: finding.id },
    data: { state: "LEARNING_CANDIDATE", candidateId: candidate.id },
  });
  return candidate;
}

/** Confirmed findings of the same kind, which is what "repeated" means. */
export async function countSupportingFindings(firmId: string, code: FailureCode, documentClass: string | null) {
  return prisma.learningFinding.count({
    where: {
      firmId,
      failureCode: code,
      documentClass: documentClass ?? undefined,
      state: { in: ["VALIDATED", "REPAIRED", "LEARNING_CANDIDATE"] },
    },
  });
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Metrics whose regression can never be traded for a gain elsewhere. */
export const SAFETY_METRICS = [
  "unsupportedClaims",
  "negationReversal",
  "plannedAsDelivered",
  "wrongLaterality",
  "falseEncounterMerge",
  "crossTenantRetrieval",
  "unsupportedRecommendationInTotals",
] as const;

export type SafetyMetric = (typeof SAFETY_METRICS)[number];

export interface Scorecard {
  /** Cases the candidate was scored on. Must not include its own source case. */
  evaluatedCaseIds: string[];
  /** The case(s) the candidate came from, excluded from evaluation. */
  sourceCaseIds: string[];
  /** Metric → delta, positive being better, for every measured dimension. */
  deltas: Record<string, number>;
  /** Safety metric → delta, where any value above zero is a regression. */
  safetyDeltas: Partial<Record<SafetyMetric, number>>;
  /** Per-document-class deltas, so a gain here cannot hide a loss there. */
  byDocumentClass?: Record<string, number>;
}

export interface EvaluationVerdict {
  adopt: boolean;
  reasons: string[];
  safetyClean: boolean;
}

/**
 * Decide whether a candidate earned adoption.
 *
 * Held-out first: an evaluation that overlaps the candidate's own source cases
 * measures nothing, so that check comes before any metric is read.
 */
export function judgeCandidate(card: Scorecard): EvaluationVerdict {
  const reasons: string[] = [];

  const overlap = card.evaluatedCaseIds.filter((id) => card.sourceCaseIds.includes(id));
  if (overlap.length) {
    return { adopt: false, reasons: ["EVALUATION_OVERLAPS_TRAINING"], safetyClean: false };
  }
  if (!card.evaluatedCaseIds.length) {
    return { adopt: false, reasons: ["NO_HELD_OUT_CASES"], safetyClean: false };
  }

  const regressedSafety = SAFETY_METRICS.filter((m) => (card.safetyDeltas[m] ?? 0) > 0);
  const safetyClean = regressedSafety.length === 0;
  if (!safetyClean) {
    return { adopt: false, reasons: regressedSafety.map((m) => `SAFETY_REGRESSION:${m}`), safetyClean: false };
  }

  const improved = Object.entries(card.deltas).filter(([, d]) => d > 0);
  if (!improved.length) {
    return { adopt: false, reasons: ["NO_MEASURED_IMPROVEMENT"], safetyClean };
  }

  // A gain in one document class bought with a material loss in another is not
  // an improvement, it is a redistribution.
  const materiallyWorse = Object.entries(card.byDocumentClass ?? {}).filter(([, d]) => d < -0.05);
  if (materiallyWorse.length) {
    return {
      adopt: false,
      reasons: materiallyWorse.map(([k]) => `REGRESSION_IN_CLASS:${k}`),
      safetyClean,
    };
  }

  reasons.push(...improved.map(([k]) => `IMPROVED:${k}`));
  return { adopt: true, reasons, safetyClean };
}

export async function evaluateCandidate(candidateId: string, firmId: string, card: Scorecard) {
  const candidate = await prisma.learningCandidate.findFirst({ where: { id: candidateId, firmId } });
  if (!candidate) throw new Error("candidate not found in this firm");

  const verdict = judgeCandidate(card);
  const status = verdict.adopt ? "ADOPTED" : "REJECTED_NO_IMPROVEMENT";
  const updated = await prisma.learningCandidate.update({
    where: { id: candidate.id },
    data: {
      status,
      safetyClean: verdict.safetyClean,
      evaluation: { verdict, card } as unknown as object,
      adoptedAt: verdict.adopt ? new Date() : null,
    },
  });

  await prisma.learningFinding.updateMany({
    where: { candidateId: candidate.id },
    data: { state: verdict.adopt ? "ADOPTED" : "REJECTED_NO_IMPROVEMENT" },
  });
  return { candidate: updated, verdict };
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/**
 * Retire an adopted lesson and restore what it superseded.
 *
 * Rollback is not deletion: the retired candidate stays, with its evaluation
 * and its adoption timestamp, so the record of what the program believed and
 * when survives. Restoring the superseded version is what actually changes
 * behaviour back.
 */
export async function retireCandidate(candidateId: string, firmId: string) {
  const candidate = await prisma.learningCandidate.findFirst({ where: { id: candidateId, firmId } });
  if (!candidate) throw new Error("candidate not found in this firm");

  const retired = await prisma.learningCandidate.update({
    where: { id: candidate.id },
    data: { status: "RETIRED", retiredAt: new Date() },
  });
  await prisma.learningFinding.updateMany({ where: { candidateId: candidate.id }, data: { state: "RETIRED" } });

  if (candidate.supersedesId) {
    const prior = await prisma.learningCandidate.findFirst({
      where: { id: candidate.supersedesId, firmId },
    });
    if (prior) {
      await prisma.learningCandidate.update({
        where: { id: prior.id },
        data: { status: "ADOPTED", retiredAt: null, adoptedAt: prior.adoptedAt ?? new Date() },
      });
    }
  }
  return retired;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

export interface GuidanceQuery {
  firmId: string;
  mechanism: LearningMechanism;
  documentClass?: string | null;
  sectionType?: string | null;
  failureCodes?: FailureCode[];
  limit?: number;
}

export interface RetrievedGuidance {
  candidateId: string;
  version: number;
  text: string;
}

/**
 * Fetch the lessons that apply to this task.
 *
 * `firmId` is a required parameter rather than an option, so there is no call
 * shape that omits it — one firm's corrections must never surface while
 * processing another firm's case, and the way to guarantee that is to make the
 * unsafe query impossible to write rather than to remember not to write it.
 *
 * Only ADOPTED candidates are returned. A draft, a rejected candidate and a
 * retired one all influence nothing.
 */
export async function retrieveGuidance(query: GuidanceQuery): Promise<RetrievedGuidance[]> {
  if (!query.firmId) throw new Error("guidance retrieval requires a firm");
  const limit = Math.min(query.limit ?? MAX_RETRIEVED_GUIDANCE, MAX_RETRIEVED_GUIDANCE);

  const rows = await prisma.learningCandidate.findMany({
    where: {
      firmId: query.firmId,
      status: "ADOPTED",
      mechanism: query.mechanism,
      ...(query.documentClass ? { documentClass: query.documentClass } : {}),
      ...(query.sectionType ? { sectionType: query.sectionType } : {}),
      ...(query.failureCodes?.length ? { failureCode: { in: query.failureCodes } } : {}),
    },
    // Deterministic: most-supported first, then oldest, then id. The same firm
    // and task must produce the same prompt every time.
    orderBy: [{ supportCount: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, version: true, guidance: true },
  });

  const out: RetrievedGuidance[] = [];
  let budget = MAX_GUIDANCE_TOKENS;
  for (const row of rows) {
    const text = sanitizeGuidance(row.guidance);
    if (!text) continue;
    // Rough token budget: guidance is short structural prose.
    const cost = Math.ceil(text.length / 4);
    if (cost > budget) break;
    budget -= cost;
    out.push({ candidateId: row.id, version: row.version, text });
  }
  return out;
}

/**
 * Last check before a lesson enters a prompt.
 *
 * Anything that looks patient-specific is dropped rather than repaired: a
 * guidance sentence is cheap to lose and expensive to leak.
 */
export function sanitizeGuidance(text: string): string | null {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  try {
    assertPhiFree(trimmed);
  } catch {
    return null;
  }
  return trimmed.slice(0, MAX_GUIDANCE_CHARS);
}

/**
 * Record that a generated output was influenced by these lessons.
 *
 * Every result shaped by learning must be able to say which lessons shaped it —
 * otherwise a regression cannot be traced back to what caused it, and rollback
 * is a guess.
 */
export async function recordApplications(candidateIds: readonly string[]) {
  if (!candidateIds.length) return;
  await prisma.learningCandidate.updateMany({
    where: { id: { in: [...new Set(candidateIds)] } },
    data: { applicationCount: { increment: 1 } },
  });
}
