// ─────────────────────────────────────────────────────────────────────────────
// One reading of "is this item supported?", shared by every surface.
//
// The authoritative totals are computed by `computePlanTotals`, which reads
// `supportClass` and nothing else. The Future Care and Costs panels each
// carried their OWN rule, and neither agreed with it:
//
//   • Future Care showed no support class at all. Its headline badge was
//     `probability`, its category subtotal summed EVERY item in the group, and
//     a reviewer comparing a category subtotal against the case total found
//     figures that could not be reconciled — the subtotal included candidates
//     the total excluded.
//
//   • Costs decided membership with `it.contingencyOnly || physicianStatus ===
//     "REJECTED"`, and captioned the table "included rows enter totals;
//     contingent/excluded rows are disclosed only". A CANDIDATE_REVIEW item is
//     neither contingent nor rejected, so it rendered as included, at full
//     opacity, under a caption promising it was in the total. It was not.
//     Its detail row then said "Probability: possible" with no note, while
//     "speculative" claimed "disclosed, not totaled" — a third rule, also not
//     the one being applied.
//
// Three rules for one question, none of them the real one. This module is the
// real one, expressed once, as pure functions over the persisted class.
//
// Nothing here re-derives support. It reads `supportClass` — the field the
// server already classified and totalled from — and only decides how to say it.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type SupportClass,
  SUPPORT_LABEL,
  supportClassOf,
  entersSupportedTotal,
  entersCandidateScenario,
} from "@/lib/engine/supportClass";

/** Where an item stands relative to the authoritative totals. */
export type TotalsMembership =
  /** Counted in the headline supported total. */
  | "SUPPORTED"
  /** Disclosed in the candidate/contingency scenario, not the headline. */
  | "CANDIDATE"
  /** In neither total. Contradicted, or declined on review. */
  | "EXCLUDED";

export function totalsMembership(item: { supportClass?: string | null }): TotalsMembership {
  const c = supportClassOf(item);
  if (entersSupportedTotal(c)) return "SUPPORTED";
  if (entersCandidateScenario(c)) return "CANDIDATE";
  return "EXCLUDED";
}

/**
 * Badge tones, keyed by the canonical class.
 *
 * Deliberately three visual weights for three meanings, not six for six: a
 * reader needs to see "in the total / disclosed only / out" at a glance, and
 * the precise class is carried by the label beside it.
 */
export const SUPPORT_TONE: Record<SupportClass, "success" | "info" | "warning" | "neutral" | "danger"> = {
  RECORD_RECOMMENDED: "success",
  PATIENT_SPECIFIC: "success",
  PROFESSIONALLY_ADOPTED: "success",
  CANDIDATE_REVIEW: "warning",
  CONDITIONAL: "info",
  UNSUPPORTED: "danger",
};

/** A short form for the collapsed card, where the full label will not fit. */
export const SUPPORT_SHORT: Record<SupportClass, string> = {
  RECORD_RECOMMENDED: "record-recommended",
  PATIENT_SPECIFIC: "patient-specific",
  PROFESSIONALLY_ADOPTED: "professionally adopted",
  CANDIDATE_REVIEW: "candidate",
  CONDITIONAL: "conditional",
  UNSUPPORTED: "not supported",
};

/**
 * The one sentence that says whether an item is in the total.
 *
 * Fixed phrases from a table — never composed, never interpolated from model
 * output, so what a reader sees about a signed plan is stable and hashable.
 */
export const MEMBERSHIP_SENTENCE: Record<TotalsMembership, string> = {
  SUPPORTED: "Included in the supported total.",
  CANDIDATE: "Disclosed for review; not included in the supported total.",
  EXCLUDED: "Not included in any total.",
};

export interface SupportBadge {
  supportClass: SupportClass;
  membership: TotalsMembership;
  /** Full canonical label — the expanded card and the report. */
  label: string;
  /** Compact label — the collapsed card. */
  short: string;
  tone: "success" | "info" | "warning" | "neutral" | "danger";
  /** Hover text: the canonical label plus the totals consequence. */
  title: string;
}

/** Everything a surface needs to render one item's support state. */
export function supportBadgeFor(item: { supportClass?: string | null }): SupportBadge {
  const supportClass = supportClassOf(item);
  const membership = totalsMembership(item);
  return {
    supportClass,
    membership,
    label: SUPPORT_LABEL[supportClass],
    short: SUPPORT_SHORT[supportClass],
    tone: SUPPORT_TONE[supportClass],
    title: `${SUPPORT_LABEL[supportClass]} — ${MEMBERSHIP_SENTENCE[membership]}`,
  };
}

/** Is this row shown de-emphasised? Exactly the rows outside the headline total. */
export const isDeEmphasised = (item: { supportClass?: string | null }): boolean =>
  totalsMembership(item) !== "SUPPORTED";

export interface MoneyBucket {
  items: number;
  presentValue: number;
  lifetimeCost: number;
}

export interface CategorySubtotal {
  /** Enters the headline total. */
  supported: MoneyBucket;
  /** Disclosed only — candidates and contingencies. */
  candidate: MoneyBucket;
  /** In neither total. */
  excluded: MoneyBucket;
}

const emptyBucket = (): MoneyBucket => ({ items: 0, presentValue: 0, lifetimeCost: 0 });

/**
 * Split one category's items into the three buckets the totals actually use.
 *
 * Replaces `items.reduce((s, it) => s + it.presentValue, 0)`, which summed
 * every item in the group under a heading the case total contradicted. A
 * planner reconciling a category against the headline had no way to see where
 * the difference came from.
 */
export function categorySubtotal(
  items: readonly { supportClass?: string | null; presentValue?: number | null; lifetimeCost?: number | null }[],
): CategorySubtotal {
  const out: CategorySubtotal = { supported: emptyBucket(), candidate: emptyBucket(), excluded: emptyBucket() };
  for (const item of items) {
    const bucket =
      totalsMembership(item) === "SUPPORTED" ? out.supported
        : totalsMembership(item) === "CANDIDATE" ? out.candidate
        : out.excluded;
    bucket.items += 1;
    bucket.presentValue += item.presentValue ?? 0;
    bucket.lifetimeCost += item.lifetimeCost ?? 0;
  }
  return out;
}

/**
 * The caption above a list of items, describing the rule actually in force.
 *
 * Returns null when every item is supported — there is no distinction to draw,
 * and a caption explaining an exclusion that does not exist is noise.
 */
export function membershipCaption(subtotal: CategorySubtotal): string | null {
  const parts: string[] = [];
  if (subtotal.candidate.items > 0) {
    parts.push(`${subtotal.candidate.items} disclosed for review`);
  }
  if (subtotal.excluded.items > 0) {
    parts.push(`${subtotal.excluded.items} in no total`);
  }
  if (!parts.length) return null;
  return `${subtotal.supported.items} in the supported total · ${parts.join(" · ")}`;
}

/**
 * Why THIS item is or is not in the total, for the detail view.
 *
 * Physician disposition and contingency are reported separately by the caller
 * where they are relevant — they are facts about the item, but they are not
 * the totaling rule, and presenting them as the rule is the defect this
 * module exists to remove.
 */
export function membershipExplanation(item: { supportClass?: string | null }): string {
  const badge = supportBadgeFor(item);
  return `${badge.label}. ${MEMBERSHIP_SENTENCE[badge.membership]}`;
}
