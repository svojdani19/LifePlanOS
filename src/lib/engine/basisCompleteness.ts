import { SERVICE_FAMILIES } from "@/lib/engine/serviceOntology";
import { SUPPORT_CLASSES } from "@/lib/engine/supportClass";
import {
  PROBABILITY_CLASSIFICATIONS,
  EVIDENCE_STRENGTHS,
  RECOMMENDATION_CONFIDENCES,
  DURATION_CLASSES as REASONING_DURATION_CLASSES,
} from "@/lib/engine/clinicalReasoning";
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

/**
 * The shape a persisted BasisRecord must have, declared once.
 *
 * The first version listed 33 dotted keys by hand. It omitted most of what the
 * report and assessmentFromBasis actually dereference — probabilityBasis
 * .statement, every nullable specification field, the whole projection input
 * set, three accepted-evidence buckets, and nearly all of assessmentBasis —
 * and it listed paths in NULLABLE_BASIS_PATHS that it never required at all,
 * so a basis missing them was reported COMPLETE and the report then read the
 * live row.
 *
 * Declared as a schema rather than a path list so the required set, the types
 * and the nullability live in one place beside the interface they describe,
 * and adding a BasisRecord field without describing it here is a visible
 * omission rather than a silent one.
 */
type Prim = "string" | "number" | "boolean";

interface FieldSpec {
  /** Primitive the value must be when non-null. */
  type: Prim | "array" | "object";
  /** May the recorded value be null? An ABSENT key is never acceptable. */
  nullable?: boolean;
  /**
   * Element schema for arrays.
   *
   * The first version validated only that a field WAS an array, on the
   * reasoning that its elements came from the same builder that produced the
   * record. That mistook where the data comes from: this validator's input is a
   * row read back from the database, which can be legacy, hand-edited, or
   * written by an older producer. `[null]` reached `f.present`, `x.text`,
   * `l.authors`, `g.title` and `.rationale` — five live crash paths — and a
   * malformed contradiction printed as [object Object].
   */
  element?: FieldSpec;
  /** For objects: the nested shape. */
  shape?: Record<string, FieldSpec>;
  /**
   * Allowed values for a material enum.
   *
   * A type check cannot see that "maybe" is not an inclusion status. An
   * arbitrary string here changes membership or makes a label lookup render
   * undefined, both silently.
   */
  values?: readonly string[];
}

const s_ = (nullable = false): FieldSpec => ({ type: "string", nullable });
const n_ = (nullable = false): FieldSpec => ({ type: "number", nullable });
const b_ = (nullable = false): FieldSpec => ({ type: "boolean", nullable });
const enum_ = (values: readonly string[], nullable = false): FieldSpec => ({ type: "string", nullable, values });
const arr_ = (element?: FieldSpec): FieldSpec => ({ type: "array", element });
const obj_ = (shape: Record<string, FieldSpec>, nullable = false): FieldSpec => ({ type: "object", nullable, shape });

/** An evidence row as the report renders it. */
const EVIDENCE_ROW = obj_({ text: s_(), source: s_(true) });
/** A literature citation as the report prints it. */
const LITERATURE_ROW = obj_({
  title: s_(), journal: s_(true), year: s_(true), authors: s_(true),
  pmid: s_(true), doi: s_(true), studyType: s_(), supports: s_(), limitations: s_(true),
});
/** Full provenance for one accepted row. */
const PROVENANCE_ROW = obj_({
  claim: s_(), stance: s_(), strength: s_(), sourceKind: s_(),
  documentId: s_(true), encounterId: s_(true), chronologyEventId: s_(true),
  page: n_(true), field: s_(true), verbatim: b_(), sourceFingerprint: s_(true), textHash: s_(),
});

// Domain values, imported from the modules that own them so the validator and
// the producers cannot drift apart.
const FAMILIES: readonly string[] = SERVICE_FAMILIES;
const SUPPORT_CLASS_VALUES: readonly string[] = SUPPORT_CLASSES;
const INCLUSION_VALUES = ["included", "excluded", "contingency"] as const;
const CLAIM_KINDS = ["RECORD", "GUIDELINE", "PROFESSIONAL", "ASSUMPTION"] as const;
const DURATION_CLASSES = ["one_time", "defined_course", "lifetime"] as const;
const PRICING_CATEGORIES = ["FEE_SCHEDULE", "SURVEY", "VENDOR", "CASE_RECORD", "UNKNOWN"] as const;
const PHYSICIAN_STATUSES = ["PENDING", "APPROVED", "MODIFIED", "REJECTED"] as const;
const PROBABILITY_STATEMENTS = ["more likely than not", "reasonable possibility", "speculative"] as const;

/** Every field the report, the assessment reader, or the hash depends on. */
export const BASIS_SCHEMA: Record<string, FieldSpec> = {
  // Identity and classification — hashed, and the ontology the presentation
  // category is derived from.
  futureCareItemId: s_(),
  interventionId: s_(),
  serviceFamily: enum_(FAMILIES),
  conditionId: s_(true),
  bodyRegion: s_(true),
  laterality: s_(true),
  supportClass: enum_(SUPPORT_CLASS_VALUES),
  supportReason: s_(true),
  spinalLevels: arr_(s_()),
  necessityNarrative: s_(),
  producerVersion: s_(),
  basisHash: s_(),

  specification: {
    type: "object",
    shape: {
      service: s_(),
      supportingDiagnosis: s_(true),
      responsibleSpecialty: s_(true),
      frequencyText: s_(),
      durationText: s_(),
      lifetimeQuantity: n_(),
      cptCode: s_(true),
      unitCost: n_(true),
      lifetimeCost: n_(true),
      presentValue: n_(true),
      physicianStatus: enum_(PHYSICIAN_STATUSES),
      recordSupported: b_(),
      contingencyOnly: b_(),
      startTrigger: s_(true),
      prerequisite: s_(true),
      earliestTiming: s_(true),
      replacesService: s_(true),
    },
  },

  projectionBasis: {
    type: "object",
    shape: {
      frequencyPerYear: n_(true),
      frequencyUnit: s_(),
      durationYears: n_(true),
      durationClass: enum_(DURATION_CLASSES),
      isLifetime: b_(),
      unitCost: n_(true),
      pricingSourceCategory: enum_(PRICING_CATEGORIES),
      pricingSourceId: s_(true),
      pricedAt: s_(true),
      horizonYears: n_(true),
      discountRate: n_(true),
      medicalInflation: n_(true),
      geographicFactor: n_(true),
    },
  },

  probabilityBasis: {
    type: "object",
    shape: {
      classification: enum_(PROBABILITY_STATEMENTS),
      statement: s_(),
      factors: arr_(obj_({ label: s_(), present: b_() })),
    },
  },

  claimBasis: {
    type: "object",
    shape: {
      frequency: obj_({ kind: enum_(CLAIM_KINDS), statement: s_() }),
      duration: obj_({ kind: enum_(CLAIM_KINDS), statement: s_() }),
      cost: obj_({ kind: enum_(CLAIM_KINDS), statement: s_() }),
    },
  },

  acceptedEvidence: {
    type: "object",
    shape: {
      diagnoses: arr_(EVIDENCE_ROW),
      objectiveFindings: arr_(EVIDENCE_ROW),
      functionalLimitations: arr_(EVIDENCE_ROW),
      priorTreatment: arr_(EVIDENCE_ROW),
      guidelines: arr_(EVIDENCE_ROW),
      contrary: arr_(s_()),
    },
  },

  assessmentBasis: {
    type: "object",
    shape: {
      probabilityClassification: enum_(PROBABILITY_CLASSIFICATIONS),
      inclusionRationale: s_(),
      inclusionInTotalsStatus: enum_(INCLUSION_VALUES),
      costEligibilityStatus: s_(),
      frequencyRationale: s_(),
      frequencySupported: b_(),
      durationClass: enum_(REASONING_DURATION_CLASSES),
      durationRationale: s_(),
      durationSupported: b_(),
      durationBasisLabel: s_(true),
      evidenceStrength: enum_(EVIDENCE_STRENGTHS),
      recommendationConfidence: enum_(RECOMMENDATION_CONFIDENCES),
      confidenceExplanation: s_(),
      residualUncertainty: s_(),
      medicalNecessityRationale: s_(),
      noTreatmentRisk: s_(),
      leastIntensiveRationale: s_(),
      timingRationale: s_(),
      clinicalPurpose: s_(),
      responsibleSpecialty: s_(),
      bodyRegion: s_(),
      laterality: s_(),
      conditionSeverity: s_(),
      conditionChronicity: s_(),
      currentClinicalStatus: s_(),
      conditionTrajectory: s_(),
      causalRelationshipStatus: s_(),
      clinicalPathway: s_(),
      clinicalPathwayStage: s_(true),
      objectiveEvidenceSummary: s_(true),
      subjectiveEvidenceSummary: s_(true),
      functionalBasisSummary: s_(true),
      priorTreatmentSummary: s_(true),
      treatmentResponseSummary: s_(true),
      treatingRecordSupportSummary: s_(true),
      literatureSynthesis: s_(),
      alternativesConsidered: arr_(obj_({ alternative: s_(), rationale: s_() })),
      supportingGuidelineAssessments: arr_(obj_({ title: s_(), claim: s_(), provenance: s_() })),
      missingEvidenceRequests: arr_(s_()),
      potentialChallenges: arr_(s_()),
      functionalBasis: obj_({ domain: s_(), limitation: s_(), source: s_(true), quantified: b_(), relationship: s_() }, true),
      confidenceLevel: s_(),
      confidenceLevelExplanation: s_(),
    },
  },

  evidenceProvenance: arr_(PROVENANCE_ROW),
  contradictions: arr_(s_()),
  literature: arr_(LITERATURE_ROW),
  missingPremises: arr_(s_()),
};

/** Flat dotted list, derived from the schema so the two cannot disagree. */
export const REQUIRED_BASIS_PATHS: readonly string[] = (() => {
  const out: string[] = [];
  const walk = (shape: Record<string, FieldSpec>, prefix: string) => {
    for (const [k, spec] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      if (spec.type === "object" && spec.shape) walk(spec.shape, path);
    }
  };
  walk(BASIS_SCHEMA, "");
  return out;
})();

/** Paths whose recorded value may be null. Derived from the same schema. */
export const NULLABLE_BASIS_PATHS: ReadonlySet<string> = new Set(
  REQUIRED_BASIS_PATHS.filter((path) => {
    let spec: FieldSpec | undefined;
    let shape: Record<string, FieldSpec> | undefined = BASIS_SCHEMA;
    for (const part of path.split(".")) {
      spec = shape?.[part];
      shape = spec?.shape;
    }
    return !!spec?.nullable;
  }),
);

export type BasisState = "ABSENT" | "COMPLETE" | "INCOMPLETE";

export interface CompletenessResult {
  state: BasisState;
  /**
   * Sorted dotted paths that are absent, or `path<type>` where a recorded
   * value is present but of the wrong type. Empty when COMPLETE or ABSENT.
   */
  missing: string[];
  /**
   * Stable fingerprint of the missing SHAPE. Two bases missing the same paths
   * produce the same fingerprint; a different gap is a different finding, so a
   * reviewer cannot resolve one shape of defect and silently close another.
   */
  fingerprint: string | null;
}

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
  // ABSENT means NO ROW. A malformed value is a defect in a basis that exists,
  // not the absence of one — calling it absent would licence the live-row
  // fallback, which is the opposite of what a malformed record should do.
  if (basis === null || basis === undefined) return { state: "ABSENT", missing: [], fingerprint: null };
  if (typeof basis !== "object") return { state: "INCOMPLETE", missing: ["<root>"], fingerprint: fingerprintOf(["<root>"]) };

  const missing: string[] = [];

  const checkPrimitive = (path: string, spec: FieldSpec, value: unknown) => {
    if (value === null) {
      if (!spec.nullable) missing.push(path);
      return;
    }
    if (spec.type === "string") {
      if (typeof value !== "string") { missing.push(`${path}<type>`); return; }
      if (value === "") { missing.push(path); return; }
      // A type check cannot see that "maybe" is not an inclusion status.
      if (spec.values && !spec.values.includes(value)) missing.push(`${path}<value>`);
      return;
    }
    if (spec.type === "number") {
      // NaN and Infinity are typeof "number" and would flow straight into a
      // total or a projection.
      if (typeof value !== "number" || !Number.isFinite(value)) missing.push(`${path}<type>`);
      return;
    }
    if (spec.type === "boolean" && typeof value !== "boolean") missing.push(`${path}<type>`);
  };

  /** One value against one spec, at one path. Recurses into arrays/objects. */
  const checkValue = (path: string, spec: FieldSpec, value: unknown) => {
    if (spec.type === "array") {
      if (value === null) { if (!spec.nullable) missing.push(path); return; }
      if (!Array.isArray(value)) { missing.push(`${path}<type>`); return; }
      // An empty recorded array is an ANSWER; each present element is checked
      // with its index, so a defect names the row it is in.
      if (spec.element) value.forEach((el, i) => checkValue(`${path}[${i}]`, spec.element!, el));
      return;
    }
    if (spec.type === "object") {
      if (value === null) { if (!spec.nullable) missing.push(path); return; }
      if (typeof value !== "object" || Array.isArray(value)) { missing.push(`${path}<type>`); return; }
      if (spec.shape && Object.keys(spec.shape).length) walk(spec.shape, value, path);
      return;
    }
    checkPrimitive(path, spec, value);
  };

  function walk(shape: Record<string, FieldSpec>, node: unknown, prefix: string) {
    for (const [key, spec] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const container = node as Record<string, unknown> | null;
      if (container === null || typeof container !== "object" || !(key in container)) {
        missing.push(path);
        continue;
      }
      checkValue(path, spec, container[key]);
    }
  }

  walk(BASIS_SCHEMA, basis, "");

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
