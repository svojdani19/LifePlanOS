// ─────────────────────────────────────────────────────────────────────────────
// What went wrong, what kind of thing can fix it, and how far a fix may travel.
//
// This program already learns in two narrow ways: correction exemplars feed
// fact-free guidance into extraction prompts, and learned priors nudge
// future-care drafts from a firm's own physician corrections. Both work, and
// neither has a vocabulary for "what was the failure?" — a correction is
// recorded as WRONG_FIELD or SUMMARY_REWORDED, which says what a reviewer
// touched, not what the program got wrong.
//
// Without that vocabulary nothing downstream is possible: you cannot measure a
// repeat-failure rate, you cannot tell a recoverable miss from an unrecoverable
// one, and you cannot decide which mechanism should learn from a given defect.
// A wrong laterality and a bland summary are both "the output was wrong" and
// have nothing else in common — one is a deterministic safety defect that
// belongs in a regression test, the other is a style preference that belongs in
// firm-scoped guidance.
//
// So each failure code declares three things that govern its whole lifecycle:
//
//   MECHANISM   — what is allowed to learn from it. A safety defect must never
//                 be "fixed" by retrieving a prose example; a style preference
//                 must never become a deterministic rule.
//   SEVERITY    — whether a regression here can ever be traded for a gain
//                 elsewhere. SAFETY_CRITICAL codes have zero tolerance.
//   SCOPE       — how far a lesson may travel: this case only, this document
//                 class within the firm, or the firm's clinical preferences.
//
// Nothing here reads a record or calls a model. It is a closed vocabulary and a
// state machine, so that the rest of the loop has something stable to agree on.
// ─────────────────────────────────────────────────────────────────────────────

export const FAILURE_CODES = [
  // Recall — the program did not see something the record documents.
  "MISSED_ENCOUNTER",
  "MISSED_SECTION",
  "MISSED_MATERIAL_FACT",
  "MISSED_NEGATIVE_FINDING",
  // Attribution — it saw the fact and attached it to the wrong thing.
  "WRONG_DATE",
  "WRONG_PROVIDER",
  "WRONG_FACILITY",
  "WRONG_ANATOMY",
  "WRONG_LATERALITY",
  // Meaning — it inverted or promoted what the record actually says.
  "NEGATION_REVERSED",
  "COPIED_FORWARD_AS_CURRENT",
  "PLANNED_AS_PERFORMED",
  "CONSENT_AS_TREATMENT",
  // Grounding — it said something the source does not support.
  "UNSUPPORTED_CLAIM",
  "UNSUPPORTED_PROSE",
  // Selection — the facts are right and the wrong ones were shown.
  "IRRELEVANT_SUMMARY",
  "IMPORTANT_FACT_OMITTED",
  // Identity — the same record counted twice, or two records counted once.
  "DUPLICATE_ENTRY",
  "FALSE_ENCOUNTER_MERGE",
  "MISSED_DUPLICATE",
  "UNCLEAR_SOURCE_BOUNDARY",
  "SOURCE_CONFLICT",
  // Care planning — a recommendation outran its evidence.
  "UNSUPPORTED_RECOMMENDATION",
  "UNSUPPORTED_FREQUENCY",
  "UNSUPPORTED_DURATION",
  "UNSUPPORTED_TREATMENT_FAILURE",
  "PRICING_OR_CODE_MISMATCH",
  // Anything a reviewer corrected that the vocabulary does not yet name.
  "OTHER_REVIEWER_CORRECTION",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * The lifecycle of one finding.
 *
 * A critic's allegation is not training truth. DETECTED means something was
 * alleged; VALIDATED means it was confirmed, either deterministically against
 * the source or by an authorized human correction. Only from VALIDATED can a
 * finding become a lesson, and only after evaluation can that lesson change
 * behavior.
 *
 * REJECTED_FALSE_POSITIVE is a first-class outcome, not a failure of the loop:
 * a critic that cries wolf must be measurable, and a rejected allegation must
 * be unable to influence any future prompt.
 */
export const FINDING_STATES = [
  "DETECTED",
  "VALIDATED",
  "REJECTED_FALSE_POSITIVE",
  "REPAIRED",
  "UNRESOLVED",
  "LEARNING_CANDIDATE",
  "EVALUATED",
  "ADOPTED",
  "REJECTED_NO_IMPROVEMENT",
  "RETIRED",
] as const;

export type FindingState = (typeof FINDING_STATES)[number];

/** Legal transitions. Anything not listed here is a programming error. */
const TRANSITIONS: Record<FindingState, readonly FindingState[]> = {
  DETECTED: ["VALIDATED", "REJECTED_FALSE_POSITIVE"],
  // A validated defect is repaired, or stays visible as unresolved. It may also
  // become a learning candidate — repair fixes this case, learning is what
  // stops the next one.
  VALIDATED: ["REPAIRED", "UNRESOLVED", "LEARNING_CANDIDATE"],
  REJECTED_FALSE_POSITIVE: [],
  REPAIRED: ["LEARNING_CANDIDATE"],
  UNRESOLVED: ["REPAIRED", "LEARNING_CANDIDATE"],
  LEARNING_CANDIDATE: ["EVALUATED"],
  EVALUATED: ["ADOPTED", "REJECTED_NO_IMPROVEMENT"],
  ADOPTED: ["RETIRED"],
  REJECTED_NO_IMPROVEMENT: [],
  RETIRED: [],
};

export function canTransition(from: FindingState, to: FindingState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function nextStates(from: FindingState): readonly FindingState[] {
  return TRANSITIONS[from] ?? [];
}

/** States from which a finding may still influence what the program learns. */
export function isLearnable(state: FindingState): boolean {
  return state === "VALIDATED" || state === "REPAIRED" || state === "LEARNING_CANDIDATE";
}

/**
 * What is permitted to learn from a failure.
 *
 * DETERMINISTIC_RULE — a code-level rule and a regression test. Retrieving a
 *   prose example cannot stop a laterality inversion or a false merge, and
 *   pretending otherwise is how a safety defect becomes a style suggestion.
 *   The program may PROPOSE such a rule; adopting one stays a reviewed
 *   software change, because code that rewrites itself after every mistake is
 *   not auditable.
 * TASK_GUIDANCE — fact-free structural guidance for a model task, scoped to a
 *   document class. "For therapy notes, capture each documented modality with
 *   its duration and parameters."
 * SALIENCE_PREFERENCE — which claim fields lead a summary, and what counts as
 *   low-value boilerplate. Structure only; never the corrected prose itself.
 * CLINICAL_PRIOR — a firm-scoped starting value for a care parameter, applied
 *   with provenance and always still reviewable.
 * NONE — nothing generalizes. The case is repaired and the finding is counted.
 */
export type LearningMechanism =
  | "DETERMINISTIC_RULE"
  | "TASK_GUIDANCE"
  | "SALIENCE_PREFERENCE"
  | "CLINICAL_PRIOR"
  | "NONE";

/**
 * Whether a regression in this dimension may ever be traded away.
 *
 * SAFETY_CRITICAL failures are the ones that put a wrong clinical assertion in
 * front of a physician under the program's own signature: an unsupported claim,
 * an inverted negation, planned care described as delivered, a wrong side of
 * the body, two encounters silently collapsed into one. A candidate that
 * regresses any of these is rejected however much it improves elsewhere.
 */
export type FailureSeverity = "SAFETY_CRITICAL" | "MATERIAL" | "QUALITY";

/** How far a lesson learned from this failure may travel. */
export type LearningScope = "CASE_ONLY" | "DOCUMENT_CLASS" | "FIRM_CLINICAL";

export interface FailureProfile {
  code: FailureCode;
  mechanism: LearningMechanism;
  severity: FailureSeverity;
  scope: LearningScope;
  /** Which pipeline stage the defect belongs to, for metrics and routing. */
  stage: "EXTRACTION" | "IDENTITY" | "SUMMARY" | "CHRONOLOGY" | "CARE_PLAN" | "PRICING";
  /**
   * Can a targeted retry of the affected page or encounter fix this case?
   * A missed section can be re-asked for; a reviewer's stylistic preference
   * cannot be recovered by asking the model again.
   */
  recoverable: boolean;
}

const P = (
  code: FailureCode,
  stage: FailureProfile["stage"],
  mechanism: LearningMechanism,
  severity: FailureSeverity,
  scope: LearningScope,
  recoverable: boolean,
): FailureProfile => ({ code, stage, mechanism, severity, scope, recoverable });

export const FAILURE_PROFILES: Record<FailureCode, FailureProfile> = {
  // Recall failures are recoverable by asking again, narrowly, and they
  // generalize as document-class guidance: "these notes document an exam under
  // a review-of-systems heading" is true of every note of that class.
  MISSED_ENCOUNTER: P("MISSED_ENCOUNTER", "IDENTITY", "DETERMINISTIC_RULE", "MATERIAL", "DOCUMENT_CLASS", true),
  MISSED_SECTION: P("MISSED_SECTION", "EXTRACTION", "TASK_GUIDANCE", "MATERIAL", "DOCUMENT_CLASS", true),
  MISSED_MATERIAL_FACT: P("MISSED_MATERIAL_FACT", "EXTRACTION", "TASK_GUIDANCE", "MATERIAL", "DOCUMENT_CLASS", true),
  MISSED_NEGATIVE_FINDING: P("MISSED_NEGATIVE_FINDING", "EXTRACTION", "TASK_GUIDANCE", "MATERIAL", "DOCUMENT_CLASS", true),

  // Attribution defects are deterministic: the date, the provider, the side of
  // the body either match the source or they do not.
  WRONG_DATE: P("WRONG_DATE", "EXTRACTION", "DETERMINISTIC_RULE", "MATERIAL", "DOCUMENT_CLASS", true),
  WRONG_PROVIDER: P("WRONG_PROVIDER", "EXTRACTION", "DETERMINISTIC_RULE", "MATERIAL", "DOCUMENT_CLASS", true),
  WRONG_FACILITY: P("WRONG_FACILITY", "EXTRACTION", "DETERMINISTIC_RULE", "QUALITY", "DOCUMENT_CLASS", true),
  WRONG_ANATOMY: P("WRONG_ANATOMY", "EXTRACTION", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "DOCUMENT_CLASS", true),
  WRONG_LATERALITY: P("WRONG_LATERALITY", "EXTRACTION", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "DOCUMENT_CLASS", true),

  // Meaning inversions are the defects that make a report actively dangerous.
  NEGATION_REVERSED: P("NEGATION_REVERSED", "EXTRACTION", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "DOCUMENT_CLASS", true),
  COPIED_FORWARD_AS_CURRENT: P("COPIED_FORWARD_AS_CURRENT", "EXTRACTION", "DETERMINISTIC_RULE", "MATERIAL", "DOCUMENT_CLASS", true),
  PLANNED_AS_PERFORMED: P("PLANNED_AS_PERFORMED", "EXTRACTION", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "DOCUMENT_CLASS", true),
  CONSENT_AS_TREATMENT: P("CONSENT_AS_TREATMENT", "EXTRACTION", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "DOCUMENT_CLASS", true),

  UNSUPPORTED_CLAIM: P("UNSUPPORTED_CLAIM", "EXTRACTION", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "CASE_ONLY", true),
  UNSUPPORTED_PROSE: P("UNSUPPORTED_PROSE", "SUMMARY", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "CASE_ONLY", true),

  // Selection defects are preferences, learned as structure and never as prose.
  IRRELEVANT_SUMMARY: P("IRRELEVANT_SUMMARY", "SUMMARY", "SALIENCE_PREFERENCE", "QUALITY", "DOCUMENT_CLASS", false),
  IMPORTANT_FACT_OMITTED: P("IMPORTANT_FACT_OMITTED", "SUMMARY", "SALIENCE_PREFERENCE", "MATERIAL", "DOCUMENT_CLASS", false),

  // Identity defects train the deterministic encounter-identity evaluation —
  // never the prose writer, which has no say in whether two records are one.
  DUPLICATE_ENTRY: P("DUPLICATE_ENTRY", "IDENTITY", "DETERMINISTIC_RULE", "MATERIAL", "DOCUMENT_CLASS", false),
  FALSE_ENCOUNTER_MERGE: P("FALSE_ENCOUNTER_MERGE", "IDENTITY", "DETERMINISTIC_RULE", "SAFETY_CRITICAL", "DOCUMENT_CLASS", false),
  MISSED_DUPLICATE: P("MISSED_DUPLICATE", "IDENTITY", "DETERMINISTIC_RULE", "QUALITY", "DOCUMENT_CLASS", false),
  UNCLEAR_SOURCE_BOUNDARY: P("UNCLEAR_SOURCE_BOUNDARY", "IDENTITY", "DETERMINISTIC_RULE", "MATERIAL", "DOCUMENT_CLASS", false),
  SOURCE_CONFLICT: P("SOURCE_CONFLICT", "CHRONOLOGY", "NONE", "MATERIAL", "CASE_ONLY", false),

  // Care-planning defects touch what a physician signs, so they learn only as
  // firm-scoped priors and only from repeated, consistent correction.
  UNSUPPORTED_RECOMMENDATION: P("UNSUPPORTED_RECOMMENDATION", "CARE_PLAN", "CLINICAL_PRIOR", "SAFETY_CRITICAL", "FIRM_CLINICAL", false),
  UNSUPPORTED_FREQUENCY: P("UNSUPPORTED_FREQUENCY", "CARE_PLAN", "CLINICAL_PRIOR", "MATERIAL", "FIRM_CLINICAL", false),
  UNSUPPORTED_DURATION: P("UNSUPPORTED_DURATION", "CARE_PLAN", "CLINICAL_PRIOR", "MATERIAL", "FIRM_CLINICAL", false),
  UNSUPPORTED_TREATMENT_FAILURE: P("UNSUPPORTED_TREATMENT_FAILURE", "CARE_PLAN", "CLINICAL_PRIOR", "MATERIAL", "FIRM_CLINICAL", false),
  PRICING_OR_CODE_MISMATCH: P("PRICING_OR_CODE_MISMATCH", "PRICING", "DETERMINISTIC_RULE", "MATERIAL", "FIRM_CLINICAL", false),

  OTHER_REVIEWER_CORRECTION: P("OTHER_REVIEWER_CORRECTION", "SUMMARY", "NONE", "QUALITY", "CASE_ONLY", false),
};

export function profileFor(code: FailureCode): FailureProfile {
  return FAILURE_PROFILES[code];
}

/** Codes whose regression can never be traded for a gain elsewhere. */
export const SAFETY_CRITICAL_CODES: readonly FailureCode[] = FAILURE_CODES.filter(
  (c) => FAILURE_PROFILES[c].severity === "SAFETY_CRITICAL",
);

/** Codes a targeted retry can plausibly fix in the case that produced them. */
export const RECOVERABLE_CODES: readonly FailureCode[] = FAILURE_CODES.filter((c) => FAILURE_PROFILES[c].recoverable);

export function isFailureCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * The correction categories already recorded by the encounter review route,
 * mapped into this vocabulary.
 *
 * The existing categories describe what a reviewer TOUCHED — a field changed,
 * a summary reworded — rather than what the program got wrong, so the mapping
 * is deliberately coarse and several land on OTHER_REVIEWER_CORRECTION. A
 * reviewer who selects a specific failure code supplies better information than
 * this mapping can infer, and their choice always wins.
 */
export function codeFromCorrectionCategory(category: string): FailureCode {
  switch (category) {
    case "DATE_CORRECTED":
      return "WRONG_DATE";
    case "PROVIDER_CORRECTED":
      return "WRONG_PROVIDER";
    case "EXCERPT_MISMATCH":
      return "UNSUPPORTED_CLAIM";
    case "BOILERPLATE_REMOVED":
      return "IRRELEVANT_SUMMARY";
    case "SUMMARY_REWORDED":
      return "OTHER_REVIEWER_CORRECTION";
    case "WRONG_FIELD":
    default:
      return "OTHER_REVIEWER_CORRECTION";
  }
}

/**
 * Who is allowed to confirm a failure of this kind.
 *
 * Deterministic confirmation is the source disagreeing with the output, which
 * needs no authority at all. Everything else needs a human with the standing to
 * say so — and a care-planning defect needs clinical standing specifically, so
 * that a learned prior can never originate from someone without it.
 */
export type ValidatorKind = "DETERMINISTIC" | "HUMAN_REVIEWER" | "HUMAN_CLINICAL";

export function requiredValidator(code: FailureCode): ValidatorKind {
  const profile = FAILURE_PROFILES[code];
  if (profile.mechanism === "CLINICAL_PRIOR") return "HUMAN_CLINICAL";
  if (profile.stage === "SUMMARY" && profile.mechanism === "SALIENCE_PREFERENCE") return "HUMAN_REVIEWER";
  return "DETERMINISTIC";
}
