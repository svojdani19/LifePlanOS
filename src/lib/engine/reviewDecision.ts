// ─────────────────────────────────────────────────────────────────────────────
// One place that decides what a review decision MEANS.
//
// `supportClass` was introduced as the single answer to "does this item enter
// the totals", and then the review routes were left setting `physicianStatus`
// alone. So a physician could approve an item and watch it stay classified
// CANDIDATE_REVIEW, excluded from the headline — while report logic keyed on
// approval status counted it. Two screens, two answers, from one decision.
//
// That is the same failure as the origin split fixed earlier this week — one
// concept with two definitions — reintroduced in the lifecycle. The repair is
// the same shape: one function, and no caller allowed to write half of it.
//
// It is also what makes the migration safe. The `supportClass` column defaults
// to CANDIDATE_REVIEW, which fails closed for a NEW row and is wrong for an
// EXISTING one: an approved plan would silently collapse to nothing supported.
// `classifyExistingItem` is the deterministic backfill, and it is the same
// function the routes call, so a backfilled row and a freshly-reviewed row
// cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

import { classifySupport, type SupportClass, type SupportVerdict } from "@/lib/engine/supportClass";
import { originClass } from "@/lib/reference/origins";

export interface ReviewableItem {
  origin?: string | null;
  physicianStatus?: string | null;
  supportClass?: string | null;
  /** Set when the generator found a treating-provider recommendation. */
  supportReason?: string | null;
  contingencyOnly?: boolean | null;
}

/**
 * The support classification implied by a review decision.
 *
 * A professional's decision outranks what the record says, in both directions:
 * they have read both and it is their opinion the plan is offered under. What
 * it must NOT do is masquerade as treating-record evidence, which is why
 * approval yields PROFESSIONALLY_ADOPTED rather than RECORD_RECOMMENDED.
 */
export function supportClassForDecision(item: ReviewableItem, status: string): SupportVerdict {
  const cls = originClass(item.origin);
  return classifySupport({
    providerRecommendation: cls === "TREATING_RECORD",
    professionalAdoption: status === "APPROVED" || status === "MODIFIED",
    professionalRejection: status === "REJECTED",
    indicationChainComplete: false,
    contradicted: false,
    conditional: !!item.contingencyOnly,
    // A reviewer acted on it, so it is by definition worth reviewing.
    clinicallyRelevant: true,
  });
}

/**
 * The classification an EXISTING row should carry, from what is already known
 * about it. Used by the backfill and by any read that finds a legacy row.
 *
 * Deterministic and conservative: it never invents patient-specific support.
 * An unreviewed template stays a candidate, exactly as a fresh generation
 * would classify it.
 */
export function classifyExistingItem(item: ReviewableItem): SupportVerdict {
  const status = item.physicianStatus ?? "PENDING";
  if (status === "APPROVED" || status === "MODIFIED" || status === "REJECTED") {
    return supportClassForDecision(item, status);
  }
  const cls = originClass(item.origin);
  return classifySupport({
    providerRecommendation: cls === "TREATING_RECORD",
    professionalAdoption: false,
    professionalRejection: false,
    indicationChainComplete: false,
    contradicted: false,
    conditional: !!item.contingencyOnly,
    // Reference content is not production care and must not be totalled; it
    // should not be in an active plan at all.
    clinicallyRelevant: cls !== "REFERENCE",
  });
}

/** Would reclassifying this row change anything? Keeps backfills idempotent. */
export const needsReclassification = (item: ReviewableItem): boolean =>
  (item.supportClass ?? null) !== classifyExistingItem(item).supportClass;

/**
 * Every field a review decision writes, as one object.
 *
 * Returned rather than written so the caller can put it inside its own
 * transaction alongside the audit row — but no caller has to remember that
 * `supportClass` exists, which is how it came to be forgotten twice.
 */
export function reviewDecisionFields(item: ReviewableItem, status: string, lifecycleStatus: string): {
  physicianStatus: string;
  lifecycleStatus: string;
  supportClass: SupportClass;
  supportReason: string;
} {
  const v = supportClassForDecision(item, status);
  return { physicianStatus: status, lifecycleStatus, supportClass: v.supportClass, supportReason: v.reason };
}
