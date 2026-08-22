// The cost worksheet is draft-only, and now says so unambiguously.
//
// buildCostCsv reads the CURRENT rows, not the recorded basis the DOCX renders
// from. That is deliberate — it is a working artifact and the export route
// refuses a final-mode CSV outright — but "derived from current values" is a
// material fact about every number in it, and a reader comparing it against a
// final report needs to know why the two can legitimately differ.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const deps = vi.hoisted(() => ({ bases: [] as unknown[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    futureCareItem: {
      findMany: vi.fn(async () => [
        {
          id: "i-1", category: "ORTHOPEDIC_SURGERY", service: "Total knee arthroplasty", specialty: "Ortho",
          cptCode: "27447", probability: "PROBABLE", confidence: 80, frequencyPerYear: 1, isLifetime: false,
          durationYears: 1, unitCost: 42000, annualCost: 42000, lifetimeCost: 42000, presentValue: 38000,
          lowCost: 32300, highCost: 47500, pricingSource: "CMS", evidenceStrength: "MODERATE",
          defenseVulnerability: "LOW", physicianStatus: "APPROVED", supersededAt: null, conditionId: "c-1",
        },
        {
          id: "i-2", category: "PHYSICAL_THERAPY", service: "Physical therapy", specialty: "PT",
          cptCode: "97110", probability: "PROBABLE", confidence: 70, frequencyPerYear: 12, isLifetime: false,
          durationYears: 2, unitCost: 150, annualCost: 1800, lifetimeCost: 3600, presentValue: 3400,
          lowCost: 2890, highCost: 4250, pricingSource: "FAIR Health", evidenceStrength: "MODERATE",
          defenseVulnerability: "LOW", physicianStatus: "APPROVED", supersededAt: null, conditionId: "c-1",
        },
      ]),
    },
    condition: { findMany: vi.fn(async () => [{ id: "c-1", name: "Knee osteoarthritis" }]) },
    validationFinding: { findMany: vi.fn(async () => []) },
    recommendationBasis: { findMany: vi.fn(async () => deps.bases) },
  },
}));

import { buildCostCsv } from "./report";

beforeEach(() => { deps.bases = []; });

describe("the worksheet states what it is derived from", () => {
  it("says it is not the approved record and may differ from the final report", async () => {
    const { csv } = await buildCostCsv("case-1");
    const first = csv.split("\n")[0];
    expect(first).toMatch(/SUPPORTING WORKSHEET/);
    expect(first).toMatch(/NOT the approved record/i);
    expect(first).toMatch(/derived from the case as it stands NOW/i);
    expect(first).toMatch(/may legitimately differ/i);
  });

  it("carries a RecordedBasis column", async () => {
    const { csv } = await buildCostCsv("case-1");
    expect(csv.split("\n")[1]).toContain("RecordedBasis");
  });

  it("reports ABSENT per row when no basis is recorded", async () => {
    const { csv } = await buildCostCsv("case-1");
    const rows = csv.split("\n").slice(2, 4);
    for (const r of rows) expect(r).toMatch(/ABSENT/);
  });

  it("reports COMPLETE when a full basis exists, and INCOMPLETE when it cannot answer", async () => {
    const { assembleBasis } = await import("@/lib/engine/basisAssembly");
    const { buildRecommendationDossier } = await import("@/lib/engine/medicalNecessity");
    const cond = { id: "c-1", name: "Knee osteoarthritis", relatedness: "RELATED", evidenceSources: [] } as never;
    const item = { id: "i-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", frequencyPerYear: 1, durationYears: 1, isLifetime: false, unitCost: 42000, presentValue: 38000, physicianStatus: "APPROVED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1" };
    const full = JSON.parse(JSON.stringify(assembleBasis({
      item: item as never,
      dossier: buildRecommendationDossier(item as never, cond, [], { subject: "p", pronounPoss: "their", lifeExpectancyYears: 30, adult: true }),
      conditions: [cond], chronology: [], kase: { subject: "p", pronounPoss: "their", lifeExpectancyYears: 30, adult: true },
      assumptions: { lifeExpectancyYears: 30, conditionName: "Knee osteoarthritis" },
    })));
    full.futureCareItemId = "i-1";
    const partial = JSON.parse(JSON.stringify(full));
    partial.futureCareItemId = "i-2";
    delete partial.projectionBasis;
    deps.bases = [full, partial];

    const { csv } = await buildCostCsv("case-1");
    const lines = csv.split("\n");
    expect(lines.find((l) => l.includes("Total knee arthroplasty"))).toMatch(/COMPLETE/);
    expect(lines.find((l) => l.includes("Physical therapy"))).toMatch(/INCOMPLETE/);
  });
});

describe("it is refused as a final release", () => {
  it("the export route rejects a final-mode CSV outright", async () => {
    // The worksheet can never become the released artifact, which is why it is
    // allowed to be current-derived at all.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "cases", "[caseId]", "export", "route.ts"), "utf8");
    expect(src).toMatch(/format === "CSV" && mode === "final"/);
    expect(src).toMatch(/CSV_FINAL_NOT_OFFERED/);
  });
});
