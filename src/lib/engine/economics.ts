import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Forensic-economics calculation engine (P5 — economist workflow).
//
// PURE + DETERMINISTIC. This module has no Prisma, no LLM, no Date.now, no
// randomness, and no I/O beyond node:crypto's sha-256 (itself deterministic).
// Given identical EconInputs it always returns identical EconResult, and the
// result carries an `inputsHash` (sha-256 of the canonical JSON of the inputs)
// so every stored EconomicResult can be tied back to the exact assumptions
// that produced it.
//
// CONVENTIONS (every number is an annual USD amount or a decimal rate):
// • Growth: a period of N years produces N annual amounts; the FIRST year of a
//   period is the base amount un-grown, i.e. year k (1-based) = base·(1+g)^(k−1).
//   `baselineAnnualEarnings` is therefore interpreted as the annual earnings
//   rate in the first year of whichever period a component covers (the
//   historical base year for past losses; the valuation date for future
//   losses). The engine does NOT chain the past period into the future base —
//   the caller supplies each assumption explicitly.
// • Discounting: end-of-year. An amount received during year k is discounted
//   k full years: PV = amount / (1+d)^k. Fractional final years are prorated
//   (amount scaled by the fraction) and discounted at the full final year.
// • Past losses are reported in historical nominal dollars and are NOT
//   discounted. Prejudgment interest is deliberately OUT OF SCOPE (it is
//   jurisdiction-specific and applied by counsel/court, not the economist
//   engine); the total simply adds past nominal dollars at face value.
// • Mitigation (residual earning capacity) is netted against baseline each
//   year and the annual net loss is floored at zero — residual capacity above
//   baseline never produces a negative "loss".
// • Fringe benefits (`benefitsRate`) apply to the NET EARNINGS loss only —
//   never to household services or medical costs.
// • `medicalCostPresentValue` is a pass-through from the LCP/MCP snapshot.
//   It is never recomputed here; it is added to the total verbatim.
//
// MISSING-INPUT POLICY: required inputs are never defaulted — the P5 workflow
// supplies explicitly-entered assumptions only, and a missing/invalid required
// input throws. Optional inputs default to ZERO EFFECT: absence means the
// component is EXCLUDED from the result, not estimated. Concretely:
//   • benefitsRate absent            → no fringe-benefit component
//   • mitigationAnnualEarnings absent→ no offset (gross loss)
//   • householdServices* absent      → household-services component is 0
//   • medicalCostPresentValue absent → medical component is 0
//
// ROUNDING: all functions return full-precision floats. Round ONLY at the
// presentation boundary, via `roundCurrency`.
// ─────────────────────────────────────────────────────────────────────────────

export interface EconInputs {
  /** Annual earnings in the first year of the loss period (USD). Required. */
  baselineAnnualEarnings: number;
  /** Annual nominal earnings growth rate (decimal, e.g. 0.03). Required. */
  earningsGrowthRate: number;
  /** Annual discount rate for present value (decimal). Required. */
  discountRate: number;
  /** Optional inflation rate used to grow household services (falls back to
   *  earningsGrowthRate when absent). */
  inflationRate?: number;
  /** Fringe benefits as a fraction of earnings, e.g. 0.18. Absent ⇒ excluded. */
  benefitsRate?: number;
  /** Remaining work-life expectancy in years (may be fractional). Required. */
  worklifeYearsRemaining: number;
  /** Length of the past-loss period in years (>= 0). Required. */
  lossStartYearsAgo: number;
  /** Residual (post-injury) earning capacity, annual USD. Absent ⇒ 0 offset. */
  mitigationAnnualEarnings?: number;
  /** Household services: annual hours lost. All three fields must be present
   *  for the component to be included. */
  householdServicesAnnualHours?: number;
  /** Household services: replacement hourly rate (USD). */
  householdServicesHourlyRate?: number;
  /** Household services: number of years of loss (may be fractional). */
  householdServicesYears?: number;
  /** Present value of future medical costs from the LCP/MCP snapshot —
   *  passed through verbatim, never recomputed here. Absent ⇒ 0. */
  medicalCostPresentValue?: number;
}

export interface EconResult {
  /** Past lost earnings, historical nominal dollars (NOT discounted; no
   *  prejudgment interest — out of scope, see header). */
  pastLoss: { nominal: number; withBenefits: number };
  /** Future lost earning capacity over the remaining work life. */
  futureLoss: { nominal: number; presentValue: number; withBenefitsPV: number };
  /** The fringe-benefit component isolated for display (rate applied to the
   *  net earnings loss only). Zero throughout when benefitsRate is absent. */
  benefits: { rate: number; pastNominal: number; futurePresentValue: number };
  /** Household services component; `included` is false (and both amounts 0)
   *  unless hours, rate, and years were all supplied. */
  householdServices: { nominal: number; presentValue: number; included: boolean };
  /** Pass-through from the LCP/MCP snapshot (0 when absent). */
  medicalCostPresentValue: number;
  /** pastLoss.withBenefits + futureLoss.withBenefitsPV
   *  + householdServices.presentValue + medicalCostPresentValue. */
  totalPresentValue: number;
  /** Echo of the exact inputs used (for storage alongside the result). */
  inputs: EconInputs;
  /** sha-256 hex of the canonical JSON of `inputs` (key-order independent;
   *  undefined-valued keys omitted, so explicit-undefined ≡ absent). */
  inputsHash: string;
}

// ── Validation ───────────────────────────────────────────────────────────────
// Required inputs are never defaulted; anything malformed throws with a
// message naming the offending field so the P5 UI can surface it.

function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`economics: ${name} must be a finite number (got ${String(value)})`);
  }
}

function assertRate(name: string, value: number): void {
  assertFinite(name, value);
  if (value < -1) throw new Error(`economics: ${name} must be >= -1 (got ${value})`);
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) throw new Error(`economics: ${name} must be >= 0 (got ${value})`);
}

/** Validate a full EconInputs object. Throws on the first problem found. */
export function validateEconInputs(inputs: EconInputs): void {
  assertNonNegative("baselineAnnualEarnings", inputs.baselineAnnualEarnings);
  assertRate("earningsGrowthRate", inputs.earningsGrowthRate);
  assertFinite("discountRate", inputs.discountRate);
  if (inputs.discountRate <= -1) {
    throw new Error(`economics: discountRate must be > -1 (got ${inputs.discountRate})`);
  }
  assertNonNegative("worklifeYearsRemaining", inputs.worklifeYearsRemaining);
  assertNonNegative("lossStartYearsAgo", inputs.lossStartYearsAgo);
  if (inputs.inflationRate !== undefined) assertRate("inflationRate", inputs.inflationRate);
  if (inputs.benefitsRate !== undefined) assertNonNegative("benefitsRate", inputs.benefitsRate);
  if (inputs.mitigationAnnualEarnings !== undefined)
    assertNonNegative("mitigationAnnualEarnings", inputs.mitigationAnnualEarnings);
  if (inputs.householdServicesAnnualHours !== undefined)
    assertNonNegative("householdServicesAnnualHours", inputs.householdServicesAnnualHours);
  if (inputs.householdServicesHourlyRate !== undefined)
    assertNonNegative("householdServicesHourlyRate", inputs.householdServicesHourlyRate);
  if (inputs.householdServicesYears !== undefined)
    assertNonNegative("householdServicesYears", inputs.householdServicesYears);
  if (inputs.medicalCostPresentValue !== undefined)
    assertNonNegative("medicalCostPresentValue", inputs.medicalCostPresentValue);
}

// ── Core primitives ──────────────────────────────────────────────────────────

/**
 * Year-by-year nominal amounts for a period of `years` years.
 * Year k (1-based) = base·(1+rate)^(k−1) — the first year is un-grown.
 * Fractional `years` add a final prorated element: e.g. 2.5 years of a flat
 * 100 → [100, 100, 50]. Returns [] for years = 0.
 */
export function growthSeries(base: number, rate: number, years: number): number[] {
  assertFinite("base", base);
  assertRate("rate", rate);
  assertNonNegative("years", years);
  const whole = Math.floor(years);
  const frac = years - whole;
  const out: number[] = [];
  for (let k = 0; k < whole; k++) out.push(base * Math.pow(1 + rate, k));
  if (frac > 0) out.push(base * Math.pow(1 + rate, whole) * frac);
  return out;
}

/**
 * End-of-year present value: amount / (1+discountRate)^yearsOut.
 * PV of 100,000 one year out at 5% = 95,238.10.
 */
export function presentValue(amount: number, discountRate: number, yearsOut: number): number {
  assertFinite("amount", amount);
  assertFinite("discountRate", discountRate);
  if (discountRate <= -1) throw new Error(`economics: discountRate must be > -1 (got ${discountRate})`);
  assertNonNegative("yearsOut", yearsOut);
  return amount / Math.pow(1 + discountRate, yearsOut);
}

/**
 * PV of a series of annual amounts under end-of-year discounting: element i
 * (0-based) is treated as received at the end of year i+1, so
 * PV = Σ series[i] / (1+d)^(i+1). With d = 0 this equals the nominal sum.
 */
export function pvOfSeries(series: number[], discountRate: number): number {
  let pv = 0;
  for (let i = 0; i < series.length; i++) {
    pv += presentValue(series[i], discountRate, i + 1);
  }
  return pv;
}

// ── Loss components ──────────────────────────────────────────────────────────

/** Annual net earnings loss (baseline − mitigation), floored at zero. */
function netAnnualLoss(inputs: EconInputs): number {
  return Math.max(0, inputs.baselineAnnualEarnings - (inputs.mitigationAnnualEarnings ?? 0));
}

/**
 * Past lost earnings: `lossStartYearsAgo` years of the net annual loss, grown
 * forward from the historical base year at earningsGrowthRate. Reported in
 * historical nominal dollars — NOT discounted, and no prejudgment interest
 * (out of scope; see module header). `withBenefits` adds benefitsRate × the
 * earnings loss (zero effect when benefitsRate is absent).
 */
export function pastLostEarnings(inputs: EconInputs): { nominal: number; withBenefits: number } {
  validateEconInputs(inputs);
  const series = growthSeries(netAnnualLoss(inputs), inputs.earningsGrowthRate, inputs.lossStartYearsAgo);
  const nominal = series.reduce((s, v) => s + v, 0);
  return { nominal, withBenefits: nominal * (1 + (inputs.benefitsRate ?? 0)) };
}

/**
 * Future lost earning capacity: `worklifeYearsRemaining` years of the net
 * annual loss, grown at earningsGrowthRate, then discounted end-of-year at
 * discountRate. `withBenefitsPV` = presentValue × (1 + benefitsRate).
 */
export function futureLostEarningCapacity(inputs: EconInputs): {
  nominal: number;
  presentValue: number;
  withBenefitsPV: number;
} {
  validateEconInputs(inputs);
  const series = growthSeries(netAnnualLoss(inputs), inputs.earningsGrowthRate, inputs.worklifeYearsRemaining);
  const nominal = series.reduce((s, v) => s + v, 0);
  const pv = pvOfSeries(series, inputs.discountRate);
  return { nominal, presentValue: pv, withBenefitsPV: pv * (1 + (inputs.benefitsRate ?? 0)) };
}

/**
 * Household services loss: annualHours × hourlyRate per year for
 * householdServicesYears, grown at inflationRate (falling back to
 * earningsGrowthRate when inflationRate is absent), discounted end-of-year.
 * If ANY of the three household inputs is absent the component is EXCLUDED
 * (returns zeros) — absence means excluded, not estimated.
 */
export function householdServicesLoss(inputs: EconInputs): { nominal: number; presentValue: number } {
  validateEconInputs(inputs);
  const { householdServicesAnnualHours: hours, householdServicesHourlyRate: rate, householdServicesYears: years } =
    inputs;
  if (hours === undefined || rate === undefined || years === undefined) {
    return { nominal: 0, presentValue: 0 };
  }
  const growth = inputs.inflationRate ?? inputs.earningsGrowthRate;
  const series = growthSeries(hours * rate, growth, years);
  return {
    nominal: series.reduce((s, v) => s + v, 0),
    presentValue: pvOfSeries(series, inputs.discountRate),
  };
}

// ── Canonical hashing ────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted recursively, undefined-valued keys
 * omitted (so an explicitly-undefined optional hashes identically to an
 * absent one). Deterministic for any JSON-serializable value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/** sha-256 hex digest of the canonical JSON of the inputs. */
export function hashEconInputs(inputs: EconInputs): string {
  return createHash("sha256").update(canonicalJson(inputs), "utf8").digest("hex");
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Full economic-loss computation. Assembles every component, the pass-through
 * medical PV, the grand total, and the inputs hash. Pure and deterministic:
 * identical inputs ⇒ identical (deep-equal) result.
 *
 * totalPresentValue = past nominal-with-benefits (historical dollars at face,
 * no prejudgment interest) + future PV-with-benefits + household services PV
 * + medicalCostPresentValue.
 */
export function computeEconomicLoss(inputs: EconInputs): EconResult {
  validateEconInputs(inputs);
  const pastLoss = pastLostEarnings(inputs);
  const futureLoss = futureLostEarningCapacity(inputs);
  const household = householdServicesLoss(inputs);
  const householdIncluded =
    inputs.householdServicesAnnualHours !== undefined &&
    inputs.householdServicesHourlyRate !== undefined &&
    inputs.householdServicesYears !== undefined;
  const medical = inputs.medicalCostPresentValue ?? 0;
  const benefitsRate = inputs.benefitsRate ?? 0;
  return {
    pastLoss,
    futureLoss,
    benefits: {
      rate: benefitsRate,
      pastNominal: pastLoss.withBenefits - pastLoss.nominal,
      futurePresentValue: futureLoss.withBenefitsPV - futureLoss.presentValue,
    },
    householdServices: { ...household, included: householdIncluded },
    medicalCostPresentValue: medical,
    totalPresentValue: pastLoss.withBenefits + futureLoss.withBenefitsPV + household.presentValue + medical,
    inputs: { ...inputs },
    inputsHash: hashEconInputs(inputs),
  };
}

// ── Scenarios & sensitivity ──────────────────────────────────────────────────

/**
 * Compute one EconResult per named scenario, each applying its own partial
 * override on top of `base` independently (overrides never accumulate across
 * scenarios). Keys whose override value is undefined are ignored rather than
 * clobbering the base value. Typical usage: { low: {...}, high: {...} }.
 */
export function scenarioCompare(
  base: EconInputs,
  overrides: Record<string, Partial<EconInputs>>,
): Record<string, EconResult> {
  const out: Record<string, EconResult> = {};
  for (const name of Object.keys(overrides)) {
    // Drop undefined-valued override keys so they don't clobber base values.
    const defined = Object.fromEntries(
      Object.entries(overrides[name]).filter(([, v]) => v !== undefined),
    ) as Partial<EconInputs>;
    out[name] = computeEconomicLoss({ ...base, ...defined });
  }
  return out;
}

/**
 * One-parameter sensitivity table: for each candidate value of `param`,
 * recompute the total present value with only that parameter changed.
 * Values are evaluated in the order given (no sorting) so the caller controls
 * row order in the report.
 */
export function sensitivityTable(
  base: EconInputs,
  param: keyof EconInputs,
  values: number[],
): { value: number; totalPresentValue: number }[] {
  return values.map((value) => ({
    value,
    totalPresentValue: computeEconomicLoss({ ...base, [param]: value }).totalPresentValue,
  }));
}

// ── Presentation ─────────────────────────────────────────────────────────────

/**
 * Round to cents for DISPLAY ONLY. Every computation above returns
 * full-precision floats; never feed rounded values back into calculations.
 */
export function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}
