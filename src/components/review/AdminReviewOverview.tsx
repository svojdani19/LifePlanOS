"use client";

// Firm administrator's Physician Review page — an oversight surface, not a
// review tool. Firm-wide needs (recommendations awaiting physician review)
// organized by case, narrowable by client or assigned attorney, with items
// presented the way the attorney's Future Care view presents them: service,
// probability, defense vulnerability, and MD status. No pricing, frequency,
// codes, clinical criteria, or review controls.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

export interface AdminReviewItem {
  id: string;
  service: string;
  category: string;
  specialty: string | null;
  probability: string;
  defenseVulnerability: string;
  physicianStatus: string;
}

export interface AdminReviewGroup {
  caseId: string;
  clientName: string;
  caseNumber: string;
  attorneys: string[];
  items: AdminReviewItem[];
}

const PROB_TONE: Record<string, BadgeTone> = { PROBABLE: "success", POSSIBLE: "warning", SPECULATIVE: "neutral", NOT_SUPPORTED: "danger" };
const VULN_TONE: Record<string, BadgeTone> = { LOW: "success", MODERATE: "warning", HIGH: "danger" };
const PHYS_TONE: Record<string, BadgeTone> = { PENDING: "warning", APPROVED: "success", MODIFIED: "info", REJECTED: "danger" };

export function AdminReviewOverview({ groups }: { groups: AdminReviewGroup[] }) {
  const [clientFilter, setClientFilter] = useState("");
  const [attorneyFilter, setAttorneyFilter] = useState("");

  const attorneys = useMemo(
    () => Array.from(new Set(groups.flatMap((g) => g.attorneys))).sort((a, b) => a.localeCompare(b)),
    [groups],
  );

  const shown = groups.filter(
    (g) =>
      (!clientFilter || g.caseId === clientFilter) &&
      (!attorneyFilter || g.attorneys.includes(attorneyFilter)),
  );
  const totalItems = shown.reduce((s, g) => s + g.items.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by client" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
          <option value="">All clients</option>
          {groups.map((g) => (
            <option key={g.caseId} value={g.caseId}>{g.clientName} — {g.caseNumber}</option>
          ))}
        </select>
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by attorney" value={attorneyFilter} onChange={(e) => setAttorneyFilter(e.target.value)}>
          <option value="">All attorneys</option>
          {attorneys.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <span className="ml-auto text-xs text-ink-400">
          {totalItems} item{totalItems === 1 ? "" : "s"} awaiting review across {shown.length} case{shown.length === 1 ? "" : "s"}
        </span>
      </div>

      {shown.length === 0 && (
        <div className="card p-8 text-center text-sm text-ink-500">Nothing is awaiting physician review for this selection.</div>
      )}

      {shown.map((g) => (
        <section key={g.caseId} className="card p-5" aria-label={`Case ${g.caseNumber}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 pb-2.5">
            <div className="min-w-0">
              <Link href={`/cases/${g.caseId}`} className="font-semibold text-brand-700 hover:underline">{g.clientName}</Link>
              <span className="ml-2 font-mono text-xs text-ink-400">{g.caseNumber}</span>
              {g.attorneys.length > 0 && (
                <p className="mt-0.5 text-xs text-ink-500">Attorney: <span className="font-medium text-ink-700">{g.attorneys.join(", ")}</span></p>
              )}
            </div>
            <Badge tone="warning">{g.items.length} awaiting review</Badge>
          </div>
          <div className="mt-3 space-y-2">
            {g.items.map((it) => (
              <div key={it.id} className="rounded-lg p-3 ring-1 ring-ink-100">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink-900">{it.service}</span>
                  <Badge tone={PROB_TONE[it.probability] ?? "neutral"}>{it.probability.toLowerCase()}</Badge>
                  <Badge tone={VULN_TONE[it.defenseVulnerability] ?? "neutral"}>defense vulnerability: {it.defenseVulnerability.toLowerCase()}</Badge>
                  <Badge tone={PHYS_TONE[it.physicianStatus] ?? "neutral"}>MD: {it.physicianStatus.toLowerCase()}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {it.category.replace(/_/g, " ").toLowerCase()}{it.specialty ? ` · ${it.specialty}` : ""}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
