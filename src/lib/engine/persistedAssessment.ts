/**
 * Validating a persisted clinical reasoning assessment before it is rendered.
 *
 * The report selects a persisted ClinicalReasoningAssessment when its
 * materialHash equals the recorded basisHash, and then casts it to
 * ReasoningAssessment and dereferences it — `alternativesConsidered.length`,
 * `alternativesConsidered[0].rationale`.
 *
 * Hash equality proves the row was computed FROM that basis. It says nothing
 * about the shape of the JSON that came back out of the database:
 * `alternativesConsidered` is a nullable Json column, so a stored `[null]`
 * matches the hash perfectly and throws on `.rationale`. The row being
 * "separately persisted" is exactly why it needs its own read-side check —
 * it was written by a different producer, at a different time, and nothing
 * about the hash re-validates it now.
 */

import {
  PROBABILITY_CLASSIFICATIONS,
  EVIDENCE_STRENGTHS,
  RECOMMENDATION_CONFIDENCES,
  type ReasoningAssessment,
} from "@/lib/engine/clinicalReasoning";

/** Exactly the fields the report renders from a persisted assessment. */
export type RenderableAssessment = Pick<
  ReasoningAssessment,
  "probabilityClassification" | "inclusionRationale" | "evidenceStrength" | "recommendationConfidence" | "residualUncertainty" | "alternativesConsidered"
>;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const inSet = (v: unknown, set: readonly string[]): boolean => isStr(v) && set.includes(v);

/**
 * The persisted row as a renderable assessment, or null when any rendered
 * field is missing, wrongly typed, or out of domain.
 *
 * All-or-nothing on purpose: a half-valid assessment rendered beside a
 * "not recorded" would read as though the record were partially authoritative,
 * when in fact the row cannot be trusted at all. The caller falls back to the
 * recorded basis, which is validated separately.
 */
export function readPersistedAssessment(row: unknown): RenderableAssessment | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  if (!inSet(r.probabilityClassification, PROBABILITY_CLASSIFICATIONS)) return null;
  if (!inSet(r.evidenceStrength, EVIDENCE_STRENGTHS)) return null;
  if (!inSet(r.recommendationConfidence, RECOMMENDATION_CONFIDENCES)) return null;
  if (!isStr(r.inclusionRationale)) return null;
  if (!isStr(r.residualUncertainty)) return null;

  // A nullable Json column. An absent value is an empty list — nothing to
  // print — but a non-array, or an element that is not a well-formed
  // alternative, means the row cannot be rendered.
  const alts = r.alternativesConsidered;
  let alternativesConsidered: { alternative: string; rationale: string }[] = [];
  if (alts !== null && alts !== undefined) {
    if (!Array.isArray(alts)) return null;
    for (const el of alts) {
      if (!el || typeof el !== "object") return null;
      const e = el as Record<string, unknown>;
      if (!isStr(e.alternative) || !isStr(e.rationale)) return null;
    }
    alternativesConsidered = alts as { alternative: string; rationale: string }[];
  }

  return {
    probabilityClassification: r.probabilityClassification as RenderableAssessment["probabilityClassification"],
    inclusionRationale: r.inclusionRationale as string,
    evidenceStrength: r.evidenceStrength as RenderableAssessment["evidenceStrength"],
    recommendationConfidence: r.recommendationConfidence as RenderableAssessment["recommendationConfidence"],
    residualUncertainty: r.residualUncertainty as string,
    alternativesConsidered,
  };
}
