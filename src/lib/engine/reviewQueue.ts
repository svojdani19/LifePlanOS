// ─────────────────────────────────────────────────────────────────────────────
// Physician review queue (EPIC-005). Pure ordering + enrichment for the
// cross-case Physician Workspace: every recommendation awaiting review, ranked
// by what actually blocks a plan from going out — export-blocking findings
// first, then structurally invalid assessments, then gated (NEEDS_REVIEW)
// assessments, then by dollars at stake. The queue also names each item's
// weakest confidence dimensions so the physician reads the weakest part of the
// case first, not a wall of prose.
// ─────────────────────────────────────────────────────────────────────────────

import type { ConfidenceVector, EvidenceSufficiency } from "./clinicalReasoning";

export interface ReviewQueueItem {
  itemId: string;
  caseId: string;
  caseNumber: string;
  clientName: string;
  service: string;
  category: string;
  presentValue: number;
  probability: string;
  isLifetime: boolean;
  frequencyPerYear: number;
  durationYears: number | null;
  /** persisted assessment status: VALIDATED | NEEDS_REVIEW | INVALID | … | null */
  assessmentStatus: string | null;
  /** export-blocking validation findings naming this service */
  blockingFindings: string[];
  sufficiency: { score: number; threshold: number; sufficient: boolean; missing: string[] } | null;
  weakestDimensions: { dimension: string; score: number }[];
  necessityRationale: string | null;
  unknownCount: number;
}

/** Priority class drives the sort: lower = reviewed first. */
export function priorityOf(item: Pick<ReviewQueueItem, "blockingFindings" | "assessmentStatus">): number {
  if (item.blockingFindings.length > 0) return 0;
  if (item.assessmentStatus === "INVALID") return 1;
  if (item.assessmentStatus === "NEEDS_REVIEW") return 2;
  return 3;
}

export function orderReviewQueue<T extends ReviewQueueItem>(items: T[]): T[] {
  return [...items].sort((x, y) => {
    const p = priorityOf(x) - priorityOf(y);
    if (p !== 0) return p;
    return y.presentValue - x.presentValue;
  });
}

const DIMENSION_LABELS: Record<keyof ConfidenceVector, string> = {
  clinicalCertainty: "clinical certainty",
  evidenceQuality: "evidence quality",
  objectiveEvidence: "objective evidence",
  literatureSupport: "literature support",
  guidelineSupport: "guideline support",
  providerAgreement: "provider agreement",
  chronologyConsistency: "chronology consistency",
  medicalNecessity: "medical necessity",
  contradictoryEvidence: "contradiction burden",
  physicianReview: "physician review",
};

/**
 * The N weakest confidence dimensions. contradictoryEvidence is a BURDEN
 * (higher = more contradiction), so it is inverted before ranking; the
 * physicianReview dimension is excluded — it is low precisely because the item
 * is in this queue, and listing it tells the reviewer nothing.
 */
export function weakestDimensions(vector: Partial<ConfidenceVector> | null | undefined, take = 3): { dimension: string; score: number }[] {
  if (!vector) return [];
  const rows: { dimension: string; score: number }[] = [];
  for (const [key, label] of Object.entries(DIMENSION_LABELS) as [keyof ConfidenceVector, string][]) {
    if (key === "physicianReview") continue;
    const raw = vector[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    rows.push({ dimension: label, score: key === "contradictoryEvidence" ? 100 - raw : raw });
  }
  return rows.sort((a, b) => a.score - b.score).slice(0, take);
}

/** Compact sufficiency view for the queue row. */
export function sufficiencySummary(s: Partial<EvidenceSufficiency> | null | undefined): ReviewQueueItem["sufficiency"] {
  if (!s || typeof s.score !== "number" || typeof s.threshold !== "number") return null;
  return {
    score: s.score,
    threshold: s.threshold,
    sufficient: !!s.sufficient,
    missing: Array.isArray(s.missing) ? s.missing.slice(0, 5) : [],
  };
}
