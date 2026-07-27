// ─────────────────────────────────────────────────────────────────────────────
// Report feature flags. Defaults are the pilot posture (docs/23 Phase 1):
// the four established record-review/costing reports are on; vocational,
// economist, and the beta/internal analyses are off until a firm opts in.
// Per-firm overrides live in Firm.features (Json) and win over the default.
// Pure module — no env, no DB, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

export const REPORT_FLAGS = {
  "report.medical_chronology": true,
  "report.medical_summary": true,
  "report.provider_matrix": true,
  "report.medical_cost_projection": true,
  "report.vocational_assessment": false,
  "report.forensic_economist": false,
  "report.medical_necessity": false,
  "report.causation": false,
  "report.defense_rebuttal": false,
  "report.custom": false,
  "report.damages_summary": false,
  "report.report_level_attestation": false,
} as const;

export type ReportFlagKey = keyof typeof REPORT_FLAGS;

/**
 * Resolve a flag for a firm. `firmFeatures` is the raw Firm.features Json
 * (unknown/untrusted): a boolean under the flag key overrides the default;
 * anything malformed falls back to the default; an unknown key is never
 * enabled. Pure.
 */
export function flagEnabled(firmFeatures: unknown, key: ReportFlagKey): boolean {
  if (!(key in REPORT_FLAGS)) return false;
  const fallback = REPORT_FLAGS[key];
  if (typeof firmFeatures !== "object" || firmFeatures === null || Array.isArray(firmFeatures)) return fallback;
  const value = (firmFeatures as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Report-definition id → governing flag. `null` means the report is never
 * flag-gated (core deliverables). COST_PROJECTION is the legacy alias of
 * MEDICAL_COST_PROJECTION — both map to the same flag.
 */
export const REPORT_FLAG_BY_ID: Record<string, ReportFlagKey | null> = {
  LIFE_CARE_PLAN: null,
  TESTIMONY_PACK: null,
  PHYSICIAN_REVIEW_REPORT: null,
  MEDICAL_CHRONOLOGY: "report.medical_chronology",
  MEDICAL_RECORD_SUMMARY: "report.medical_summary",
  PROVIDER_MATRIX: "report.provider_matrix",
  COST_PROJECTION: "report.medical_cost_projection",
  MEDICAL_COST_PROJECTION: "report.medical_cost_projection",
  VOCATIONAL_ASSESSMENT: "report.vocational_assessment",
  FORENSIC_ECONOMIST_REPORT: "report.forensic_economist",
  MEDICAL_NECESSITY: "report.medical_necessity",
  CAUSATION_ANALYSIS: "report.causation",
  DEFENSE_REBUTTAL: "report.defense_rebuttal",
  DAMAGES_SUMMARY: "report.damages_summary",
  CUSTOM: "report.custom",
};

/**
 * Is a report id enabled for a firm? Ids mapped to `null` are never disabled;
 * ids absent from the map fall back to enabled (untracked reports are not
 * silently gated — gating is opt-in per id).
 */
export function reportEnabled(firmFeatures: unknown, reportId: string): boolean {
  const key = REPORT_FLAG_BY_ID[reportId];
  if (key === null || key === undefined) return true;
  return flagEnabled(firmFeatures, key);
}
