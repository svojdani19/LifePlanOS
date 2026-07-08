import type { CareCategory } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Cost projection engine (Module 8). Baseline unit costs are illustrative
// national reference points; every value is editable per item in the UI. The
// engine computes annual → undiscounted lifetime → present value with low /
// expected / high scenarios, applying geographic, inflation, and discount
// assumptions carried on the Case.
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitCostRef {
  unit: number; // expected unit cost (USD)
  source: string; // pricing basis note
  cpt?: string;
}

// Reference unit costs by category. Sources are labeled so the report can cite
// the pricing basis (Medicare / UCR / cash-pay) rather than assert a number.
export const UNIT_COSTS: Record<CareCategory, UnitCostRef> = {
  PHYSICIAN_VISIT: { unit: 245, source: "CMS RVU / UCR blended", cpt: "99214" },
  SPECIALIST_VISIT: { unit: 385, source: "UCR specialist office visit", cpt: "99244" },
  PRIMARY_CARE: { unit: 195, source: "CMS RVU established patient", cpt: "99213" },
  ORTHOPEDIC_SURGERY: { unit: 42000, source: "UCR facility + surgeon global", cpt: "27447" },
  NEUROSURGERY: { unit: 78000, source: "UCR facility + surgeon global", cpt: "63030" },
  NEUROLOGY: { unit: 420, source: "UCR neurology consult", cpt: "99245" },
  PMR: { unit: 330, source: "UCR PM&R evaluation", cpt: "99204" },
  PAIN_MANAGEMENT: { unit: 360, source: "UCR pain office visit", cpt: "99204" },
  PSYCH: { unit: 210, source: "UCR psychotherapy 60 min", cpt: "90837" },
  PHYSICAL_THERAPY: { unit: 145, source: "CMS PT per visit", cpt: "97110" },
  OCCUPATIONAL_THERAPY: { unit: 150, source: "CMS OT per visit", cpt: "97530" },
  SPEECH_THERAPY: { unit: 160, source: "CMS SLP per visit", cpt: "92507" },
  COGNITIVE_THERAPY: { unit: 175, source: "UCR cognitive rehab", cpt: "97129" },
  MEDICATION: { unit: 2400, source: "Annual pharmacy cash-pay", cpt: undefined },
  INJECTION: { unit: 1850, source: "UCR image-guided injection", cpt: "20610" },
  IMAGING: { unit: 1350, source: "UCR MRI without contrast", cpt: "73721" },
  LABS: { unit: 220, source: "UCR lab panel", cpt: "80053" },
  DME: { unit: 3200, source: "DMEPOS + replacement schedule", cpt: undefined },
  ORTHOTICS_PROSTHETICS: { unit: 21000, source: "L-code prosthesis + fitting", cpt: "L5301" },
  MOBILITY_AID: { unit: 6800, source: "DMEPOS power/manual chair", cpt: "K0861" },
  HOME_MODIFICATION: { unit: 28000, source: "Contractor ADA modification", cpt: undefined },
  VEHICLE_MODIFICATION: { unit: 42000, source: "Adaptive vehicle + hand controls", cpt: undefined },
  ATTENDANT_CARE: { unit: 62000, source: "Home health aide annual (hrs × UCR)", cpt: undefined },
  SKILLED_NURSING: { unit: 128000, source: "SNF/LPN annual", cpt: undefined },
  CASE_MANAGEMENT: { unit: 4800, source: "RN case management annual", cpt: "T2022" },
  VOCATIONAL_REHAB: { unit: 8500, source: "Vocational evaluation + services", cpt: undefined },
  FUTURE_SURGERY: { unit: 55000, source: "UCR surgical global", cpt: undefined },
  REVISION_SURGERY: { unit: 68000, source: "UCR revision arthroplasty global", cpt: "27487" },
  COMPLICATION_MANAGEMENT: { unit: 15000, source: "UCR complication episode", cpt: undefined },
  ASSISTIVE_TECH: { unit: 5200, source: "AAC / assistive technology", cpt: undefined },
  SUPPLIES: { unit: 1800, source: "Annual medical supplies", cpt: undefined },
  TRANSPORTATION: { unit: 3600, source: "Medical transport annual", cpt: undefined },
  MISC: { unit: 1500, source: "Miscellaneous medical need", cpt: undefined },
};

export interface CaseAssumptions {
  lifeExpectancyYears: number;
  discountRate: number; // e.g. 0.03
  medicalInflation: number; // e.g. 0.032
  geographicFactor: number; // e.g. 1.0
}

export interface ProjectionInput {
  category: CareCategory;
  unitCost?: number; // override the reference
  frequencyPerYear: number;
  durationYears?: number | null;
  isLifetime: boolean;
}

export interface Projection {
  unitCost: number;
  annualCost: number;
  lifetimeCost: number; // undiscounted, inflation-adjusted future dollars
  presentValue: number;
  lowCost: number;
  highCost: number;
  pricingSource: string;
  cptCode?: string;
  years: number;
}

const LOW = 0.85;
const HIGH = 1.25;

export function project(input: ProjectionInput, a: CaseAssumptions): Projection {
  const ref = UNIT_COSTS[input.category];
  const unit = (input.unitCost ?? ref.unit) * a.geographicFactor;
  const annual = unit * input.frequencyPerYear;
  const years = input.isLifetime ? Math.max(0, a.lifeExpectancyYears) : Math.max(0, input.durationYears ?? 0);

  // Sum inflated annual cost, and discount to present value, year by year.
  let undiscounted = 0;
  let pv = 0;
  const whole = Math.floor(years);
  for (let t = 1; t <= whole; t++) {
    const inflated = annual * Math.pow(1 + a.medicalInflation, t - 1);
    undiscounted += inflated;
    pv += inflated / Math.pow(1 + a.discountRate, t - 1);
  }
  const frac = years - whole;
  if (frac > 0) {
    const t = whole + 1;
    const inflated = annual * Math.pow(1 + a.medicalInflation, t - 1) * frac;
    undiscounted += inflated;
    pv += inflated / Math.pow(1 + a.discountRate, t - 1);
  }

  return {
    unitCost: round(unit),
    annualCost: round(annual),
    lifetimeCost: round(undiscounted),
    presentValue: round(pv),
    lowCost: round(pv * LOW),
    highCost: round(pv * HIGH),
    pricingSource: ref.source,
    cptCode: ref.cpt,
    years,
  };
}

function round(n: number): number {
  return Math.round(n);
}
