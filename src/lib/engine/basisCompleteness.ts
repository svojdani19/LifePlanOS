/**
 * Is a persisted basis actually usable as the authority for a report?
 *
 * The report tested individual subfields — `specification ? … : liveRow` — and
 * fell through to the live FutureCareItem whenever one was absent. A basis row
 * that exists but is legacy, partial or malformed therefore produced a document
 * that silently mixed recorded and current values, which is the precise failure
 * the recorded basis exists to prevent. The fallbacks fired exactly where the
 * record was weakest.
 *
 * Three states, and the distinction is the whole point:
 *
 *   ABSENT      no basis at all. Current values may render, in a clearly
 *               labelled draft, gated by the existing BASIS_MISSING finding.
 *   COMPLETE    every required subobject and field is present. The report reads
 *               it and nothing else.
 *   INCOMPLETE  a basis exists and cannot answer. NOTHING falls back to the
 *               live row — the report says "not recorded" and a deterministic,
 *               export-blocking finding names exactly which paths are missing.
 *
 * (UNREADABLE — the store could not be read at all — stays a separate state
 * owned by basisStore. Nothing was compared there, so it is not a statement
 * about any particular basis.)
 *
 * An intentionally empty recorded array is COMPLETE. "We recorded that there
 * are no contradictions" is an answer; "the contradictions field is absent" is
 * not, and conflating them would make every clean plan look defective.
 */

/** Dotted paths that must be present on a persisted basis. */
export const REQUIRED_BASIS_PATHS: readonly string[] = [
  "necessityNarrative",
  "specification",
  "specification.service",
  "specification.frequencyText",
  "specification.durationText",
  "specification.lifetimeQuantity",
  "specification.physicianStatus",
  "specification.recordSupported",
  "projectionBasis",
  "projectionBasis.frequencyPerYear",
  "projectionBasis.durationClass",
  "projectionBasis.isLifetime",
  "projectionBasis.unitCost",
  "projectionBasis.pricingSourceCategory",
  "probabilityBasis",
  "probabilityBasis.classification",
  "probabilityBasis.factors",
  "assessmentBasis",
  "assessmentBasis.inclusionInTotalsStatus",
  "assessmentBasis.probabilityClassification",
  "assessmentBasis.evidenceStrength",
  "assessmentBasis.recommendationConfidence",
  "assessmentBasis.medicalNecessityRationale",
  "assessmentBasis.potentialChallenges",
  "assessmentBasis.confidenceLevel",
  "acceptedEvidence",
  "acceptedEvidence.diagnoses",
  "acceptedEvidence.objectiveFindings",
  "acceptedEvidence.guidelines",
  "evidenceProvenance",
  "contradictions",
  "literature",
  "missingPremises",
];

/**
 * Paths whose value may legitimately be null.
 *
 * A recorded null is an ANSWER ("this item has no CPT code"), distinct from an
 * absent field. Only paths listed here may be null and still count as present;
 * everywhere else null means the basis cannot answer.
 */
export const NULLABLE_BASIS_PATHS: ReadonlySet<string> = new Set([
  "specification.supportingDiagnosis",
  "specification.responsibleSpecialty",
  "specification.cptCode",
  "specification.unitCost",
  "specification.lifetimeCost",
  "specification.presentValue",
  "projectionBasis.durationYears",
  "projectionBasis.pricingSourceId",
  "projectionBasis.pricedAt",
  "projectionBasis.horizonYears",
  "projectionBasis.discountRate",
  "projectionBasis.medicalInflation",
  "projectionBasis.geographicFactor",
]);

export type BasisState = "ABSENT" | "COMPLETE" | "INCOMPLETE";

export interface CompletenessResult {
  state: BasisState;
  /** Sorted dotted paths that are absent. Empty when COMPLETE or ABSENT. */
  missing: string[];
  /**
   * Stable fingerprint of the missing SHAPE. Two bases missing the same paths
   * produce the same fingerprint; a different gap is a different finding, so a
   * reviewer cannot resolve one shape of defect and silently close another.
   */
  fingerprint: string | null;
}

const at = (root: unknown, path: string): { found: boolean; value: unknown } => {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return { found: false, value: undefined };
    if (!(part in (cur as Record<string, unknown>))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
};

/** Cheap, stable, order-independent digest of the missing-path set. */
function fingerprintOf(missing: readonly string[]): string {
  let h = 2166136261;
  for (const p of [...missing].sort()) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x2f;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function assessBasisCompleteness(basis: unknown): CompletenessResult {
  if (basis === null || basis === undefined || typeof basis !== "object") {
    return { state: "ABSENT", missing: [], fingerprint: null };
  }
  const missing: string[] = [];
  for (const path of REQUIRED_BASIS_PATHS) {
    const { found, value } = at(basis, path);
    if (!found) {
      missing.push(path);
      continue;
    }
    // An empty array is a recorded answer. An absent one is not.
    if (Array.isArray(value)) continue;
    if (value === null || value === undefined) {
      if (!NULLABLE_BASIS_PATHS.has(path)) missing.push(path);
      continue;
    }
    if (typeof value === "string" && value.length === 0 && !NULLABLE_BASIS_PATHS.has(path)) missing.push(path);
  }
  if (!missing.length) return { state: "COMPLETE", missing: [], fingerprint: null };
  const sorted = [...new Set(missing)].sort();
  return { state: "INCOMPLETE", missing: sorted, fingerprint: fingerprintOf(sorted) };
}

/** The finding an incomplete basis raises. Result code carries the identity. */
export const BASIS_INCOMPLETE = "BASIS_INCOMPLETE";

export function incompleteBasisFinding(input: {
  service: string;
  futureCareItemId: string;
  missing: readonly string[];
  fingerprint: string;
}): { service: string; result: string; issue: string; severity: string; suggestion: string; exportBlocking: boolean } {
  const shown = input.missing.slice(0, 8).join(", ");
  const more = input.missing.length > 8 ? ` (+${input.missing.length - 8} more)` : "";
  return {
    service: input.service,
    // Item id AND the shape fingerprint: a different gap is a different
    // finding, so resolving one cannot silently close another.
    result: `${BASIS_INCOMPLETE}:${input.futureCareItemId}:${input.fingerprint}`,
    issue:
      `A recorded basis exists for this recommendation but cannot answer for it: ${input.missing.length} required field(s) are absent — ${shown}${more}. ` +
      `Nothing is read from the current record to cover the gap, because the current record is precisely what the approval did not cover; the affected values print as "not recorded".`,
    severity: "Critical",
    suggestion:
      "Regenerate the plan so a complete basis is recorded. This cannot be resolved as-is or ignored: the missing fields are what the report would otherwise assert.",
    exportBlocking: true,
  };
}

/** Recover the identity from a BASIS_INCOMPLETE result code. */
export function decodeIncompleteFinding(result: string | null | undefined): { futureCareItemId: string; fingerprint: string } | null {
  const m = /^BASIS_INCOMPLETE:([^:]+):([^:]+)$/.exec(String(result ?? ""));
  return m ? { futureCareItemId: m[1], fingerprint: m[2] } : null;
}

export const isIncompleteBasisFinding = (result: string | null | undefined): boolean =>
  String(result ?? "").startsWith(`${BASIS_INCOMPLETE}:`) || result === BASIS_INCOMPLETE;
