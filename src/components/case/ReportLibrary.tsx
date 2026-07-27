"use client";

// Report Library (docs/22) — additive selector rendered inside the existing
// Report tab. Compact two-pane layout: a grouped report list on the left, the
// selected report's details, configuration, preview, and export on the right.
// Legacy types (LCP, Testimony Pack) are listed for completeness and point at
// the Generate Report card below, which is unchanged.

import { useCallback, useEffect, useState } from "react";

interface LibraryReport {
  id: string;
  name: string;
  description: string;
  category: string;
  legacy: boolean;
  approval: "none" | "standard" | "physician_required";
  formats: string[];
  defaultConfig: unknown;
  status: string;
  gateReason: string | null;
  blockingCount: number;
  lastGenerated: string | null;
}

const APPROVAL_LABEL: Record<string, string> = {
  none: "No physician approval required",
  standard: "Standard export gate",
  physician_required: "Physician approval required for final",
};

const STATUS_DOT: Record<string, string> = {
  Ready: "bg-emerald-500",
  "Previously exported": "bg-emerald-500",
  "Physician review required": "bg-amber-500",
  Blocked: "bg-red-500",
  "Not enough information": "bg-slate-300",
};

const CATEGORY_ORDER = ["Core", "Record review", "Damages", "Clinical analysis", "Governance", "Custom"];

const CUSTOM_SECTIONS = [
  "caseHeader", "executiveSummary", "chronology", "diagnoses", "imaging", "procedures",
  "treatmentHistory", "functionalLimitations", "providerRecommendations", "futureCare",
  "medicalNecessity", "costProjection", "evidence", "contradictoryEvidence",
  "missingEvidence", "literature", "physicianReview", "citations",
];

export default function ReportLibrary({ caseId, canExport }: { caseId: string; canExport: boolean }) {
  const [reports, setReports] = useState<LibraryReport[]>([]);
  const [selectedId, setSelectedId] = useState<string>("LIFE_CARE_PLAN");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<"final" | "draft">("final");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/reports`);
    if (res.ok) {
      const body = await res.json();
      setReports(body.reports ?? []);
    }
  }, [caseId]);
  useEffect(() => { void load(); }, [load]);

  const selected = reports.find((r) => r.id === selectedId) ?? null;

  function pick(r: LibraryReport) {
    setSelectedId(r.id);
    setConfig((r.defaultConfig as Record<string, unknown>) ?? {});
    setPreviewHtml(null);
    setError(null);
  }

  async function preview() {
    if (!selected) return;
    setBusy("preview"); setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/reports?preview=${selected.id}&config=${encodeURIComponent(JSON.stringify(config))}`);
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Preview failed");
      else setPreviewHtml(body.html);
    } finally { setBusy(null); }
  }

  async function exportAs(format: string) {
    if (!selected) return;
    setBusy(format); setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: selected.id, format, config, mode }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Export refused");
      else {
        window.open(`/api/cases/${caseId}/export/${body.export.id}/download`, "_blank");
        void load();
      }
    } finally { setBusy(null); }
  }

  const set = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));

  const categories = CATEGORY_ORDER.filter((c) => reports.some((r) => r.category === c))
    .concat([...new Set(reports.map((r) => r.category))].filter((c) => !CATEGORY_ORDER.includes(c)));

  return (
    <div className="card p-5">
      <div className="mb-1 text-sm font-semibold text-ink-900">Report Library</div>
      <p className="mb-4 text-xs text-ink-500">
        One reporting system, multiple outputs — every report draws from the same case data, evidence, costs, and physician decisions.
      </p>
      <div className="grid gap-4 lg:grid-cols-[16rem,1fr]">
        {/* Left: grouped report list */}
        <div className="space-y-3">
          {categories.map((cat) => (
            <div key={cat}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">{cat}</div>
              <div className="space-y-0.5">
                {reports.filter((r) => r.category === cat).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => pick(r)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${selectedId === r.id ? "bg-brand-50 font-semibold text-brand-800 ring-1 ring-brand-200" : "text-ink-700 hover:bg-ink-50"}`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[r.status] ?? "bg-slate-300"}`} title={r.status} />
                    <span className="truncate">{r.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Right: selected report detail */}
        <div className="rounded-lg border border-ink-100 p-4">
          {!selected ? (
            <p className="text-xs text-ink-400">Select a report type.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink-900">{selected.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${selected.status === "Blocked" ? "bg-red-100 text-red-700" : selected.status === "Physician review required" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{selected.status}</span>
                {selected.lastGenerated && <span className="text-[10px] text-ink-400">last {new Date(selected.lastGenerated).toLocaleDateString()}</span>}
              </div>
              <p className="mt-1 text-xs text-ink-500">{selected.description}</p>
              <p className="mt-1 text-[10px] text-ink-400">{APPROVAL_LABEL[selected.approval]} · {selected.formats.join(" / ")}</p>
              {selected.gateReason && <p className="mt-2 text-xs text-amber-700">{selected.gateReason}</p>}

              {selected.legacy ? (
                <p className="mt-3 text-xs text-ink-500">Generated from the card below — the original workflow, unchanged.</p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
                    {selected.id === "MEDICAL_CHRONOLOGY" && (
                      <>
                        <label className="flex flex-col gap-1">From
                          <input type="date" className="input py-1" onChange={(e) => set("from", e.target.value || undefined)} /></label>
                        <label className="flex flex-col gap-1">To
                          <input type="date" className="input py-1" onChange={(e) => set("to", e.target.value || undefined)} /></label>
                        <label className="flex flex-col gap-1">Order
                          <select className="input py-1" value={(config.order as string) ?? "asc"} onChange={(e) => set("order", e.target.value)}>
                            <option value="asc">Ascending</option><option value="desc">Descending</option>
                          </select></label>
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={!!config.includeExcerpts} onChange={(e) => set("includeExcerpts", e.target.checked)} /> Source excerpts</label>
                      </>
                    )}
                    {selected.id === "MEDICAL_RECORD_SUMMARY" && (
                      <label className="flex flex-col gap-1">Detail
                        <select className="input py-1" value={(config.detail as string) ?? "standard"} onChange={(e) => set("detail", e.target.value)}>
                          <option value="brief">Brief</option><option value="standard">Standard</option><option value="detailed">Detailed</option>
                        </select></label>
                    )}
                    {selected.id === "COST_PROJECTION" && (
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!config.includeConditional} onChange={(e) => set("includeConditional", e.target.checked)} /> Include conditional items (separately labeled)</label>
                    )}
                    {selected.id === "CUSTOM" && (
                      <div className="flex flex-wrap gap-1.5">
                        {CUSTOM_SECTIONS.map((s) => {
                          const sel = Array.isArray(config.sections) && (config.sections as string[]).includes(s);
                          return (
                            <button key={s} onClick={() => set("sections", sel ? (config.sections as string[]).filter((x) => x !== s) : [...((config.sections as string[]) ?? []), s])}
                              className={`rounded border px-1.5 py-0.5 text-[10px] ${sel ? "border-brand-600 bg-brand-50 text-brand-800" : "border-ink-200 text-ink-500"}`}>
                              {s}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <label className="flex flex-col gap-1">Mode
                      <select className="input py-1" value={mode} onChange={(e) => setMode(e.target.value as "final" | "draft")}>
                        <option value="final">Final</option><option value="draft">Draft (watermarked)</option>
                      </select></label>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="btn-outline px-3 py-1.5 text-xs" disabled={busy !== null} onClick={preview}>
                      {busy === "preview" ? "Building preview…" : "Preview"}
                    </button>
                    {canExport
                      ? selected.formats.map((f) => (
                          <button key={f} className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => exportAs(f)}>
                            {busy === f ? "Exporting…" : `Export ${f}`}
                          </button>
                        ))
                      : <span className="text-xs text-ink-400">Your role cannot export reports.</span>}
                  </div>
                  {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

                  {previewHtml && (
                    <div className="mt-3 overflow-hidden rounded border border-ink-100 bg-white">
                      <iframe title="Report preview" srcDoc={previewHtml} className="h-[26rem] w-full" sandbox="" />
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
