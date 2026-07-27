"use client";

// Report Library (docs/22) — additive selector rendered inside the existing
// Report tab, ABOVE the legacy Generate Report card (which is unchanged and
// remains the default Life Care Plan workflow). Lists every registered report
// type with readiness, approval requirement, configuration, HTML preview, and
// export. Legacy types (LCP, Testimony Pack) are shown for completeness and
// point at their existing controls below.

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

const STATUS_CLASS: Record<string, string> = {
  Ready: "bg-emerald-100 text-emerald-800",
  "Previously exported": "bg-emerald-100 text-emerald-800",
  "Physician review required": "bg-amber-100 text-amber-800",
  Blocked: "bg-red-100 text-red-700",
  "Not enough information": "bg-slate-100 text-slate-600",
};

export default function ReportLibrary({ caseId, canExport }: { caseId: string; canExport: boolean }) {
  const [reports, setReports] = useState<LibraryReport[]>([]);
  const [selected, setSelected] = useState<LibraryReport | null>(null);
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

  function pick(r: LibraryReport) {
    setSelected(r);
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

  return (
    <div className="card p-5">
      <div className="mb-1 text-sm font-semibold text-ink">Report Library</div>
      <p className="mb-4 text-xs text-slate-500">
        Choose a report type. All reports draw from the same case data, evidence, costs, and physician decisions.
        The Comprehensive Life Care Plan remains the default and uses the Generate Report card below.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {reports.map((r) => (
          <button
            key={r.id}
            onClick={() => pick(r)}
            className={`rounded-lg border p-3 text-left text-xs transition ${selected?.id === r.id ? "border-teal-600 ring-1 ring-teal-600" : "border-slate-200 hover:border-slate-300"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{r.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[r.status] ?? "bg-slate-100 text-slate-600"}`}>{r.status}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-slate-500">{r.description}</div>
            <div className="mt-1 text-[10px] text-slate-400">
              {APPROVAL_LABEL[r.approval]} · {r.formats.join(" / ")}
              {r.lastGenerated ? ` · last ${new Date(r.lastGenerated).toLocaleDateString()}` : ""}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="mt-4 rounded-lg border border-slate-200 p-4">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink">{selected.name}</div>
            <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => { setSelected(null); setPreviewHtml(null); }}>Back to list</button>
          </div>
          <p className="mb-2 text-xs text-slate-500">{selected.description}</p>
          {selected.gateReason && <p className="mb-2 text-xs text-amber-700">{selected.gateReason}</p>}

          {selected.legacy ? (
            <p className="text-xs text-slate-500">This report uses its existing controls in the Generate Report card below — nothing about that workflow has changed.</p>
          ) : (
            <>
              {/* Report-specific configuration */}
              <div className="mb-3 flex flex-wrap items-end gap-3 text-xs">
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
                  <div className="flex flex-wrap gap-2">
                    {["caseHeader", "executiveSummary", "chronology", "diagnoses", "imaging", "procedures", "treatmentHistory", "functionalLimitations", "providerRecommendations", "futureCare", "medicalNecessity", "costProjection", "evidence", "contradictoryEvidence", "missingEvidence", "literature", "physicianReview", "citations"].map((s) => {
                      const sel = Array.isArray(config.sections) && (config.sections as string[]).includes(s);
                      return (
                        <button key={s} onClick={() => set("sections", sel ? (config.sections as string[]).filter((x) => x !== s) : [...((config.sections as string[]) ?? []), s])}
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${sel ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-200 text-slate-500"}`}>
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

              <div className="flex flex-wrap gap-2">
                <button className="btn-outline px-3 py-1.5 text-xs" disabled={busy !== null} onClick={preview}>
                  {busy === "preview" ? "Building preview…" : "Preview"}
                </button>
                {canExport
                  ? selected.formats.map((f) => (
                      <button key={f} className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => exportAs(f)}>
                        {busy === f ? "Exporting…" : `Export ${f}`}
                      </button>
                    ))
                  : <span className="text-xs text-slate-400">Your role cannot export reports.</span>}
              </div>
              {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

              {previewHtml && (
                <div className="mt-3 max-h-[28rem] overflow-auto rounded border border-slate-200 bg-white">
                  <iframe title="Report preview" srcDoc={previewHtml} className="h-[28rem] w-full" sandbox="" />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
