"use client";

// Vocational Assessment workspace (docs/23 P4) — compact intake panel over the
// /api/cases/[caseId]/vocational API. Entries are grouped by kind; edits are
// supersede-not-edit (a save creates a replacement row); verification is a
// reviewer act gated by `canReview`. The readiness banner mirrors the pure
// vocationalReadiness ladder so the user always sees what is missing.

import { useCallback, useEffect, useState } from "react";
import { VOC_KINDS, KIND_LABELS, type VocKind } from "@/lib/reports/vocational";

interface Entry {
  id: string;
  kind: string;
  title: string;
  detail: Record<string, unknown> | null;
  startDate: string | null;
  endDate: string | null;
  source: string;
  verification: string;
  notes: string | null;
}

interface Readiness {
  status: string;
  missing: string[];
}

const STATUS_STYLE: Record<string, string> = {
  "Intake incomplete": "bg-slate-100 text-slate-700",
  "Expert input required": "bg-amber-100 text-amber-800",
  "Draft support package available": "bg-sky-100 text-sky-800",
  "Expert review required": "bg-amber-100 text-amber-800",
  "Ready for final export": "bg-emerald-100 text-emerald-800",
};

interface FormState {
  kind: VocKind;
  title: string;
  source: string;
  startDate: string;
  endDate: string;
  notes: string;
}

const EMPTY_FORM: FormState = { kind: "employment", title: "", source: "", startDate: "", endDate: "", notes: "" };

export default function VocationalWorkspace({ caseId, canEdit, canReview }: { caseId: string; canEdit: boolean; canReview: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/vocational`);
    if (res.ok) {
      const body = await res.json();
      setEntries(body.entries ?? []);
      setReadiness(body.readiness ?? null);
    }
  }, [caseId]);
  useEffect(() => { void load(); }, [load]);

  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function startEdit(e: Entry) {
    setEditingId(e.id);
    setForm({
      kind: (VOC_KINDS.includes(e.kind as VocKind) ? e.kind : "employment") as VocKind,
      title: e.title,
      source: e.source,
      startDate: e.startDate ? e.startDate.slice(0, 10) : "",
      endDate: e.endDate ? e.endDate.slice(0, 10) : "",
      notes: e.notes ?? "",
    });
  }

  async function save() {
    if (!form.title.trim() || form.source.trim().length < 3) {
      setError("A title and a source citation (min 3 characters) are required — no entry without its source.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const payload: Record<string, unknown> = {
        kind: form.kind,
        title: form.title.trim(),
        source: form.source.trim(),
        ...(form.startDate ? { startDate: form.startDate } : {}),
        ...(form.endDate ? { endDate: form.endDate } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      };
      const res = await fetch(
        editingId ? `/api/cases/${caseId}/vocational?id=${editingId}` : `/api/cases/${caseId}/vocational`,
        { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      );
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Save failed");
      else {
        setForm(EMPTY_FORM);
        setEditingId(null);
        void load();
      }
    } finally { setBusy(false); }
  }

  async function setVerification(e: Entry, verification: string) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/vocational?id=${e.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Verification update failed");
      else void load();
    } finally { setBusy(false); }
  }

  const kindsPresent = VOC_KINDS.filter((k) => entries.some((e) => e.kind === k));

  return (
    <div className="card p-5">
      <div className="mb-1 text-sm font-semibold text-ink-900">Vocational Assessment — Structured Intake</div>
      <p className="mb-3 text-xs text-ink-500">
        Every entry cites its source; edits create a replacement (full revision history); vocational conclusions belong to the vocational expert alone.
      </p>

      {/* Readiness banner */}
      {readiness && (
        <div className="mb-4 rounded-lg border border-ink-100 p-3">
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[readiness.status] ?? "bg-slate-100 text-slate-700"}`}>
            {readiness.status}
          </span>
          {readiness.missing.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-ink-500">
              {readiness.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Add / supersede form */}
      {canEdit && (
        <div className="mb-4 rounded-lg border border-ink-100 p-3">
          <div className="mb-2 text-xs font-semibold text-ink-900">{editingId ? "Supersede entry (saves a replacement; the original is preserved)" : "Add entry"}</div>
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1">Kind
              <select className="input py-1" value={form.kind} onChange={(e) => set("kind", e.target.value)}>
                {VOC_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">Title
              <input className="input py-1 w-56" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Warehouse supervisor, ACME Logistics" />
            </label>
            <label className="flex flex-col gap-1">Start
              <input type="date" className="input py-1" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">End
              <input type="date" className="input py-1" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1 grow">Source <span className="text-[10px] font-normal text-ink-400">(required — cite the record, interview, or publication)</span>
              <input className="input py-1" value={form.source} onChange={(e) => set("source", e.target.value)} placeholder="e.g. Employment_Records_2022.pdf p. 4; client interview 03/2026" />
            </label>
            <label className="flex flex-col gap-1 grow">Notes
              <input className="input py-1" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={save}>
              {busy ? "Saving…" : editingId ? "Save replacement" : "Add entry"}
            </button>
            {editingId && (
              <button className="btn-outline px-3 py-1.5 text-xs" disabled={busy} onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }}>
                Cancel
              </button>
            )}
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      )}

      {/* Entries grouped by kind */}
      {kindsPresent.length === 0 ? (
        <p className="text-xs text-ink-400">No vocational entries yet.</p>
      ) : (
        <div className="space-y-3">
          {kindsPresent.map((k) => (
            <div key={k}>
              <div className="mb-1 text-xs font-semibold text-ink-900">{KIND_LABELS[k]}</div>
              <ul className="space-y-1.5">
                {entries.filter((e) => e.kind === k).map((e) => (
                  <li key={e.id} className="rounded border border-ink-100 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-900">{e.title}</span>
                      <span className={`rounded px-1 py-0.5 text-[10px] ${e.verification === "VERIFIED" ? "bg-emerald-100 text-emerald-800" : e.verification === "DISPUTED" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
                        {e.verification}
                      </span>
                      {(e.startDate || e.endDate) && (
                        <span className="text-[10px] text-ink-400">
                          {e.startDate ? e.startDate.slice(0, 10) : "…"} – {e.endDate ? e.endDate.slice(0, 10) : "present"}
                        </span>
                      )}
                      <span className="ml-auto flex gap-1.5">
                        {canEdit && (
                          <button className="btn-outline px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => startEdit(e)}>Supersede</button>
                        )}
                        {canReview && e.verification !== "VERIFIED" && (
                          <button className="btn-outline px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => void setVerification(e, "VERIFIED")}>Mark verified</button>
                        )}
                        {canReview && e.verification === "VERIFIED" && (
                          <button className="btn-outline px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => void setVerification(e, "UNVERIFIED")}>Un-verify</button>
                        )}
                      </span>
                    </div>
                    {e.notes && <p className="mt-1 text-ink-500">{e.notes}</p>}
                    <p className="mt-1 text-[10px] italic text-ink-400">Source: {e.source}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
