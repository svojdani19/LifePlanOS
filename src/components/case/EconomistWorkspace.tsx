"use client";

// P5 Forensic Economist workspace (docs/23, docs/25) — explicit assumption
// entry + deterministic scenario computation. Styling mirrors
// ReportLibrary.tsx (card / input / btn-* / ink palette).
//
// Core principle surfaced in the UI: NO assumption is ever silently chosen.
// Every row is entered with value + unit + REQUIRED source; editing a key
// creates a new version and supersedes the prior row (history is preserved
// server-side). The compute button refuses (422 with the missing list) until
// every required key is explicitly entered.
//
// Key metadata (dropdown + unit hints) comes from the GET response so this
// client bundle never imports the server-side economics engine.

import { useCallback, useEffect, useState } from "react";

interface KeyDef {
  key: string;
  label: string;
  unitHint: string;
  required: boolean;
}

interface Assumption {
  id: string;
  key: string;
  value: string;
  unit: string;
  source: string;
  effectiveDate: string | null;
  rationale: string | null;
  version: number;
  expertName: string | null;
  createdAt: string;
}

interface StoredResult {
  pastLoss: { nominal: number; withBenefits: number };
  futureLoss: { nominal: number; presentValue: number; withBenefitsPV: number };
  benefits: { rate: number; pastNominal: number; futurePresentValue: number };
  householdServices: { nominal: number; presentValue: number; included: boolean };
  medicalCostPresentValue: number;
  totalPresentValue: number;
  medicalSource?: { exportId: string; reportType: string; presentValue: number } | null;
  medicalNote?: string;
  sensitivity?: { param: string; rows: { value: number; totalPresentValue: number }[] };
}

interface Scenario {
  id: string;
  name: string;
  result: StoredResult | null;
  computedAt: string | null;
}

interface Readiness {
  status: string;
  missing: string[];
}

const STATUS_STYLE: Record<string, string> = {
  "Intake incomplete": "border-amber-200 bg-amber-50 text-amber-800",
  "Expert input required": "border-amber-200 bg-amber-50 text-amber-800",
  "Draft support package available": "border-sky-200 bg-sky-50 text-sky-800",
  "Expert review required": "border-amber-200 bg-amber-50 text-amber-800",
  "Ready for final export": "border-emerald-200 bg-emerald-50 text-emerald-800",
};

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFmt = (n: number) => `${Math.round(n * 10000) / 100}%`;

export default function EconomistWorkspace({ caseId, canEdit }: { caseId: string; canEdit: boolean }) {
  const [keys, setKeys] = useState<KeyDef[]>([]);
  const [assumptions, setAssumptions] = useState<Assumption[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);

  // Entry form (also the supersede-on-edit form).
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [src, setSrc] = useState("");
  const [rationale, setRationale] = useState("");
  const [editingVersion, setEditingVersion] = useState<number | null>(null);

  // Optional low/high scenario overrides (same units as the entered rows).
  const [lowDiscount, setLowDiscount] = useState("");
  const [highDiscount, setHighDiscount] = useState("");
  const [lowGrowth, setLowGrowth] = useState("");
  const [highGrowth, setHighGrowth] = useState("");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/economics`);
    if (!res.ok) return;
    const body = await res.json();
    setKeys(body.keys ?? []);
    setAssumptions(body.assumptions ?? []);
    setScenarios(body.scenarios ?? []);
    setReadiness(body.readiness ?? null);
    setMissing(body.missing ?? []);
  }, [caseId]);
  useEffect(() => {
    void load();
  }, [load]);

  const keyDef = keys.find((k) => k.key === key) ?? null;

  function pickKey(next: string) {
    setKey(next);
    const def = keys.find((k) => k.key === next);
    const existing = assumptions.find((a) => a.key === next);
    // Supersede-on-edit: selecting an already-entered key prefills the current
    // row; saving creates the next version and supersedes this one.
    if (existing) {
      setValue(existing.value);
      setUnit(existing.unit);
      setSrc(existing.source);
      setRationale(existing.rationale ?? "");
      setEditingVersion(existing.version);
    } else {
      setValue("");
      setUnit(def?.unitHint ?? "");
      setSrc("");
      setRationale("");
      setEditingVersion(null);
    }
  }

  function editRow(a: Assumption) {
    pickKey(a.key);
  }

  async function saveAssumption() {
    if (!key || !value.trim() || !unit.trim() || src.trim().length < 3) {
      setError("Key, value, unit, and a source (min 3 characters) are all required — no assumption is defaulted.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/economics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: value.trim(), unit: unit.trim(), source: src.trim(), rationale: rationale.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Save failed");
      else {
        setKey(""); setValue(""); setUnit(""); setSrc(""); setRationale(""); setEditingVersion(null);
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  async function compute() {
    setBusy("compute");
    setError(null);
    try {
      const extra: { name: string; overrides: Record<string, string> }[] = [];
      const low: Record<string, string> = {};
      const high: Record<string, string> = {};
      if (lowDiscount.trim()) low.discount_rate = lowDiscount.trim();
      if (lowGrowth.trim()) low.earnings_growth = lowGrowth.trim();
      if (highDiscount.trim()) high.discount_rate = highDiscount.trim();
      if (highGrowth.trim()) high.earnings_growth = highGrowth.trim();
      if (Object.keys(low).length) extra.push({ name: "low", overrides: low });
      if (Object.keys(high).length) extra.push({ name: "high", overrides: high });
      const res = await fetch(`/api/cases/${caseId}/economics?compute=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarios: extra }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Compute refused");
        if (Array.isArray(body.missing)) setMissing(body.missing);
      } else {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  const base = scenarios.find((s) => s.name === "base" && s.result) ?? null;
  const computedScenarios = scenarios.filter((s) => s.result);

  return (
    <div className="card p-5">
      <div className="mb-1 text-sm font-semibold text-ink-900">Forensic Economist Workspace</div>
      <p className="mb-3 text-xs text-ink-500">
        Every economic assumption is explicitly entered with its value, unit, and source, and is versioned on edit.
        The deterministic engine refuses to run until every required input exists — nothing is ever defaulted.
      </p>

      {/* Readiness banner */}
      {readiness && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${STATUS_STYLE[readiness.status] ?? "border-ink-200 bg-ink-50 text-ink-700"}`}>
          <span className="font-semibold">{readiness.status}</span>
          {readiness.status === "Draft support package available" && " — economist conclusions and report approval are still required for a final report."}
          {missing.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Current assumptions */}
      <div className="mb-4 overflow-x-auto rounded-lg border border-ink-100">
        <table className="w-full text-left text-xs">
          <thead className="bg-ink-50 text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Value</th>
              <th className="px-3 py-2 font-medium">Unit</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Expert</th>
              <th className="px-3 py-2 font-medium">v</th>
              {canEdit && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {assumptions.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 7 : 6} className="px-3 py-3 text-ink-400">
                  No assumptions entered yet.
                </td>
              </tr>
            )}
            {assumptions.map((a) => (
              <tr key={a.id} className="border-t border-ink-100">
                <td className="px-3 py-2 font-medium text-ink-900">{a.key}</td>
                <td className="px-3 py-2">{a.value}</td>
                <td className="px-3 py-2 text-ink-500">{a.unit}</td>
                <td className="max-w-[16rem] truncate px-3 py-2 text-ink-500" title={a.source}>{a.source}</td>
                <td className="px-3 py-2 text-ink-500">{a.expertName ?? "—"}</td>
                <td className="px-3 py-2 text-ink-500">{a.version}</td>
                {canEdit && (
                  <td className="px-3 py-2">
                    <button className="text-brand-700 hover:underline" onClick={() => editRow(a)}>
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Entry form */}
      {canEdit && (
        <div className="mb-4 rounded-lg border border-ink-100 p-3">
          <div className="mb-2 text-xs font-semibold text-ink-900">
            {editingVersion !== null ? `Edit assumption (supersedes v${editingVersion} → v${editingVersion + 1})` : "Enter assumption"}
          </div>
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1">Key
              <select className="input py-1" value={key} onChange={(e) => pickKey(e.target.value)}>
                <option value="">Select…</option>
                {keys.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label} ({k.unitHint}){k.required ? " — required" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">Value
              <input className="input w-28 py-1" value={value} onChange={(e) => setValue(e.target.value)} placeholder={keyDef ? `e.g. in ${keyDef.unitHint}` : ""} />
            </label>
            <label className="flex flex-col gap-1">Unit
              <input className="input w-24 py-1" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={keyDef?.unitHint ?? ""} />
            </label>
            <label className="flex flex-col gap-1">Source (required)
              <input className="input w-72 py-1" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="Publication / table / record citation" />
            </label>
            <label className="flex flex-col gap-1">Rationale (optional)
              <input className="input w-64 py-1" value={rationale} onChange={(e) => setRationale(e.target.value)} />
            </label>
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null || !key} onClick={saveAssumption}>
              {busy === "save" ? "Saving…" : editingVersion !== null ? "Save new version" : "Add assumption"}
            </button>
          </div>
        </div>
      )}

      {/* Compute controls */}
      {canEdit && (
        <div className="mb-4 rounded-lg border border-ink-100 p-3">
          <div className="mb-2 text-xs font-semibold text-ink-900">Scenarios</div>
          <p className="mb-2 text-[11px] text-ink-500">
            Base always uses the entered assumptions. Optional low/high overrides apply to the discount rate and
            earnings growth only, in the same units as entered.
          </p>
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1">Low — discount rate
              <input className="input w-28 py-1" value={lowDiscount} onChange={(e) => setLowDiscount(e.target.value)} /></label>
            <label className="flex flex-col gap-1">Low — earnings growth
              <input className="input w-28 py-1" value={lowGrowth} onChange={(e) => setLowGrowth(e.target.value)} /></label>
            <label className="flex flex-col gap-1">High — discount rate
              <input className="input w-28 py-1" value={highDiscount} onChange={(e) => setHighDiscount(e.target.value)} /></label>
            <label className="flex flex-col gap-1">High — earnings growth
              <input className="input w-28 py-1" value={highGrowth} onChange={(e) => setHighGrowth(e.target.value)} /></label>
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={compute}>
              {busy === "compute" ? "Computing…" : "Compute scenarios"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

      {/* Results */}
      {base?.result && (
        <div className="rounded-lg border border-ink-100 p-3">
          <div className="mb-2 text-xs font-semibold text-ink-900">
            Results{base.computedAt ? ` — computed ${new Date(base.computedAt).toLocaleString()}` : ""}
          </div>
          <div className="mb-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded border border-ink-100 p-2">
              <div className="text-[10px] text-ink-500">Past loss (nominal, w/ benefits)</div>
              <div className="font-semibold text-ink-900">{money(base.result.pastLoss.withBenefits)}</div>
            </div>
            <div className="rounded border border-ink-100 p-2">
              <div className="text-[10px] text-ink-500">Future loss (PV, w/ benefits)</div>
              <div className="font-semibold text-ink-900">{money(base.result.futureLoss.withBenefitsPV)}</div>
            </div>
            <div className="rounded border border-ink-100 p-2">
              <div className="text-[10px] text-ink-500">Household services (PV)</div>
              <div className="font-semibold text-ink-900">
                {base.result.householdServices.included ? money(base.result.householdServices.presentValue) : "Excluded"}
              </div>
            </div>
            <div className="rounded border border-brand-600 p-2">
              <div className="text-[10px] text-ink-500">Total present value</div>
              <div className="font-semibold text-ink-900">{money(base.result.totalPresentValue)}</div>
            </div>
          </div>

          <p className="mb-3 text-[11px] text-ink-500">
            {base.result.medicalSource
              ? `Medical PV ${money(base.result.medicalSource.presentValue)} passed through from finalized export ${base.result.medicalSource.exportId} (${base.result.medicalSource.reportType}).`
              : base.result.medicalNote ?? "Medical-cost component omitted — no finalized LCP/MCP export exists."}
          </p>

          {computedScenarios.length > 1 && (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-ink-500">
                  <tr><th className="py-1 pr-4 font-medium">Scenario</th><th className="py-1 font-medium">Total PV</th></tr>
                </thead>
                <tbody>
                  {computedScenarios.map((s) => (
                    <tr key={s.id} className="border-t border-ink-100">
                      <td className="py-1 pr-4">{s.name}</td>
                      <td className="py-1 font-medium">{money((s.result as StoredResult).totalPresentValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {base.result.sensitivity && base.result.sensitivity.rows.length > 0 && (
            <div className="overflow-x-auto">
              <div className="mb-1 text-[11px] font-medium text-ink-700">Sensitivity — discount rate</div>
              <table className="w-full text-left text-xs">
                <thead className="text-ink-500">
                  <tr><th className="py-1 pr-4 font-medium">Discount rate</th><th className="py-1 font-medium">Total PV</th></tr>
                </thead>
                <tbody>
                  {base.result.sensitivity.rows.map((r) => (
                    <tr key={r.value} className="border-t border-ink-100">
                      <td className="py-1 pr-4">{pctFmt(r.value)}</td>
                      <td className="py-1">{money(r.totalPresentValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
