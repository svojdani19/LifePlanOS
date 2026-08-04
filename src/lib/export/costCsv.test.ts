// Supporting cost worksheet (CSV) — release semantics. Every row must disclose
// its inclusion/review/evidence status, totals must cover only the
// deterministic included set, and user-controlled cells must be safe against
// spreadsheet formula injection.

import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({
  itemFindMany: vi.fn(),
  conditionFindMany: vi.fn(),
  findingFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    futureCareItem: { findMany: db.itemFindMany },
    condition: { findMany: db.conditionFindMany },
    validationFinding: { findMany: db.findingFindMany },
  },
}));

// Inclusion policy is the integrity engine's and is tested in its own suite;
// here it is mocked so the CSV's obedience to the included set is what's under
// test: APPROVED items are included, everything else is excluded.
vi.mock("@/lib/engine/integrity", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runIntegrityCheck: ({ recommendations }: { recommendations: { physicianStatus?: string }[] }) => ({
      perItem: new Map(recommendations.map((r) => [r, { includedInTotal: r.physicianStatus === "APPROVED" }])),
      findings: [],
      counts: {},
    }),
  };
});

import { buildCostCsv } from "./report";

function itemRow(over: Record<string, unknown>) {
  return {
    id: "i1",
    category: "PHYSICIAN_VISIT",
    service: "Orthopedic follow-up",
    specialty: "Orthopedic Surgery",
    cptCode: "99214",
    probability: "PROBABLE",
    confidence: 80,
    frequencyPerYear: 2,
    durationYears: null,
    isLifetime: true,
    unitCost: 200,
    annualCost: 400,
    lifetimeCost: 12000,
    presentValue: 9000,
    lowCost: 8000,
    highCost: 11000,
    pricingSource: "FAIR Health",
    evidenceStrength: "strong",
    defenseVulnerability: "LOW",
    physicianStatus: "APPROVED",
    ...over,
  };
}

describe("buildCostCsv (supporting worksheet)", () => {
  it("totals and count cover only the included set; excluded rows are disclosed, not totaled", async () => {
    db.itemFindMany.mockResolvedValue([
      itemRow({ id: "a", physicianStatus: "APPROVED", lifetimeCost: 12000, presentValue: 9000 }),
      itemRow({ id: "b", service: "Speculative therapy", physicianStatus: "PENDING", lifetimeCost: 5000, presentValue: 4000 }),
      itemRow({ id: "c", service: "Rejected item", physicianStatus: "REJECTED", lifetimeCost: 7000, presentValue: 6000 }),
    ]);
    db.conditionFindMany.mockResolvedValue([]);
    db.findingFindMany.mockResolvedValue([]);

    const out = await buildCostCsv("case-1");
    // Pending/rejected/speculative rows never silently enter final totals.
    expect(out.itemCount).toBe(1);
    expect(out.totalLifetime).toBe(12000);
    expect(out.totalPresentValue).toBe(9000);
    expect(out.csv).toContain("IncludedInFinalTotals");
    expect(out.csv).toContain("NO — excluded from totals");
    expect(out.csv).toContain("1 of 3 rows included");
    // Disclosure columns exist on every row.
    expect(out.csv).toContain("PhysicianStatus");
    expect(out.csv).toContain("ValidationWarnings");
    expect(out.csv).toContain("DurationBasis");
    expect(out.csv).toContain("SUPPORTING WORKSHEET");
  });

  it("flags lifetime duration as an assumption when an open finding questions it, and carries open warnings per row", async () => {
    db.itemFindMany.mockResolvedValue([itemRow({ id: "a", service: "Attendant care" })]);
    db.conditionFindMany.mockResolvedValue([]);
    db.findingFindMany.mockResolvedValue([
      { service: "Attendant care", result: "Lifetime duration unsupported", exportBlocking: true },
    ]);
    const out = await buildCostCsv("case-1");
    expect(out.csv).toContain("ASSUMPTION pending review");
    expect(out.csv).toContain("BLOCKING: Lifetime duration unsupported");
  });

  it("neutralizes spreadsheet-formula payloads in user-controlled cells", async () => {
    db.itemFindMany.mockResolvedValue([
      itemRow({ id: "a", service: "=HYPERLINK(\"http://evil\",\"x\")", specialty: "+SUM(A1:A9)", cptCode: "@cmd" }),
    ]);
    db.conditionFindMany.mockResolvedValue([]);
    db.findingFindMany.mockResolvedValue([]);
    const out = await buildCostCsv("case-1");
    // Formula-leading cells are prefixed with an apostrophe (inside quoting).
    expect(out.csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(out.csv).toContain("'+SUM(A1:A9)");
    expect(out.csv).toContain("'@cmd");
    expect(out.csv).not.toMatch(/^=|,=/m);
  });
});
