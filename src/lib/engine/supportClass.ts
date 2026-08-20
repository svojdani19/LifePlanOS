// ─────────────────────────────────────────────────────────────────────────────
// What stands behind this recommendation — and may it enter the totals?
//
// These were one boolean, `hasPatientRecordSupport`, and it answered neither
// question honestly:
//
//   • it returned TRUE when the matched CONDITION carried records, so a lumbar
//     diagnosis supported lumbar visits, therapy, imaging, injections and
//     braces alike — 46 of 55 items and $518,879 of present value on the
//     reference case rested on nothing more than that;
//   • failing that it fell back to `confidence >= 60`, and the care library
//     assigns confidence 75 by default, before any case evidence exists. A
//     region-matched condition with ZERO records plus that literal yields
//     RECORD_SUPPORTED_PENDING and enters the totals. Demonstrated, not
//     theorised.
//
// The replacement separates two things that were fused: whether an item is
// clinically WORTH REVIEWING, and whether it is SUPPORTED. High candidate
// recall and strict evidentiary support are different objectives, and the old
// gate improved the second by deleting candidates — 28 of 40 library templates
// for the reference case never reached the plan at all, including every
// injection, every diagnostic imaging study and every surgical projection.
//
// So: admit broadly, classify strictly, and total only what is supported.
// ─────────────────────────────────────────────────────────────────────────────

export type SupportClass =
  /** A treating provider recommended THIS service in the records. */
  | "RECORD_RECOMMENDED"
  /** A complete patient-specific indication chain: indication, evidence, prerequisites. */
  | "PATIENT_SPECIFIC"
  /** A qualified professional adopted it here, with an attributable rationale. */
  | "PROFESSIONALLY_ADOPTED"
  /** Clinically relevant to this patient; awaiting evidence or review. */
  | "CANDIDATE_REVIEW"
  /** A future pathway contingent on a stated trigger. */
  | "CONDITIONAL"
  /** Contradicted by the record, or excluded on review. */
  | "UNSUPPORTED";

export const SUPPORT_CLASSES: readonly SupportClass[] = [
  "RECORD_RECOMMENDED", "PATIENT_SPECIFIC", "PROFESSIONALLY_ADOPTED", "CANDIDATE_REVIEW", "CONDITIONAL", "UNSUPPORTED",
];

/**
 * The classes that enter the SUPPORTED plan total.
 *
 * Deliberately a set rather than a predicate over fields: every attempt to
 * compute this from confidence, probability, origin or region has produced a
 * way for a default value to buy its way in.
 */
export const TOTALLED_CLASSES: ReadonlySet<SupportClass> = new Set<SupportClass>([
  "RECORD_RECOMMENDED", "PATIENT_SPECIFIC", "PROFESSIONALLY_ADOPTED",
]);

/** The classes disclosed in the candidate/contingency scenario total. */
export const CANDIDATE_CLASSES: ReadonlySet<SupportClass> = new Set<SupportClass>(["CANDIDATE_REVIEW", "CONDITIONAL"]);

export const entersSupportedTotal = (c: SupportClass): boolean => TOTALLED_CLASSES.has(c);
export const entersCandidateScenario = (c: SupportClass): boolean => CANDIDATE_CLASSES.has(c);

/** How each class is described on screen and in the report. */
export const SUPPORT_LABEL: Record<SupportClass, string> = {
  RECORD_RECOMMENDED: "Recommended in the treating record",
  PATIENT_SPECIFIC: "Patient-specific indication documented",
  PROFESSIONALLY_ADOPTED: "Adopted on professional review",
  CANDIDATE_REVIEW: "Candidate — awaiting patient-specific support",
  CONDITIONAL: "Conditional on a future clinical trigger",
  UNSUPPORTED: "Not supported by the current record",
};

export interface SupportInputs {
  /** A treating provider recommended this exact service, with a citation. */
  providerRecommendation: boolean;
  /** A reviewer adopted or modified it. */
  professionalAdoption: boolean;
  /** Reviewer explicitly declined it. */
  professionalRejection: boolean;
  /** Every prerequisite for this intervention is satisfied by accepted evidence. */
  indicationChainComplete: boolean;
  /** Accepted evidence argues against it. */
  contradicted: boolean;
  /** Disclosed as a contingency / staged pathway rather than active care. */
  conditional: boolean;
  /** Clinically related to a documented condition, anatomy or deficit. */
  clinicallyRelevant: boolean;
}

export interface SupportVerdict {
  supportClass: SupportClass;
  /** Deterministic, from a fixed phrase table — never composed from free text. */
  reason: string;
}

const REASON: Record<SupportClass, string> = {
  RECORD_RECOMMENDED: "A treating provider recommended this service in the records.",
  PATIENT_SPECIFIC: "The record documents an indication for this service and every prerequisite is satisfied.",
  PROFESSIONALLY_ADOPTED: "Adopted by a qualified professional, whose rationale is recorded and attributed.",
  CANDIDATE_REVIEW: "Clinically relevant to a documented condition, but no patient-specific indication is yet established. Disclosed for review; not in the supported total.",
  CONDITIONAL: "Contingent on a stated future clinical trigger. Disclosed as a contingency; not in the supported total.",
  UNSUPPORTED: "The record contains evidence against this service, or it was declined on review.",
};

/**
 * Classify one recommendation.
 *
 * NOTE what is absent from `SupportInputs`: confidence, probability, origin,
 * body region, and whether the matched condition has records. None of them can
 * reach this function, so none of them can produce support. That is the point —
 * every one of them has done so before.
 */
export function classifySupport(inputs: SupportInputs): SupportVerdict {
  const done = (supportClass: SupportClass): SupportVerdict => ({ supportClass, reason: REASON[supportClass] });

  // A reviewer's decision outranks everything the record says: they have seen
  // both, and it is their opinion the plan is offered under.
  if (inputs.professionalRejection) return done("UNSUPPORTED");
  if (inputs.professionalAdoption) return done("PROFESSIONALLY_ADOPTED");
  // Contradiction is not the same as absence, and it outranks a template's
  // relevance.
  if (inputs.contradicted) return done("UNSUPPORTED");
  if (inputs.conditional) return done("CONDITIONAL");
  if (inputs.providerRecommendation) return done("RECORD_RECOMMENDED");
  if (inputs.indicationChainComplete) return done("PATIENT_SPECIFIC");
  if (inputs.clinicallyRelevant) return done("CANDIDATE_REVIEW");
  return done("UNSUPPORTED");
}

export interface PlanTotals {
  /** What the record and professional judgement support. The headline. */
  supported: { items: number; presentValue: number; lifetimeCost: number };
  /** Everything disclosed for review, including the supported items. */
  scenario: { items: number; presentValue: number; lifetimeCost: number };
}

/**
 * Two totals, computed once, from the classification alone.
 *
 * The scenario total INCLUDES the supported items, because a planner reading it
 * wants "everything on the table", not a disjoint bucket they have to add up
 * themselves.
 */
export function computePlanTotals(
  items: readonly { supportClass?: string | null; presentValue?: number | null; lifetimeCost?: number | null }[],
): PlanTotals {
  const zero = { items: 0, presentValue: 0, lifetimeCost: 0 };
  const supported = { ...zero };
  const scenario = { ...zero };
  for (const i of items) {
    const c = (i.supportClass ?? "CANDIDATE_REVIEW") as SupportClass;
    const pv = i.presentValue ?? 0;
    const lc = i.lifetimeCost ?? 0;
    if (entersSupportedTotal(c)) {
      supported.items++; supported.presentValue += pv; supported.lifetimeCost += lc;
    }
    if (entersSupportedTotal(c) || entersCandidateScenario(c)) {
      scenario.items++; scenario.presentValue += pv; scenario.lifetimeCost += lc;
    }
  }
  return { supported, scenario };
}


/**
 * Is this item supported, read from its persisted classification?
 *
 * The replacement for `hasPatientRecordSupport(rec, matchedCondition)`. Note
 * that it takes NO condition: the matched diagnosis carrying records is not a
 * fact about this service, and treating it as one admitted 46 of 55 items and
 * $518,879 of present value on the reference case.
 */
export const itemIsSupported = (item: { supportClass?: string | null }): boolean =>
  entersSupportedTotal((item.supportClass ?? "CANDIDATE_REVIEW") as SupportClass);

/** The class an item carries, defaulting closed. */
export const supportClassOf = (item: { supportClass?: string | null }): SupportClass =>
  (SUPPORT_CLASSES as readonly string[]).includes(String(item.supportClass))
    ? (item.supportClass as SupportClass)
    : "CANDIDATE_REVIEW";
