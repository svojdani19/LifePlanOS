import { roundCurrency, hashEconInputs, type EconInputs } from "@/lib/engine/economics";
import type { Block, ReportDoc } from "./doc";

// ─────────────────────────────────────────────────────────────────────────────
// P5 Forensic Economist workflow — pure composition + mapping layer.
//
// Everything in this module is pure: no Prisma, no I/O, no Date.now beyond
// formatting values handed in. The deterministic math lives EXCLUSIVELY in
// src/lib/engine/economics.ts; this module maps explicitly-entered
// EconomicAssumption rows into EconInputs, derives readiness, and composes a
// ReportDoc from STORED scenario results. Compose never re-runs any math —
// every number rendered comes verbatim from a stored result (rounded only at
// the presentation boundary via roundCurrency).
//
// CORE PRINCIPLE (docs/23 P5): no assumption is ever silently chosen. A
// missing or unparsable required input yields a `missing` entry — never a
// default. Optional inputs that are absent mean the component is EXCLUDED,
// and an optional input that was entered but is unparsable also blocks the
// computation (an explicitly-entered value must never be silently dropped).
// ─────────────────────────────────────────────────────────────────────────────

// Copied from TYPE_DISCLOSURE.FORENSIC_ECONOMIST_REPORT in
// src/lib/reports/registry.ts — MUST match that string verbatim. Kept as a
// local const because registry.ts is owned by another workstream and this
// module must stay import-free of it.
export const ECONOMIST_DISCLOSURE =
  "Source financial data, vocational assumptions, medical-cost inputs, economist-supplied assumptions, calculations, and expert conclusions are separately identified. Every economic assumption is explicitly entered, sourced, and versioned. Final conclusions require economist approval and attestation.";

export const NO_CONCLUSION_SENTENCE =
  "Economist conclusions have not been entered. This is a support package, not an expert opinion.";

export const DETERMINISTIC_LABEL = "Deterministic calculation from the stated assumptions";

export const MEDICAL_OMISSION_NOTE =
  "No finalized Life Care Plan or Medical Cost Projection export exists for this case; the medical-cost component is omitted from all totals. It is omitted, not estimated.";

// ── Known assumption keys (drives the mapper AND the workspace dropdown) ─────

export type AssumptionKind = "currency" | "rate" | "years" | "hours" | "hourlyRate";

export interface AssumptionKeyDef {
  key: string;
  /** Human label for the UI. */
  label: string;
  /** Suggested unit shown in the workspace (the row's stored unit governs parsing). */
  unitHint: string;
  kind: AssumptionKind;
  required: boolean;
  /** EconInputs field this key populates. */
  field: keyof EconInputs;
}

export const ASSUMPTION_KEYS: AssumptionKeyDef[] = [
  { key: "baseline_earnings", label: "Baseline annual earnings", unitHint: "USD/year", kind: "currency", required: true, field: "baselineAnnualEarnings" },
  { key: "earnings_growth", label: "Earnings growth rate", unitHint: "percent", kind: "rate", required: true, field: "earningsGrowthRate" },
  { key: "discount_rate", label: "Discount rate", unitHint: "percent", kind: "rate", required: true, field: "discountRate" },
  { key: "worklife_expectancy", label: "Remaining work-life expectancy", unitHint: "years", kind: "years", required: true, field: "worklifeYearsRemaining" },
  { key: "loss_start", label: "Past-loss period length", unitHint: "years", kind: "years", required: true, field: "lossStartYearsAgo" },
  { key: "benefits_rate", label: "Fringe benefits rate", unitHint: "percent", kind: "rate", required: false, field: "benefitsRate" },
  { key: "inflation_rate", label: "Inflation rate (household services growth)", unitHint: "percent", kind: "rate", required: false, field: "inflationRate" },
  { key: "mitigation_earnings", label: "Residual (mitigation) annual earnings", unitHint: "USD/year", kind: "currency", required: false, field: "mitigationAnnualEarnings" },
  { key: "household_services_hours", label: "Household services hours lost", unitHint: "hours/year", kind: "hours", required: false, field: "householdServicesAnnualHours" },
  { key: "household_services_rate", label: "Household services replacement rate", unitHint: "USD/hour", kind: "hourlyRate", required: false, field: "householdServicesHourlyRate" },
  { key: "household_services_years", label: "Household services loss period", unitHint: "years", kind: "years", required: false, field: "householdServicesYears" },
];

export const REQUIRED_KEYS = ASSUMPTION_KEYS.filter((k) => k.required).map((k) => k.key);

const KEY_DEF: Record<string, AssumptionKeyDef> = Object.fromEntries(
  ASSUMPTION_KEYS.map((k) => [k.key, k]),
);

// ── Row shapes (mirror the Prisma models without importing Prisma) ───────────

export interface AssumptionInput {
  key: string;
  value: string;
  unit: string;
}

/** Full assumption row as rendered in the report / workspace. */
export interface AssumptionRow extends AssumptionInput {
  source: string;
  effectiveDate?: Date | string | null;
  expertId?: string;
  expertName?: string | null;
  version?: number;
  rationale?: string | null;
}

export interface MedicalSource {
  /** ReportExport.id of the finalized LCP/MCP export referenced. */
  exportId: string;
  reportType: string;
  presentValue: number;
  /** Content hash of the referenced export at selection time (null on legacy rows). */
  contentSha256?: string | null;
  /** ReportExport.version at selection time. */
  version?: number;
  /** ISO timestamp of when this export was selected as the medical source. */
  selectedAt?: string;
}

/** Shape persisted into EconomicScenario.result by the economics API. */
export interface StoredEconResult {
  pastLoss: { nominal: number; withBenefits: number };
  futureLoss: { nominal: number; presentValue: number; withBenefitsPV: number };
  benefits: { rate: number; pastNominal: number; futurePresentValue: number };
  householdServices: { nominal: number; presentValue: number; included: boolean };
  medicalCostPresentValue: number;
  totalPresentValue: number;
  inputsHash: string;
  inputs?: unknown;
  /** Which finalized export supplied the medical PV — or null when none did. */
  medicalSource?: MedicalSource | null;
  /** Explicit omission note stored when no finalized export existed. */
  medicalNote?: string;
  /** Discount-rate sensitivity rows (stored on the base scenario only). */
  sensitivity?: { param: string; rows: { value: number; totalPresentValue: number }[] };
  /** Calculation-engine version that produced this result (absent on legacy rows). */
  engineVersion?: string;
}

export interface ScenarioRow {
  name: string;
  overrides?: Record<string, unknown> | null;
  result?: StoredEconResult | null;
  computedAt?: Date | string | null;
}

// ── Safe numeric parsing ─────────────────────────────────────────────────────

/** Strip $ , % and whitespace, then parse. Returns null when not a number. */
function parseNumeric(raw: string): number | null {
  const cleaned = String(raw).trim().replace(/[$,\s]/g, "").replace(/%$/, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const PERCENT_UNIT = /percent|pct|%/i;
const DECIMAL_UNIT = /decimal|fraction|^rate$/i;

/**
 * Parse one assumption row's value into the number EconInputs expects.
 * Rate-kind keys REQUIRE an unambiguous unit: percent-style units divide by
 * 100; decimal-style units pass through; anything else is invalid (a guessed
 * unit would be a silently-chosen assumption). A trailing "%" on the value
 * also marks a percent. Non-rate keys accept any unit and parse the number.
 */
function parseRow(def: AssumptionKeyDef, row: AssumptionInput): { value?: number; reason?: string } {
  const n = parseNumeric(row.value);
  if (n === null) return { reason: `value "${row.value}" is not a number` };
  if (def.kind !== "rate") return { value: n };
  const valueHasPercent = /%\s*$/.test(String(row.value).trim());
  if (valueHasPercent || PERCENT_UNIT.test(row.unit)) return { value: n / 100 };
  if (DECIMAL_UNIT.test(row.unit)) return { value: n };
  return { reason: `unit "${row.unit}" is ambiguous for a rate — use "percent" or "decimal"` };
}

/**
 * Map current EconomicAssumption rows to EconInputs.
 * `missing` lists every required key that is absent, plus every key (required
 * OR optional) whose entered value could not be parsed — with the reason.
 * `inputs` is present only when nothing is missing. NOTHING is ever defaulted.
 */
export function assumptionsToInputs(rows: AssumptionInput[]): { inputs?: EconInputs; missing: string[] } {
  const byKey = new Map<string, AssumptionInput>();
  for (const r of rows) if (KEY_DEF[r.key]) byKey.set(r.key, r); // later rows win; unknown keys ignored
  const missing: string[] = [];
  const fields: Partial<Record<keyof EconInputs, number>> = {};

  for (const def of ASSUMPTION_KEYS) {
    const row = byKey.get(def.key);
    if (!row) {
      if (def.required) missing.push(def.key);
      continue; // absent optional ⇒ component excluded, never estimated
    }
    const parsed = parseRow(def, row);
    if (parsed.reason !== undefined) {
      // An entered-but-unparsable value blocks compute even when optional —
      // an explicit entry must never be silently dropped.
      missing.push(`${def.key} (invalid: ${parsed.reason})`);
    } else {
      fields[def.field] = parsed.value;
    }
  }

  if (missing.length > 0) return { missing };
  return {
    missing,
    inputs: {
      baselineAnnualEarnings: fields.baselineAnnualEarnings as number,
      earningsGrowthRate: fields.earningsGrowthRate as number,
      discountRate: fields.discountRate as number,
      worklifeYearsRemaining: fields.worklifeYearsRemaining as number,
      lossStartYearsAgo: fields.lossStartYearsAgo as number,
      ...(fields.benefitsRate !== undefined ? { benefitsRate: fields.benefitsRate } : {}),
      ...(fields.inflationRate !== undefined ? { inflationRate: fields.inflationRate } : {}),
      ...(fields.mitigationAnnualEarnings !== undefined ? { mitigationAnnualEarnings: fields.mitigationAnnualEarnings } : {}),
      ...(fields.householdServicesAnnualHours !== undefined ? { householdServicesAnnualHours: fields.householdServicesAnnualHours } : {}),
      ...(fields.householdServicesHourlyRate !== undefined ? { householdServicesHourlyRate: fields.householdServicesHourlyRate } : {}),
      ...(fields.householdServicesYears !== undefined ? { householdServicesYears: fields.householdServicesYears } : {}),
    },
  };
}

/**
 * Apply scenario overrides expressed in ASSUMPTION space ({key: value}, in the
 * SAME unit as the current row for that key) and return the EconInputs-space
 * partial for scenarioCompare. Only known, currently-entered keys may be
 * overridden — anything else is reported, never guessed.
 */
export function overridesToPartialInputs(
  rows: AssumptionInput[],
  overrides: Record<string, number | string>,
): { partial?: Partial<EconInputs>; errors: string[] } {
  const errors: string[] = [];
  const partial: Partial<EconInputs> = {};
  const byKey = new Map<string, AssumptionInput>();
  for (const r of rows) if (KEY_DEF[r.key]) byKey.set(r.key, r);
  for (const [key, value] of Object.entries(overrides)) {
    const def = KEY_DEF[key];
    if (!def) {
      errors.push(`${key} (unknown assumption key)`);
      continue;
    }
    const current = byKey.get(key);
    if (!current) {
      errors.push(`${key} (no current assumption entered — enter it before overriding)`);
      continue;
    }
    const parsed = parseRow(def, { key, value: String(value), unit: current.unit });
    if (parsed.reason !== undefined) {
      errors.push(`${key} (invalid: ${parsed.reason})`);
      continue;
    }
    (partial as Record<string, number>)[def.field as string] = parsed.value as number;
  }
  if (errors.length > 0) return { errors };
  return { partial, errors };
}

// ── Staleness (fail-closed currency check) ───────────────────────────────────

export const RECOMPUTE_NOTE =
  "Assumptions or the medical-cost source changed after the last calculation — recompute the scenarios. Stale results are never used in a final report.";

/** The medical source currently eligible to supply the pass-through PV. */
export interface CurrentMedicalRef {
  exportId: string;
  presentValue: number;
}

/**
 * Deterministic currency check: for each stored scenario result, recompute the
 * input hash that the CURRENT assumptions (plus the currently eligible
 * medical-cost export) would produce and compare it with the stored
 * `inputsHash`. A mismatch — or a change in which export supplies the medical
 * component, or assumptions that no longer map to valid inputs — marks the
 * scenario STALE. Pure: no I/O, no clock. A stale scenario must never be
 * treated as current or feed a final report.
 */
export function computeScenarioStaleness(
  assumptions: AssumptionInput[],
  scenarios: ScenarioRow[],
  medical: CurrentMedicalRef | null,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const mapped = assumptionsToInputs(assumptions);
  const baseInputs: EconInputs | null = mapped.inputs
    ? { ...mapped.inputs, ...(medical ? { medicalCostPresentValue: medical.presentValue } : {}) }
    : null;

  for (const s of scenarios) {
    if (!s.result) continue; // never computed — nothing to be stale
    // Required assumptions no longer resolve → every stored result is stale.
    if (!baseInputs) {
      out.set(s.name, true);
      continue;
    }
    // The identity of the medical source must match, not just its amount.
    const storedMedicalId = s.result.medicalSource?.exportId ?? null;
    if (storedMedicalId !== (medical?.exportId ?? null)) {
      out.set(s.name, true);
      continue;
    }
    if (s.name === "base") {
      out.set(s.name, s.result.inputsHash !== hashEconInputs(baseInputs));
      continue;
    }
    const r = overridesToPartialInputs(assumptions, (s.overrides ?? {}) as Record<string, number | string>);
    if (!r.partial) {
      out.set(s.name, true); // overrides no longer resolve against current assumptions
      continue;
    }
    out.set(s.name, s.result.inputsHash !== hashEconInputs({ ...baseInputs, ...r.partial }));
  }
  return out;
}

// ── Readiness ladder ─────────────────────────────────────────────────────────

export type EconomistStatus =
  | "Intake incomplete"
  | "Expert input required"
  | "Draft support package available"
  | "Expert review required"
  | "Ready for final export";

export interface EconomistReadiness {
  status: EconomistStatus;
  /** Missing/invalid required inputs — populated only for "Intake incomplete". */
  missing: string[];
}

/**
 * Readiness ladder for the economist service line:
 *   Intake incomplete            — required assumption keys missing or invalid
 *   Expert input required        — assumptions complete, base scenario not computed
 *   Draft support package available — base scenario computed, no conclusions entered
 *   Expert review required       — conclusions entered, economist approval pending
 *   Ready for final export       — conclusions entered and economist-approved
 */
export function economistReadiness(
  assumptions: AssumptionInput[],
  scenarios: ScenarioRow[],
  hasVerifiedConclusion: boolean,
  approved: boolean,
  currency?: { baseStale: boolean },
): EconomistReadiness {
  const { missing } = assumptionsToInputs(assumptions);
  if (missing.length > 0) return { status: "Intake incomplete", missing };
  const base = scenarios.find((s) => s.name === "base" && s.result != null && s.computedAt != null);
  if (!base) return { status: "Expert input required", missing: [] };
  // Fail closed on currency: a stale base scenario means the stored numbers no
  // longer describe the current inputs — the ladder drops back to requiring a
  // recomputation, and any approval rung above it is unreachable until then.
  if (currency?.baseStale) return { status: "Expert input required", missing: [RECOMPUTE_NOTE] };
  if (!hasVerifiedConclusion) return { status: "Draft support package available", missing: [] };
  if (!approved) return { status: "Expert review required", missing: [] };
  return { status: "Ready for final export", missing: [] };
}

// ── Report composition (renders STORED results only — no math) ───────────────

const money = (n: number): string =>
  "$" + roundCurrency(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct = (n: number): string => `${roundCurrency(n * 100)}%`;

const fmtDate = (d: Date | string | null | undefined): string => {
  if (!d) return "—";
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "—";
  return `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`;
};

const h2 = (text: string): Block => ({ kind: "h2", text });
const p = (text: string, italics = false): Block => ({ kind: "p", text, italics });
const bullet = (text: string): Block => ({ kind: "bullet", text });
const source = (text: string): Block => ({ kind: "source", text });

const VOCATIONAL_KEYS = new Set(["worklife_expectancy", "mitigation_earnings"]);

export interface ComposeEconomistOpts {
  draft: boolean;
  expertApproved: boolean;
  /** Economist-entered conclusions. Absent ⇒ support package, draft forced. */
  conclusionText?: string;
}

/**
 * Compose the Forensic Economist Report ReportDoc.
 * - EVERY assumption row is rendered with value/unit/source/expert/version —
 *   nothing is hidden or summarized away.
 * - All amounts come verbatim from the STORED scenario results (rounded for
 *   display via roundCurrency); this function performs no calculation.
 * - Without economist conclusions the document is a support package and is
 *   FORCED to draft regardless of the requested mode or approval flag.
 */
export function composeEconomist(
  caseLabel: string,
  assumptions: AssumptionRow[],
  scenarios: ScenarioRow[],
  opts: ComposeEconomistOpts,
): ReportDoc {
  const blocks: Block[] = [];
  const base = scenarios.find((s) => s.name === "base" && s.result != null) ?? null;
  const baseResult = base?.result ?? null;
  const conclusionText = opts.conclusionText?.trim() || null;

  // ── Question Presented (static, neutral) ───────────────────────────────────
  blocks.push(h2("Question Presented"));
  blocks.push(
    p(
      "What is the economic value of the claimed financial losses in this matter — past and future earning capacity, fringe benefits, household services, and future medical costs — expressed in present-value terms under the explicitly stated assumptions below? This report takes no position on liability or causation; it presents deterministic calculations from assumptions that were each explicitly entered, sourced, and versioned.",
    ),
  );

  // ── Economic Assumptions (every row; nothing hidden) ───────────────────────
  blocks.push(h2("Economic Assumptions"));
  if (assumptions.length === 0) {
    blocks.push(p("No economic assumptions have been entered.", true));
  } else {
    blocks.push({
      kind: "table",
      caption: "Every assumption used in this analysis, with its source and version. No assumption is system-defaulted.",
      header: ["Key", "Value", "Unit", "Source", "Effective date", "Expert", "Version"],
      rows: assumptions.map((a) => [
        a.key,
        a.value,
        a.unit,
        a.source,
        fmtDate(a.effectiveDate),
        a.expertName ?? a.expertId ?? "—",
        String(a.version ?? 1),
      ]),
    });
  }

  // ── Vocational Inputs (attributed) ─────────────────────────────────────────
  blocks.push(h2("Vocational Inputs"));
  const vocational = assumptions.filter((a) => VOCATIONAL_KEYS.has(a.key));
  if (vocational.length > 0) {
    blocks.push(
      p(
        "The following vocationally derived inputs (work-life expectancy and residual earning capacity) were entered as assumptions and are attributed to their stated sources. Vocational conclusions themselves remain the province of the qualified vocational expert.",
      ),
    );
    for (const a of vocational) {
      blocks.push(bullet(`${a.key}: ${a.value} ${a.unit} — Source: ${a.source}${a.expertName ? ` (entered by ${a.expertName})` : ""}`));
    }
  } else {
    blocks.push(
      p(
        "No vocational input assumptions (work-life expectancy, residual earning capacity) have been entered. Any vocational conclusions must come from the qualified vocational expert.",
        true,
      ),
    );
  }

  // ── Medical-Cost Input (pass-through provenance) ───────────────────────────
  blocks.push(h2("Medical-Cost Input"));
  if (!baseResult) {
    blocks.push(p("Scenarios have not been computed; no medical-cost input has been resolved.", true));
  } else if (baseResult.medicalSource) {
    const ms = baseResult.medicalSource;
    blocks.push(
      p(
        `Present value of future medical costs: ${money(ms.presentValue)}, taken verbatim from finalized export ${ms.exportId} (${ms.reportType}). This figure is a pass-through from that export; it is not recomputed in this report.`,
      ),
    );
  } else {
    blocks.push(p(baseResult.medicalNote ?? MEDICAL_OMISSION_NOTE, true));
  }

  // ── Loss Calculations (stored base-scenario numbers, verbatim) ─────────────
  blocks.push(h2("Loss Calculations"));
  if (!baseResult) {
    blocks.push(
      p(
        "Loss calculations have not been run. Enter every required assumption and compute the base scenario; the engine refuses to run with any required input missing.",
        true,
      ),
    );
  } else {
    const r = baseResult;
    blocks.push({
      kind: "table",
      caption: "Base scenario. Amounts are rendered exactly as computed and stored; rounding is display-only.",
      header: ["Component", "Amount", "Basis"],
      rows: [
        ["Past lost earnings (nominal; no prejudgment interest)", money(r.pastLoss.nominal), DETERMINISTIC_LABEL],
        ["Past lost earnings incl. fringe benefits", money(r.pastLoss.withBenefits), DETERMINISTIC_LABEL],
        ["Future lost earning capacity (present value)", money(r.futureLoss.presentValue), DETERMINISTIC_LABEL],
        ["Future lost earning capacity incl. fringe benefits (PV)", money(r.futureLoss.withBenefitsPV), DETERMINISTIC_LABEL],
        [
          `Fringe benefits component (rate ${pct(r.benefits.rate)}; future PV)`,
          money(r.benefits.futurePresentValue),
          DETERMINISTIC_LABEL,
        ],
        [
          "Household services (present value)",
          r.householdServices.included ? money(r.householdServices.presentValue) : "Excluded — inputs not entered",
          DETERMINISTIC_LABEL,
        ],
        [
          "Future medical costs (present value)",
          r.medicalSource ? money(r.medicalCostPresentValue) : "Omitted — no finalized export referenced",
          r.medicalSource ? `Pass-through from export ${r.medicalSource.exportId}` : DETERMINISTIC_LABEL,
        ],
        ["TOTAL present value", money(r.totalPresentValue), DETERMINISTIC_LABEL],
      ],
    });
  }

  // ── Scenario Comparison ────────────────────────────────────────────────────
  blocks.push(h2("Scenario Comparison"));
  const computed = scenarios.filter((s) => s.result != null);
  if (computed.length === 0) {
    blocks.push(p("No scenarios have been computed.", true));
  } else {
    blocks.push({
      kind: "table",
      header: ["Scenario", "Total present value", "Computed"],
      rows: computed.map((s) => [s.name, money((s.result as StoredEconResult).totalPresentValue), fmtDate(s.computedAt)]),
    });
  }

  // ── Sensitivity (discount rate) ────────────────────────────────────────────
  blocks.push(h2("Sensitivity — Discount Rate"));
  const sensitivity = baseResult?.sensitivity;
  if (sensitivity && sensitivity.rows.length > 0) {
    blocks.push({
      kind: "table",
      caption: "Total present value under alternative discount rates, all other assumptions held at their stated values.",
      header: ["Discount rate", "Total present value"],
      rows: sensitivity.rows.map((row) => [pct(row.value), money(row.totalPresentValue)]),
    });
  } else {
    blocks.push(p("Sensitivity analysis has not been computed.", true));
  }

  // ── Source Publications (deduplicated) ─────────────────────────────────────
  blocks.push(h2("Source Publications"));
  const sources = [...new Set(assumptions.map((a) => a.source.trim()).filter((s) => s.length > 0))];
  if (sources.length === 0) {
    blocks.push(p("No assumption sources have been entered.", true));
  } else {
    for (const s of sources) blocks.push(source(s));
  }

  // ── Economist Conclusions ──────────────────────────────────────────────────
  blocks.push(h2("Economist Conclusions"));
  if (conclusionText) {
    blocks.push(p(conclusionText));
    blocks.push(p("Entered by the reviewing economist; attributed conclusions, not system-generated.", true));
  } else {
    blocks.push(p(NO_CONCLUSION_SENTENCE, true));
  }

  // ── Limitations ────────────────────────────────────────────────────────────
  blocks.push(h2("Limitations"));
  blocks.push(
    bullet(
      "Prejudgment interest is out of scope: past losses are reported in historical nominal dollars at face value. Interest is jurisdiction-specific and is applied by counsel or the court, not by this analysis.",
    ),
  );
  if (baseResult && !baseResult.householdServices.included) {
    blocks.push(bullet("Household services inputs were not entered; that component is excluded from all totals, not estimated."));
  }
  if (baseResult && !baseResult.medicalSource) {
    blocks.push(bullet("No finalized medical-cost export was referenced; the medical component is omitted from all totals, not estimated."));
  }
  if (!assumptions.some((a) => a.key === "benefits_rate")) {
    blocks.push(bullet("No fringe-benefits rate was entered; no benefits component is included."));
  }
  blocks.push(
    bullet(
      "Components whose inputs were not entered are excluded from every total. The system never defaults, estimates, or silently chooses an assumption.",
    ),
  );

  // Without economist conclusions this can only ever be a draft support
  // package — the requested mode and the approval flag cannot override that.
  const draft = opts.draft || !opts.expertApproved || !conclusionText;

  return {
    reportId: "FORENSIC_ECONOMIST_REPORT",
    title: "Forensic Economist Report",
    subtitle: conclusionText ? "Economic Loss Analysis" : "Economic Loss Analysis — Support Package (pending economist conclusions)",
    caseLabel,
    blocks,
    draft,
    disclosures: [ECONOMIST_DISCLOSURE],
  };
}
