import { describe, it, expect } from "vitest";
import {
  assumptionsToInputs,
  overridesToPartialInputs,
  economistReadiness,
  computeScenarioStaleness,
  composeEconomist,
  ECONOMIST_DISCLOSURE,
  NO_CONCLUSION_SENTENCE,
  MEDICAL_OMISSION_NOTE,
  DETERMINISTIC_LABEL,
  RECOMPUTE_NOTE,
  ASSUMPTION_KEYS,
  REQUIRED_KEYS,
  type AssumptionRow,
  type ScenarioRow,
  type StoredEconResult,
} from "./economist";
import { hashEconInputs } from "@/lib/engine/economics";
import type { Block } from "./doc";

// ─────────────────────────────────────────────────────────────────────────────
// P5 economist workflow — pure-module tests. No DB, no engine re-derivation:
// compose is verified against FAKE stored results whose numbers could not be
// produced by any computation, proving compose renders stored values verbatim.
// ─────────────────────────────────────────────────────────────────────────────

const row = (key: string, value: string, unit: string, extra: Partial<AssumptionRow> = {}): AssumptionRow => ({
  key,
  value,
  unit,
  source: extra.source ?? `Source for ${key}`,
  ...extra,
});

const REQUIRED_ROWS: AssumptionRow[] = [
  row("baseline_earnings", "85,000", "USD/year", { source: "W-2s 2021–2023; treating CPA summary", version: 1 }),
  row("earnings_growth", "3", "percent", { source: "BLS ECI, Table 5 (2025)", version: 2, expertName: "Dr. Econ" }),
  row("discount_rate", "4.5", "percent", { source: "20-yr Treasury average, FRED (2025)", version: 1 }),
  row("worklife_expectancy", "18.4", "years", { source: "Skoog-Ciecka-Krueger worklife tables (2019)", version: 1 }),
  row("loss_start", "2.5", "years", { source: "Date of injury per complaint ¶4", version: 1 }),
];

// Deliberately inconsistent fake numbers (past+future ≠ total) — if compose
// did ANY math, these could never all appear together.
const FAKE_RESULT: StoredEconResult = {
  pastLoss: { nominal: 111111.11, withBenefits: 222222.22 },
  futureLoss: { nominal: 333333.33, presentValue: 444444.44, withBenefitsPV: 555555.55 },
  benefits: { rate: 0.18, pastNominal: 12345.67, futurePresentValue: 76543.21 },
  householdServices: { nominal: 0, presentValue: 0, included: false },
  medicalCostPresentValue: 0,
  totalPresentValue: 987654.32,
  inputsHash: "deadbeef",
  medicalSource: null,
  medicalNote: MEDICAL_OMISSION_NOTE,
  sensitivity: {
    param: "discountRate",
    rows: [
      { value: 0.035, totalPresentValue: 1010101.01 },
      { value: 0.045, totalPresentValue: 987654.32 },
      { value: 0.055, totalPresentValue: 909090.9 },
    ],
  },
};

const baseScenario = (result: StoredEconResult | null = FAKE_RESULT): ScenarioRow => ({
  name: "base",
  overrides: {},
  result,
  computedAt: result ? "2026-07-27T12:00:00Z" : null,
});

const textOf = (doc: { blocks: Block[] }): string =>
  doc.blocks
    .map((b) => (b.kind === "table" ? [b.caption ?? "", ...b.header, ...b.rows.flat()].join(" | ") : `${b.label ?? ""} ${b.text ?? ""}`))
    .join("\n");

// ── assumptionsToInputs ──────────────────────────────────────────────────────

describe("assumptionsToInputs", () => {
  it("maps a complete required set, converting percent units to decimals", () => {
    const { inputs, missing } = assumptionsToInputs(REQUIRED_ROWS);
    expect(missing).toEqual([]);
    expect(inputs).toBeDefined();
    expect(inputs!.baselineAnnualEarnings).toBe(85000); // "$85,000"-style parsing
    expect(inputs!.earningsGrowthRate).toBeCloseTo(0.03, 10); // percent → decimal
    expect(inputs!.discountRate).toBeCloseTo(0.045, 10);
    expect(inputs!.worklifeYearsRemaining).toBe(18.4);
    expect(inputs!.lossStartYearsAgo).toBe(2.5);
    // Absent optionals stay absent — never defaulted to a value.
    expect(inputs!.benefitsRate).toBeUndefined();
    expect(inputs!.medicalCostPresentValue).toBeUndefined();
  });

  it("lists every missing required key and returns no inputs", () => {
    const { inputs, missing } = assumptionsToInputs([REQUIRED_ROWS[0]]); // only baseline_earnings
    expect(inputs).toBeUndefined();
    expect(missing).toEqual(["earnings_growth", "discount_rate", "worklife_expectancy", "loss_start"]);
    // And with nothing at all, every required key is listed.
    expect(assumptionsToInputs([]).missing).toEqual(REQUIRED_KEYS);
  });

  it("reports an unparsable value as missing, with the reason", () => {
    const rows = REQUIRED_ROWS.map((r) => (r.key === "discount_rate" ? { ...r, value: "about four" } : r));
    const { inputs, missing } = assumptionsToInputs(rows);
    expect(inputs).toBeUndefined();
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("discount_rate");
    expect(missing[0]).toContain('"about four" is not a number');
  });

  it("refuses an ambiguous unit on a rate rather than guessing", () => {
    const rows = REQUIRED_ROWS.map((r) => (r.key === "earnings_growth" ? { ...r, unit: "furlongs" } : r));
    const { inputs, missing } = assumptionsToInputs(rows);
    expect(inputs).toBeUndefined();
    expect(missing[0]).toContain("earnings_growth");
    expect(missing[0]).toContain("ambiguous");
    // Decimal-style unit is accepted as-is.
    const dec = assumptionsToInputs(REQUIRED_ROWS.map((r) => (r.key === "earnings_growth" ? { ...r, value: "0.03", unit: "decimal" } : r)));
    expect(dec.inputs!.earningsGrowthRate).toBeCloseTo(0.03, 10);
  });

  it("maps optional keys when entered, and blocks on an invalid optional (never silently drops it)", () => {
    const withOptional = [...REQUIRED_ROWS, row("benefits_rate", "18", "percent"), row("household_services_hours", "520", "hours/year")];
    const ok = assumptionsToInputs(withOptional);
    expect(ok.inputs!.benefitsRate).toBeCloseTo(0.18, 10);
    expect(ok.inputs!.householdServicesAnnualHours).toBe(520);

    const bad = assumptionsToInputs([...REQUIRED_ROWS, row("benefits_rate", "eighteen", "percent")]);
    expect(bad.inputs).toBeUndefined();
    expect(bad.missing[0]).toContain("benefits_rate");
  });
});

// ── overridesToPartialInputs ─────────────────────────────────────────────────

describe("overridesToPartialInputs", () => {
  it("maps override values through the current row's unit", () => {
    const { partial, errors } = overridesToPartialInputs(REQUIRED_ROWS, { discount_rate: "6", earnings_growth: 2 });
    expect(errors).toEqual([]);
    expect(partial).toEqual({ discountRate: 0.06, earningsGrowthRate: 0.02 });
  });

  it("rejects unknown keys and keys with no current assumption", () => {
    const r = overridesToPartialInputs(REQUIRED_ROWS, { nonsense: 1, benefits_rate: 10 });
    expect(r.partial).toBeUndefined();
    expect(r.errors.some((e) => e.includes("nonsense") && e.includes("unknown"))).toBe(true);
    expect(r.errors.some((e) => e.includes("benefits_rate") && e.includes("no current assumption"))).toBe(true);
  });
});

// ── economistReadiness ladder ────────────────────────────────────────────────

describe("economistReadiness", () => {
  it("is Intake incomplete while required keys are missing, listing them", () => {
    const r = economistReadiness([], [], false, false);
    expect(r.status).toBe("Intake incomplete");
    expect(r.missing).toEqual(REQUIRED_KEYS);
  });

  it("climbs the full ladder: input required → draft package → review → ready", () => {
    expect(economistReadiness(REQUIRED_ROWS, [], false, false).status).toBe("Expert input required");
    expect(economistReadiness(REQUIRED_ROWS, [baseScenario()], false, false).status).toBe("Draft support package available");
    expect(economistReadiness(REQUIRED_ROWS, [baseScenario()], true, false).status).toBe("Expert review required");
    expect(economistReadiness(REQUIRED_ROWS, [baseScenario()], true, true).status).toBe("Ready for final export");
  });

  it("ignores non-base or uncomputed scenarios when deciding the ladder", () => {
    const uncomputed: ScenarioRow = { name: "base", overrides: {}, result: null, computedAt: null };
    expect(economistReadiness(REQUIRED_ROWS, [uncomputed], false, false).status).toBe("Expert input required");
    const lowOnly: ScenarioRow = { ...baseScenario(), name: "low" };
    expect(economistReadiness(REQUIRED_ROWS, [lowOnly], false, false).status).toBe("Expert input required");
  });

  it("REGRESSION: a stale base scenario can NEVER be Ready for final export — even with an active approval", () => {
    const r = economistReadiness(REQUIRED_ROWS, [baseScenario()], true, true, { baseStale: true });
    expect(r.status).toBe("Expert input required");
    expect(r.missing).toEqual([RECOMPUTE_NOTE]);
  });
});

// ── computeScenarioStaleness ─────────────────────────────────────────────────

describe("computeScenarioStaleness", () => {
  const currentInputs = assumptionsToInputs(REQUIRED_ROWS).inputs!;

  const freshBase = (): ScenarioRow => ({
    name: "base",
    overrides: {},
    result: { ...FAKE_RESULT, inputsHash: hashEconInputs(currentInputs), medicalSource: null },
    computedAt: "2026-07-27T12:00:00Z",
  });

  it("identical current inputs ⇒ not stale; a changed assumption ⇒ stale", () => {
    expect(computeScenarioStaleness(REQUIRED_ROWS, [freshBase()], null).get("base")).toBe(false);
    const changed = REQUIRED_ROWS.map((r0) => (r0.key === "discount_rate" ? { ...r0, value: "5.5" } : r0));
    expect(computeScenarioStaleness(changed, [freshBase()], null).get("base")).toBe(true);
  });

  it("a change in WHICH export supplies the medical component is stale even at the same amount", () => {
    const withMedical = { ...currentInputs, medicalCostPresentValue: 100000 };
    const scenario: ScenarioRow = {
      name: "base",
      overrides: {},
      result: { ...FAKE_RESULT, inputsHash: hashEconInputs(withMedical), medicalSource: { exportId: "exp-old", reportType: "LIFE_CARE_PLAN", presentValue: 100000 } },
      computedAt: "2026-07-27T12:00:00Z",
    };
    expect(computeScenarioStaleness(REQUIRED_ROWS, [scenario], { exportId: "exp-old", presentValue: 100000 }).get("base")).toBe(false);
    expect(computeScenarioStaleness(REQUIRED_ROWS, [scenario], { exportId: "exp-new", presentValue: 100000 }).get("base")).toBe(true);
    expect(computeScenarioStaleness(REQUIRED_ROWS, [scenario], null).get("base")).toBe(true);
  });

  it("named scenarios are judged with their overrides applied to the CURRENT assumptions", () => {
    const lowInputs = { ...currentInputs, discountRate: 0.06 };
    const low: ScenarioRow = {
      name: "low",
      overrides: { discount_rate: "6" },
      result: { ...FAKE_RESULT, inputsHash: hashEconInputs(lowInputs), medicalSource: null },
      computedAt: "2026-07-27T12:00:00Z",
    };
    expect(computeScenarioStaleness(REQUIRED_ROWS, [low], null).get("low")).toBe(false);
    const changed = REQUIRED_ROWS.map((r0) => (r0.key === "baseline_earnings" ? { ...r0, value: "90,000" } : r0));
    expect(computeScenarioStaleness(changed, [low], null).get("low")).toBe(true);
  });

  it("required assumptions that no longer resolve make every stored result stale; uncomputed scenarios are skipped", () => {
    const map = computeScenarioStaleness(REQUIRED_ROWS.slice(0, 2), [freshBase(), { name: "low", overrides: {}, result: null }], null);
    expect(map.get("base")).toBe(true);
    expect(map.has("low")).toBe(false);
  });
});

// ── composeEconomist ─────────────────────────────────────────────────────────

describe("composeEconomist", () => {
  const rows = [...REQUIRED_ROWS, row("benefits_rate", "18", "percent", { source: "USDOL fringe study (2024)", version: 3 })];
  const scenarios: ScenarioRow[] = [
    baseScenario(),
    { name: "low", overrides: { discount_rate: "6" }, result: { ...FAKE_RESULT, totalPresentValue: 811111.11, sensitivity: undefined }, computedAt: "2026-07-27T12:00:00Z" },
    { name: "high", overrides: { discount_rate: "3" }, result: { ...FAKE_RESULT, totalPresentValue: 1222222.22, sensitivity: undefined }, computedAt: "2026-07-27T12:00:00Z" },
  ];

  it("renders EVERY assumption row with value, unit, source, expert, and version", () => {
    const doc = composeEconomist("Case LCP-2026-0007", rows, scenarios, { draft: false, expertApproved: true, conclusionText: "Opinion." });
    const table = doc.blocks.find((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
    expect(table).toBeDefined();
    expect(table!.header).toEqual(["Key", "Value", "Unit", "Source", "Effective date", "Expert", "Version"]);
    expect(table!.rows).toHaveLength(rows.length);
    for (const a of rows) {
      const rendered = table!.rows.find((r) => r[0] === a.key);
      expect(rendered).toBeDefined();
      expect(rendered![1]).toBe(a.value);
      expect(rendered![3]).toBe(a.source);
      expect(rendered![6]).toBe(String(a.version ?? 1));
    }
    // The growth row carries its expert's name.
    expect(table!.rows.find((r) => r[0] === "earnings_growth")![5]).toBe("Dr. Econ");
  });

  it("forces draft and prints the support-package sentence when conclusions are absent", () => {
    const doc = composeEconomist("Case X", rows, scenarios, { draft: false, expertApproved: true }); // no conclusionText
    expect(doc.draft).toBe(true); // forced despite final mode + approval
    expect(textOf(doc)).toContain(NO_CONCLUSION_SENTENCE);
    expect(doc.subtitle).toContain("Support Package");

    const withConclusion = composeEconomist("Case X", rows, scenarios, { draft: false, expertApproved: true, conclusionText: "My expert opinion is X." });
    expect(withConclusion.draft).toBe(false);
    expect(textOf(withConclusion)).toContain("My expert opinion is X.");
    expect(textOf(withConclusion)).not.toContain(NO_CONCLUSION_SENTENCE);
  });

  it("stays draft without economist approval even when conclusions exist", () => {
    const doc = composeEconomist("Case X", rows, scenarios, { draft: false, expertApproved: false, conclusionText: "Opinion." });
    expect(doc.draft).toBe(true);
  });

  it("renders stored numbers VERBATIM — no math is re-done in compose", () => {
    const doc = composeEconomist("Case X", rows, scenarios, { draft: true, expertApproved: false });
    const text = textOf(doc);
    // The fake result's internally inconsistent numbers all appear as stored.
    expect(text).toContain("$111,111.11"); // past nominal
    expect(text).toContain("$222,222.22"); // past with benefits
    expect(text).toContain("$444,444.44"); // future PV
    expect(text).toContain("$555,555.55"); // future with benefits PV
    expect(text).toContain("$987,654.32"); // stored total ≠ any sum of parts
    // Each calculation row is labeled as deterministic from stated assumptions.
    expect(text).toContain(DETERMINISTIC_LABEL);
  });

  it("builds the scenario comparison table from stored scenario totals", () => {
    const doc = composeEconomist("Case X", rows, scenarios, { draft: true, expertApproved: false });
    const tables = doc.blocks.filter((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
    const cmp = tables.find((t) => t.header[0] === "Scenario");
    expect(cmp).toBeDefined();
    expect(cmp!.rows.map((r) => r[0])).toEqual(["base", "low", "high"]);
    expect(cmp!.rows.map((r) => r[1])).toEqual(["$987,654.32", "$811,111.11", "$1,222,222.22"]);
  });

  it("renders the discount-rate sensitivity table from stored rows", () => {
    const doc = composeEconomist("Case X", rows, scenarios, { draft: true, expertApproved: false });
    const tables = doc.blocks.filter((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
    const sens = tables.find((t) => t.header[0] === "Discount rate");
    expect(sens).toBeDefined();
    expect(sens!.rows).toEqual([
      ["3.5%", "$1,010,101.01"],
      ["4.5%", "$987,654.32"],
      ["5.5%", "$909,090.90"],
    ]);
  });

  it("prints the explicit medical omission note when no finalized export was referenced", () => {
    const doc = composeEconomist("Case X", rows, scenarios, { draft: true, expertApproved: false });
    const text = textOf(doc);
    expect(text).toContain(MEDICAL_OMISSION_NOTE);
    expect(text).toContain("Omitted — no finalized export referenced");
  });

  it("attributes the medical PV to the exact export id when one was referenced", () => {
    const withMedical: ScenarioRow[] = [
      {
        ...baseScenario(),
        result: {
          ...FAKE_RESULT,
          medicalCostPresentValue: 654321.09,
          medicalSource: { exportId: "exp-42", reportType: "LIFE_CARE_PLAN", presentValue: 654321.09 },
          medicalNote: undefined,
        },
      },
    ];
    const text = textOf(composeEconomist("Case X", rows, withMedical, { draft: true, expertApproved: false }));
    expect(text).toContain("exp-42");
    expect(text).toContain("$654,321.09");
    expect(text).toContain("not recomputed");
    expect(text).not.toContain(MEDICAL_OMISSION_NOTE);
  });

  it("attributes vocational-scenario source assumptions and deduplicates source publications", () => {
    const dupSourceRows = rows.map((r) => (r.key === "loss_start" ? { ...r, source: rows[0].source } : r));
    const doc = composeEconomist("Case X", dupSourceRows, scenarios, { draft: true, expertApproved: false });
    const text = textOf(doc);
    // Vocational input (worklife_expectancy) noted with its source, attributed.
    expect(text).toContain("worklife_expectancy: 18.4 years — Source: Skoog-Ciecka-Krueger worklife tables (2019)");
    // Source Publications deduplicated: the shared source appears once as a source block.
    const sourceBlocks = doc.blocks.filter((b) => b.kind === "source").map((b) => (b.kind === "table" ? "" : b.text));
    expect(sourceBlocks.filter((s) => s === rows[0].source)).toHaveLength(1);
    expect(new Set(sourceBlocks).size).toBe(sourceBlocks.length);
  });

  it("carries the report-type disclosure and honest empty-state paragraphs", () => {
    const doc = composeEconomist("Case X", [], [], { draft: true, expertApproved: false });
    expect(doc.disclosures).toEqual([ECONOMIST_DISCLOSURE]);
    const text = textOf(doc);
    expect(text).toContain("No economic assumptions have been entered.");
    expect(text).toContain("Loss calculations have not been run.");
    expect(text).toContain("No scenarios have been computed.");
    expect(text).toContain("Sensitivity analysis has not been computed.");
    // Prejudgment-interest limitation is always present (economics.ts convention).
    expect(text).toContain("Prejudgment interest is out of scope");
    expect(doc.reportId).toBe("FORENSIC_ECONOMIST_REPORT");
  });

  it("exposes exactly the known assumption keys (5 required) for the workspace", () => {
    expect(REQUIRED_KEYS).toEqual(["baseline_earnings", "earnings_growth", "discount_rate", "worklife_expectancy", "loss_start"]);
    expect(ASSUMPTION_KEYS.map((k) => k.key)).toContain("household_services_rate");
    expect(ASSUMPTION_KEYS).toHaveLength(11);
  });
});
