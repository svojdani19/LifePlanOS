// ─────────────────────────────────────────────────────────────────────────────
// Life-expectancy basis engine.
//
// The remaining life expectancy is the single most leveraged assumption in a
// life care plan — every lifetime line item multiplies through it — and until
// this module it was the only major input with no recorded provenance. The
// engine anchors the figure to a cited actuarial baseline (SSA period life
// table by age and sex), records every departure from that baseline as an
// explicit adjustment with a reason and a source, and emits validation
// findings when a plan totals lifetime care on an unstated or internally
// inconsistent basis. Nothing here invents a medical opinion: a rated-age or
// condition-specific adjustment is user-authored and attributed, never derived.
// ─────────────────────────────────────────────────────────────────────────────

// ── Actuarial reference table ────────────────────────────────────────────────
// Remaining life expectancy e(x) in years, by exact age and sex. Transcribed
// reference points from the U.S. Social Security Administration period life
// table (2021 edition, as published in the annual Trustees Report), linearly
// interpolated between pivot ages. The dataset is versioned so a newer edition
// (or a licensed table) can replace it in one place; the report cites the
// edition actually used.

export interface LifeTablePivot {
  age: number;
  male: number;
  female: number;
}

export interface LifeTableDataset {
  source: string;
  edition: string;
  citation: string;
  pivots: LifeTablePivot[]; // ascending by age
}

export const SSA_PERIOD_LIFE_TABLE: LifeTableDataset = {
  source: "U.S. Social Security Administration period life table",
  edition: "2021",
  citation: "Social Security Administration, Actuarial Life Table (2021 period life table), ssa.gov/oact/STATS/table4c6.html",
  pivots: [
    { age: 0, male: 73.5, female: 79.3 },
    { age: 5, male: 69.1, female: 74.8 },
    { age: 10, male: 64.2, female: 69.9 },
    { age: 15, male: 59.3, female: 65.0 },
    { age: 20, male: 54.5, female: 60.1 },
    { age: 25, male: 49.9, female: 55.3 },
    { age: 30, male: 45.3, female: 50.5 },
    { age: 35, male: 40.8, female: 45.8 },
    { age: 40, male: 36.3, female: 41.1 },
    { age: 45, male: 31.9, female: 36.5 },
    { age: 50, male: 27.7, female: 32.0 },
    { age: 55, male: 23.7, female: 27.7 },
    { age: 60, male: 19.9, female: 23.5 },
    { age: 65, male: 16.4, female: 19.6 },
    { age: 70, male: 13.2, female: 15.8 },
    { age: 75, male: 10.3, female: 12.3 },
    { age: 80, male: 7.8, female: 9.2 },
    { age: 85, male: 5.7, female: 6.7 },
    { age: 90, male: 4.1, female: 4.7 },
    { age: 95, male: 2.9, female: 3.2 },
    { age: 100, male: 2.1, female: 2.2 },
  ],
};

export type BasisSex = "MALE" | "FEMALE" | "OTHER" | "UNKNOWN";

export interface ActuarialBaseline {
  years: number;
  ageYears: number;
  sex: BasisSex;
  source: string;
  edition: string;
  citation: string;
  /** e.g. "SSA period life table (2021), age 45, male" */
  label: string;
}

/**
 * Baseline remaining life expectancy for an exact age and sex, linearly
 * interpolated between table pivots. Sex OTHER/UNKNOWN uses the male/female
 * average and says so in the label — the neutral default, never a guess.
 */
export function baselineLifeExpectancy(ageYears: number, sex: BasisSex, table: LifeTableDataset = SSA_PERIOD_LIFE_TABLE): ActuarialBaseline {
  const pivots = table.pivots;
  const age = Math.min(Math.max(ageYears, pivots[0].age), pivots[pivots.length - 1].age);
  let lo = pivots[0];
  let hi = pivots[pivots.length - 1];
  for (let i = 0; i < pivots.length - 1; i++) {
    if (age >= pivots[i].age && age <= pivots[i + 1].age) {
      lo = pivots[i];
      hi = pivots[i + 1];
      break;
    }
  }
  const t = hi.age === lo.age ? 0 : (age - lo.age) / (hi.age - lo.age);
  const at = (sel: (p: LifeTablePivot) => number) => sel(lo) + (sel(hi) - sel(lo)) * t;
  const years =
    sex === "MALE" ? at((p) => p.male) : sex === "FEMALE" ? at((p) => p.female) : (at((p) => p.male) + at((p) => p.female)) / 2;
  const sexLabel = sex === "MALE" ? "male" : sex === "FEMALE" ? "female" : "sex-averaged (sex not documented)";
  return {
    years: Math.round(years * 10) / 10,
    ageYears: Math.round(ageYears * 10) / 10,
    sex,
    source: table.source,
    edition: table.edition,
    citation: table.citation,
    label: `${table.source} (${table.edition}), age ${Math.round(ageYears)}, ${sexLabel}`,
  };
}

// ── The recorded basis ───────────────────────────────────────────────────────

export type LifeExpectancyMethod =
  | "ACTUARIAL_BASELINE" // table value, no adjustments
  | "ADJUSTED" // table baseline plus documented adjustments
  | "PHYSICIAN_DETERMINED" // physician-stated figure with its own source
  | "UNSTATED"; // a number in use with no recorded basis

export interface LifeExpectancyAdjustment {
  deltaYears: number; // signed departure from the running figure
  reason: string; // clinical rationale, e.g. "SCI-related reduction per rated-age report"
  source: string; // where the adjustment comes from (report, literature, physician)
  enteredById?: string | null;
  enteredByName?: string | null;
  enteredByRole?: string | null;
  enteredAt?: string | null;
}

export interface LifeExpectancyBasis {
  method: LifeExpectancyMethod;
  baselineYears: number | null;
  baselineLabel: string | null; // e.g. "SSA period life table (2021), age 45, male"
  baselineCitation: string | null;
  ageAtDetermination: number | null;
  sex: BasisSex | null;
  adjustments: LifeExpectancyAdjustment[];
  determinedYears: number;
  note?: string | null;
  approvedById?: string | null;
  approvedByName?: string | null;
  approvedByRole?: string | null;
  approvedAt?: string | null;
}

/** Build a basis from an actuarial baseline plus zero or more adjustments. The
 *  determined figure is always recomputed here — never taken from a client. */
export function composeBasis(baseline: ActuarialBaseline, adjustments: LifeExpectancyAdjustment[] = [], note?: string | null): LifeExpectancyBasis {
  const determined = Math.max(0.5, adjustments.reduce((y, adj) => y + adj.deltaYears, baseline.years));
  return {
    method: adjustments.length ? "ADJUSTED" : "ACTUARIAL_BASELINE",
    baselineYears: baseline.years,
    baselineLabel: baseline.label,
    baselineCitation: baseline.citation,
    ageAtDetermination: baseline.ageYears,
    sex: baseline.sex,
    adjustments,
    determinedYears: Math.round(determined * 10) / 10,
    note: note ?? null,
  };
}

/** A physician-determined basis: the figure and its stated source are the
 *  physician's own; the actuarial baseline is retained for comparison only. */
export function physicianBasis(years: number, source: string, reason: string, baseline: ActuarialBaseline | null): LifeExpectancyBasis {
  return {
    method: "PHYSICIAN_DETERMINED",
    baselineYears: baseline?.years ?? null,
    baselineLabel: baseline?.label ?? null,
    baselineCitation: baseline?.citation ?? null,
    ageAtDetermination: baseline?.ageYears ?? null,
    sex: baseline?.sex ?? null,
    adjustments: [{ deltaYears: Math.round((years - (baseline?.years ?? years)) * 10) / 10, reason, source }],
    determinedYears: Math.round(years * 10) / 10,
  };
}

/** Safe parse of the persisted JSON column. Returns null for anything that is
 *  not a structurally valid basis, so a corrupt row degrades to "unstated". */
export function parseBasis(raw: unknown): LifeExpectancyBasis | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<LifeExpectancyBasis>;
  if (typeof b.determinedYears !== "number" || !Number.isFinite(b.determinedYears)) return null;
  if (!b.method || !["ACTUARIAL_BASELINE", "ADJUSTED", "PHYSICIAN_DETERMINED", "UNSTATED"].includes(b.method)) return null;
  return {
    method: b.method as LifeExpectancyMethod,
    baselineYears: typeof b.baselineYears === "number" ? b.baselineYears : null,
    baselineLabel: typeof b.baselineLabel === "string" ? b.baselineLabel : null,
    baselineCitation: typeof b.baselineCitation === "string" ? b.baselineCitation : null,
    ageAtDetermination: typeof b.ageAtDetermination === "number" ? b.ageAtDetermination : null,
    sex: (b.sex as BasisSex) ?? null,
    adjustments: Array.isArray(b.adjustments)
      ? b.adjustments.filter((a): a is LifeExpectancyAdjustment => !!a && typeof a === "object" && typeof (a as LifeExpectancyAdjustment).deltaYears === "number")
      : [],
    determinedYears: b.determinedYears,
    note: typeof b.note === "string" ? b.note : null,
    approvedById: b.approvedById ?? null,
    approvedByName: b.approvedByName ?? null,
    approvedByRole: b.approvedByRole ?? null,
    approvedAt: b.approvedAt ?? null,
  };
}

// ── Narrative rendering (report Methodology) ─────────────────────────────────

/** The Methodology sentence(s) for the life-expectancy figure — states exactly
 *  what the basis is, or honestly that none is recorded. Never claims an
 *  actuarial source that was not actually applied. */
export function basisNarrative(basis: LifeExpectancyBasis | null, yearsInUse: number): string[] {
  const yrs = yearsInUse.toFixed(1);
  if (!basis || basis.method === "UNSTATED") {
    return [
      `A remaining life expectancy of ${yrs} years is applied as the projection horizon for all lifetime care. This figure was entered by the preparing planner; a documented actuarial basis has not yet been recorded for it.`,
    ];
  }
  const out: string[] = [];
  if (basis.method === "PHYSICIAN_DETERMINED") {
    const a = basis.adjustments[0];
    out.push(
      `A remaining life expectancy of ${yrs} years is applied as the projection horizon for all lifetime care, as determined for this patient${a?.source ? ` on the basis of ${a.source}` : ""}${a?.reason ? ` (${a.reason})` : ""}.`,
    );
    if (basis.baselineYears != null && basis.baselineLabel) {
      out.push(`For comparison, the unadjusted ${basis.baselineLabel} value is ${basis.baselineYears.toFixed(1)} years.`);
    }
  } else {
    out.push(
      `A remaining life expectancy of ${yrs} years is applied as the projection horizon for all lifetime care, derived from the ${basis.baselineLabel ?? "actuarial life table"}${basis.baselineYears != null && basis.method === "ADJUSTED" ? ` (baseline ${basis.baselineYears.toFixed(1)} years)` : ""}.`,
    );
    for (const adj of basis.adjustments) {
      const dir = adj.deltaYears >= 0 ? "increased" : "reduced";
      out.push(
        `The baseline was ${dir} by ${Math.abs(adj.deltaYears).toFixed(1)} years — ${adj.reason}${adj.source ? ` (source: ${adj.source})` : ""}.`,
      );
    }
  }
  if (basis.approvedByName) {
    out.push(`This life-expectancy determination was reviewed and approved by ${basis.approvedByName}.`);
  }
  return out;
}

// ── Validation findings ──────────────────────────────────────────────────────

export interface LifeExpectancyFindingInput {
  basis: LifeExpectancyBasis | null;
  /** the figure the cost engine is actually using */
  yearsInUse: number;
  /** live actuarial baseline recomputed from DOB + sex at validation time; null when DOB is unknown */
  currentBaseline: ActuarialBaseline | null;
  /** combined present value of totaled lifetime line items */
  lifetimePresentValue: number;
  /** count of totaled lifetime line items */
  lifetimeItemCount: number;
}

export interface AssumptionFinding {
  service: string;
  result: string;
  issue: string;
  severity: "Critical" | "High" | "Moderate" | "Low";
  suggestion: string;
  exportBlocking: boolean;
}

const LE_SERVICE = "Life-expectancy assumption";
/** Above this combined lifetime PV, an unstated basis blocks FINAL export —
 *  mirrors the unsupported-lifetime-duration threshold in clinicalReasoning. */
export const LE_BLOCKING_PV = 100_000;

/** Pure findings pass over the life-expectancy basis. Emits nothing when no
 *  lifetime care is totaled — a plan with only fixed-duration items does not
 *  ride on the figure. */
export function lifeExpectancyFindings(input: LifeExpectancyFindingInput): AssumptionFinding[] {
  const { basis, yearsInUse, currentBaseline, lifetimePresentValue, lifetimeItemCount } = input;
  if (lifetimeItemCount === 0) return [];
  const findings: AssumptionFinding[] = [];

  if (!basis || basis.method === "UNSTATED") {
    const blocking = lifetimePresentValue >= LE_BLOCKING_PV;
    findings.push({
      service: LE_SERVICE,
      result: "Life-expectancy basis unstated",
      issue: `${lifetimeItemCount} lifetime line item${lifetimeItemCount === 1 ? "" : "s"} totaling ${money(lifetimePresentValue)} at present value project over a remaining life expectancy of ${yearsInUse.toFixed(1)} years that has no recorded basis (no actuarial table, no documented adjustment, no physician determination).`,
      severity: blocking ? "Critical" : "High",
      suggestion: "Derive the actuarial baseline from the patient's age and sex, document any departure from it with a reason and source, or record a physician determination.",
      exportBlocking: blocking,
    });
    return findings;
  }

  // Internal consistency: the figure in use must be the determined figure.
  if (Math.abs(basis.determinedYears - yearsInUse) > 0.1) {
    findings.push({
      service: LE_SERVICE,
      result: "Life-expectancy mismatch",
      issue: `The recorded basis determines ${basis.determinedYears.toFixed(1)} years but the cost projection is using ${yearsInUse.toFixed(1)} years — the plan's stated basis and its arithmetic disagree.`,
      severity: "Critical",
      suggestion: "Recompute costs from the determined figure, or update the basis to match the figure actually in use.",
      exportBlocking: true,
    });
  }

  // Every adjustment must carry its reason and source.
  for (const adj of basis.adjustments) {
    if (!adj.reason?.trim() || !adj.source?.trim()) {
      findings.push({
        service: LE_SERVICE,
        result: "Undocumented life-expectancy adjustment",
        issue: `An adjustment of ${adj.deltaYears >= 0 ? "+" : ""}${adj.deltaYears.toFixed(1)} years to the actuarial baseline is missing ${!adj.reason?.trim() ? "a clinical reason" : "a source"}.`,
        severity: "High",
        suggestion: "State the clinical rationale and the source (rated-age report, literature, physician determination) for every departure from the actuarial baseline.",
        exportBlocking: false,
      });
    }
  }

  // Staleness: the recorded baseline should track the patient's current age.
  if (currentBaseline && basis.baselineYears != null && basis.method !== "PHYSICIAN_DETERMINED") {
    const drift = basis.baselineYears - currentBaseline.years;
    if (drift > 3) {
      findings.push({
        service: LE_SERVICE,
        result: "Life-expectancy baseline stale",
        issue: `The recorded actuarial baseline (${basis.baselineYears.toFixed(1)} years) exceeds the current table value for the patient's age and sex (${currentBaseline.years.toFixed(1)} years) by ${drift.toFixed(1)} years — it was likely determined at an earlier age.`,
        severity: "Moderate",
        suggestion: "Re-derive the baseline from the patient's current age before final export.",
        exportBlocking: false,
      });
    }
  }

  return findings;
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}
