// ─────────────────────────────────────────────────────────────────────────────
// Document types the clinical chronology excludes.
//
// A DATA table, deliberately in a module of its own with no imports at all.
//
// It used to live in `engine/chronology.ts`, which imports `node:crypto` and
// the Prisma client. Anything reading the list — including a client component
// that only wants to say "this record was excluded by its type" — pulled the
// whole server engine into the browser bundle with it, and the build failed on
// `Reading from "node:crypto" is not handled by plugins`.
//
// `chronology.ts` re-exports it, so every existing import keeps working.
// ─────────────────────────────────────────────────────────────────────────────

export const EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  "BILLING_RECORD",
  "INSURANCE_RECORDS",
  "TAX_RECORDS",
  "EMPLOYMENT_RECORDS",
  "WAGE_LOSS_DOCUMENTATION",
  "CORRESPONDENCE",
  "COST_PROJECTION",
  "DEPOSITION",
  "LEGAL_PLEADING",
  "DEMAND_LETTER",
  "SETTLEMENT_AGREEMENT",
  "COURT_ORDER",
  "PHOTOGRAPHS",
  "SURVEILLANCE_VIDEO",
  "EXPERT_REPORT",
  "PEER_REVIEW",
  // A finalized life care plan is the answer key. Chronicling it would put the
  // planner's own recommendations into the patient's timeline as though they
  // were care delivered. It was absent from this list while EXPERT_REPORT was
  // present — the same document class, one of them guarded.
  "LIFE_CARE_PLAN",
]);
