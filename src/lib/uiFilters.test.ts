import { describe, it, expect } from "vitest";
import { filterSortCases, filterSortCare, type CaseListRow, type CareListRow } from "./uiFilters";

const cases: CaseListRow[] = [
  { id: "1", caseNumber: "LCP-0001", clientName: "Maria Gonzalez", caseType: "MED_MAL", side: "PLAINTIFF", status: "RECORDS", updatedAt: "2026-07-10" },
  { id: "2", caseNumber: "LCP-0002", clientName: "David Chen", caseType: "PERSONAL_INJURY", side: "PLAINTIFF", status: "FUTURE_CARE", updatedAt: "2026-07-15" },
  { id: "3", caseNumber: "LCP-0003", clientName: "Patricia Ellis", caseType: "WORKERS_COMP", side: "NEUTRAL", status: "CLOSED", updatedAt: "2026-07-16" },
  { id: "4", caseNumber: "LCP-0004", clientName: "Robert Ford", caseType: "PRODUCT_LIABILITY", side: "DEFENSE", status: "INTAKE", updatedAt: "2026-07-12" },
];

describe("filterSortCases", () => {
  it("searches by client name and case number, case-insensitively", () => {
    expect(filterSortCases(cases, { q: "chen" }).map((c) => c.id)).toEqual(["2"]);
    expect(filterSortCases(cases, { q: "lcp-0004" }).map((c) => c.id)).toEqual(["4"]);
  });

  it("filters by stage, side, and case type", () => {
    expect(filterSortCases(cases, { stage: "INTAKE" }).map((c) => c.id)).toEqual(["4"]);
    expect(filterSortCases(cases, { side: "PLAINTIFF" }).map((c) => c.id).sort()).toEqual(["1", "2"]);
    expect(filterSortCases(cases, { caseType: "WORKERS_COMP" }).map((c) => c.id)).toEqual(["3"]);
  });

  it("defaults to most-recently-updated first with closed cases always last", () => {
    // Case 3 is newest but CLOSED — it must sort after every active case.
    expect(filterSortCases(cases, {}).map((c) => c.id)).toEqual(["2", "4", "1", "3"]);
  });

  it("sorts by an explicit column and direction", () => {
    expect(filterSortCases(cases, { sortKey: "clientName", sortDir: "asc" }).map((c) => c.clientName)[0]).toBe("David Chen");
    expect(filterSortCases(cases, { sortKey: "clientName", sortDir: "desc" }).map((c) => c.clientName)[0]).toBe("Robert Ford");
  });
});

const care: CareListRow[] = [
  { id: "a", service: "Physical therapy", category: "PHYSICAL_THERAPY", probability: "PROBABLE", physicianStatus: "APPROVED", presentValue: 50_000, lifetimeCost: 80_000 },
  { id: "b", service: "Cervical epidural steroid injection", category: "INJECTION", probability: "PROBABLE", physicianStatus: "PENDING", presentValue: 65_000, lifetimeCost: 70_000 },
  { id: "c", service: "Revision knee arthroplasty", category: "ORTHOPEDIC_SURGERY", probability: "POSSIBLE", physicianStatus: "PENDING", presentValue: 68_000, lifetimeCost: 68_000 },
];

describe("filterSortCare", () => {
  it("searches service and category text", () => {
    expect(filterSortCare(care, { q: "epidural" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterSortCare(care, { q: "surgery" }).map((c) => c.id)).toEqual(["c"]);
  });

  it("filters by probability and physician status", () => {
    expect(filterSortCare(care, { probability: "POSSIBLE" }).map((c) => c.id)).toEqual(["c"]);
    expect(filterSortCare(care, { physicianStatus: "PENDING" }).map((c) => c.id).sort()).toEqual(["b", "c"]);
  });

  it("sorts by present value descending by default and by name when asked", () => {
    expect(filterSortCare(care, {}).map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect(filterSortCare(care, { sortKey: "service" })[0].id).toBe("b");
  });
});
