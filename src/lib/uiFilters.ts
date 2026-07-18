// Pure list-view helpers for client tables (case list, future care, costs).
// Kept free of React/DOM so filtering and sorting behavior is unit-testable.

export interface CaseListRow {
  id: string;
  caseNumber: string;
  clientName: string;
  caseType: string;
  side: string;
  status: string;
  updatedAt: string; // ISO
}

export type CaseSortKey = "caseNumber" | "clientName" | "caseType" | "side" | "status" | "updatedAt";

export interface CaseListQuery {
  q?: string;
  stage?: string; // status value or "" for all
  side?: string;
  caseType?: string;
  sortKey?: CaseSortKey;
  sortDir?: "asc" | "desc";
}

const CLOSED_STATUSES = new Set(["CLOSED", "ARCHIVED"]);

export function filterSortCases(rows: CaseListRow[], query: CaseListQuery): CaseListRow[] {
  const q = (query.q ?? "").trim().toLowerCase();
  let out = rows.filter((r) => {
    if (q && !`${r.clientName} ${r.caseNumber}`.toLowerCase().includes(q)) return false;
    if (query.stage && r.status !== query.stage) return false;
    if (query.side && r.side !== query.side) return false;
    if (query.caseType && r.caseType !== query.caseType) return false;
    return true;
  });
  const key = query.sortKey ?? "updatedAt";
  const dir = query.sortDir ?? (key === "updatedAt" ? "desc" : "asc");
  const mul = dir === "desc" ? -1 : 1;
  out = [...out].sort((a, b) => {
    // Active cases always ahead of closed/archived, regardless of sort.
    const ac = CLOSED_STATUSES.has(a.status) ? 1 : 0;
    const bc = CLOSED_STATUSES.has(b.status) ? 1 : 0;
    if (ac !== bc) return ac - bc;
    const av = a[key] ?? "";
    const bv = b[key] ?? "";
    return av < bv ? -mul : av > bv ? mul : 0;
  });
  return out;
}

// ── Future care review filters ───────────────────────────────────────────────

export interface CareListRow {
  id: string;
  service: string;
  category: string;
  probability: string;
  physicianStatus: string;
  presentValue: number;
  lifetimeCost: number;
}

export type CareSortKey = "presentValue" | "lifetimeCost" | "service" | "category" | "physicianStatus";

export interface CareListQuery {
  q?: string;
  probability?: string;
  physicianStatus?: string;
  sortKey?: CareSortKey;
}

export function filterSortCare<T extends CareListRow>(rows: T[], query: CareListQuery): T[] {
  const q = (query.q ?? "").trim().toLowerCase();
  const out = rows.filter((r) => {
    if (q && !`${r.service} ${r.category}`.toLowerCase().includes(q)) return false;
    if (query.probability && r.probability !== query.probability) return false;
    if (query.physicianStatus && r.physicianStatus !== query.physicianStatus) return false;
    return true;
  });
  const key = query.sortKey ?? "presentValue";
  return [...out].sort((a, b) => {
    if (key === "presentValue" || key === "lifetimeCost") return (b[key] as number) - (a[key] as number);
    const av = String(a[key] ?? "").toLowerCase();
    const bv = String(b[key] ?? "").toLowerCase();
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}
