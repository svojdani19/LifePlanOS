// ─────────────────────────────────────────────────────────────────────────────
// What put this recommendation in the plan — one definition, one meaning.
//
// The codebase carried three vocabularies for the same question.
// `lifecycle.ts` and `reports/sections.ts` each declared their own
// AUTHORED_ORIGINS literal including GOLD_IMPORT; `isRecordGrounded` in
// medicalNecessity.ts used a different set that omitted it and added
// RECORD_RECOMMENDED; `reports/data.ts` had a third label map. On the reference
// case the disagreement mislabeled 37 of 59 items.
//
// The distinctions that actually matter, and that a deposition will probe:
//
//   Did a TREATING PROVIDER recommend this care?      → RECORD_RECOMMENDED
//   Did a QUALIFIED PROFESSIONAL adopt it here?       → PHYSICIAN/PLANNER_ADDED
//   Is it CARE-LIBRARY scaffolding awaiting support?  → TEMPLATE_*
//   Is it REFERENCE material — an answer key?         → GOLD_IMPORT
//
// Those are four different claims and they were being collapsed into "authored"
// and "not authored".
// ─────────────────────────────────────────────────────────────────────────────

export type OriginClass =
  /** A treating provider recommended this service in the records. */
  | "TREATING_RECORD"
  /** A qualified professional put it here and stands behind it. */
  | "PROFESSIONAL"
  /** Care-library scaffolding, keyed to a diagnosis or to baseline care. */
  | "TEMPLATE"
  /** A finalized plan's own line item — reference material, never runtime. */
  | "REFERENCE";

export const ORIGIN_CLASS: Record<string, OriginClass> = {
  RECORD_RECOMMENDED: "TREATING_RECORD",
  PHYSICIAN_ADDED: "PROFESSIONAL",
  PLANNER_ADDED: "PROFESSIONAL",
  TEMPLATE_CONDITION: "TEMPLATE",
  TEMPLATE_BASELINE: "TEMPLATE",
  GOLD_IMPORT: "REFERENCE",
};

/** An unrecorded origin is treated as template scaffolding — the weaker claim. */
export const originClass = (origin: string | null | undefined): OriginClass => ORIGIN_CLASS[String(origin ?? "")] ?? "TEMPLATE";

/**
 * Origins a regeneration must not replace, because a person authored them.
 *
 * GOLD_IMPORT is deliberately ABSENT. It was here, and that is what kept a
 * published plan's items alive inside the runtime plan across every
 * regeneration. Reference content is preserved in `ReferencePlanItem`, not by
 * hiding inside the production table.
 */
export const AUTHORED_ORIGINS: ReadonlySet<string> = new Set(
  Object.entries(ORIGIN_CLASS).filter(([, c]) => c === "PROFESSIONAL").map(([o]) => o),
);

/**
 * Does something in this case's own record or a professional's own judgement
 * stand behind this item — as opposed to a care template awaiting support?
 *
 * Replaces `isRecordGrounded`'s ad-hoc allowlist. Note what it does NOT do:
 * it never returns true for REFERENCE content, because an imported plan is
 * evidence about a planner's opinion, not about this patient.
 */
export function isGrounded(item: { origin?: string | null; physicianStatus?: string | null }): boolean {
  const cls = originClass(item.origin);
  if (cls === "REFERENCE") return false;
  if (cls === "TREATING_RECORD" || cls === "PROFESSIONAL") return true;
  // A professional who approved a template item has adopted it as their own.
  return item.physicianStatus === "APPROVED" || item.physicianStatus === "MODIFIED";
}

/** How a reader is told where an item came from. */
export const ORIGIN_LABEL: Record<OriginClass, string> = {
  TREATING_RECORD: "Recommended in the treating record",
  PROFESSIONAL: "Added by a qualified professional",
  TEMPLATE: "Care-plan template awaiting patient-specific support",
  REFERENCE: "Reference plan item (not part of this plan)",
};
