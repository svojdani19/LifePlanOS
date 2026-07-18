"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpDown, Search } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { cn, formatDate } from "@/lib/utils";
import { filterSortCases, type CaseListRow, type CaseSortKey } from "@/lib/uiFilters";

const CASE_TYPE_LABELS: Record<string, string> = {
  PERSONAL_INJURY: "Personal Injury",
  MED_MAL: "Med Mal",
  WORKERS_COMP: "Workers' Comp",
  PRODUCT_LIABILITY: "Product Liability",
  CATASTROPHIC: "Catastrophic",
};
const SIDE_TONE: Record<string, BadgeTone> = { PLAINTIFF: "brand", DEFENSE: "warning", NEUTRAL: "slate" };
const CLOSED = new Set(["CLOSED", "ARCHIVED"]);

const COLUMNS: { key: CaseSortKey; label: string; className?: string }[] = [
  { key: "caseNumber", label: "Case #" },
  { key: "clientName", label: "Client" },
  { key: "caseType", label: "Type" },
  { key: "side", label: "Side" },
  { key: "status", label: "Stage" },
  { key: "updatedAt", label: "Updated" },
];

export function CasesTable({ rows }: { rows: CaseListRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [side, setSide] = useState("");
  const [caseType, setCaseType] = useState("");
  const [sortKey, setSortKey] = useState<CaseSortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [cursor, setCursor] = useState(-1); // keyboard row cursor

  const stages = useMemo(() => [...new Set(rows.map((r) => r.status))], [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.caseType))], [rows]);
  const shown = useMemo(
    () => filterSortCases(rows, { q, stage, side, caseType, sortKey, sortDir }),
    [rows, q, stage, side, caseType, sortKey, sortDir],
  );

  const sortBy = (key: CaseSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "updatedAt" ? "desc" : "asc"); }
  };

  return (
    <div>
      {/* Search + filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden />
          <input
            className="input py-1.5 pl-8 text-sm"
            placeholder="Search client or case #…"
            aria-label="Search cases"
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(-1); }}
          />
        </div>
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by stage" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {stages.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}
        </select>
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by side" value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="">All sides</option>
          {["PLAINTIFF", "DEFENSE", "NEUTRAL"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by case type" value={caseType} onChange={(e) => setCaseType(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => <option key={t} value={t}>{CASE_TYPE_LABELS[t] ?? t}</option>)}
        </select>
        {(q || stage || side || caseType) && (
          <button className="text-xs font-medium text-ink-500 hover:text-ink-800 hover:underline" onClick={() => { setQ(""); setStage(""); setSide(""); setCaseType(""); }}>
            Clear
          </button>
        )}
        <span className="ml-auto text-meta">{shown.length} of {rows.length}</span>
      </div>

      <div className="card mt-3 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-4 py-2.5 font-medium">
                  <button
                    className={cn("focusable inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-ink-800", sortKey === c.key && "text-ink-900")}
                    onClick={() => sortBy(c.key)}
                    aria-label={`Sort by ${c.label}`}
                  >
                    {c.label}
                    <ArrowUpDown className={cn("h-3 w-3", sortKey === c.key ? "opacity-100" : "opacity-30")} aria-hidden />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className="divide-y divide-ink-100"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((i) => Math.min(i + 1, shown.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setCursor((i) => Math.max(i - 1, 0)); }
              if (e.key === "Enter" && cursor >= 0 && shown[cursor]) router.push(`/cases/${shown[cursor].id}`);
            }}
          >
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-500">
                  {rows.length === 0 ? "No cases yet. Create your first case to begin an intake." : "No cases match the current filters."}
                </td>
              </tr>
            )}
            {shown.map((c, i) => {
              const closed = CLOSED.has(c.status);
              return (
                <tr
                  key={c.id}
                  tabIndex={0}
                  onFocus={() => setCursor(i)}
                  onClick={() => router.push(`/cases/${c.id}`)}
                  className={cn(
                    "focusable cursor-pointer transition-colors hover:bg-ink-50",
                    cursor === i && "bg-brand-50/60",
                    closed && "opacity-60",
                  )}
                >
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-500">{c.caseNumber}</td>
                  <td className="px-4 py-2.5 font-medium text-ink-900">{c.clientName}</td>
                  <td className="px-4 py-2.5 text-ink-600">{CASE_TYPE_LABELS[c.caseType] ?? c.caseType}</td>
                  <td className="px-4 py-2.5"><Badge tone={SIDE_TONE[c.side] ?? "neutral"}>{c.side.toLowerCase()}</Badge></td>
                  <td className="px-4 py-2.5"><Badge tone={closed ? "neutral" : "info"}>{c.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-2.5 text-ink-500">{formatDate(new Date(c.updatedAt))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
