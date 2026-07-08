"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";

const CASE_TYPES = [
  ["PERSONAL_INJURY", "Personal injury"],
  ["MED_MAL", "Medical malpractice"],
  ["WORKERS_COMP", "Workers' comp"],
  ["PRODUCT_LIABILITY", "Product liability"],
  ["CATASTROPHIC", "Catastrophic injury"],
] as const;

const SIDES = [
  ["PLAINTIFF", "Plaintiff"],
  ["DEFENSE", "Defense"],
  ["NEUTRAL", "Neutral"],
] as const;

export function NewCaseForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    clientName: "",
    caseType: "PERSONAL_INJURY",
    side: "PLAINTIFF",
    jurisdiction: "",
    mechanism: "",
    diagnosis: "",
  });

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create case");
      return;
    }
    setOpen(false);
    setForm({ clientName: "", caseType: "PERSONAL_INJURY", side: "PLAINTIFF", jurisdiction: "", mechanism: "", diagnosis: "" });
    router.refresh();
  }

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New case
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onClick={() => setOpen(false)}>
      <div className="card w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900">New case intake</h2>
          <button onClick={() => setOpen(false)} className="rounded-md p-1 text-ink-400 hover:bg-ink-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <div>
            <label className="label">Plaintiff / patient name</label>
            <input className="input" required value={form.clientName} onChange={(e) => set("clientName", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Case type</label>
              <select className="input" value={form.caseType} onChange={(e) => set("caseType", e.target.value)}>
                {CASE_TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Retained by</label>
              <select className="input" value={form.side} onChange={(e) => set("side", e.target.value)}>
                {SIDES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Jurisdiction</label>
            <input className="input" value={form.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} placeholder="e.g. CA — Los Angeles County" />
          </div>
          <div>
            <label className="label">Mechanism of injury</label>
            <input className="input" value={form.mechanism} onChange={(e) => set("mechanism", e.target.value)} placeholder="e.g. MVC, fall, surgical complication" />
          </div>
          <div>
            <label className="label">Primary diagnosis</label>
            <input className="input" value={form.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-outline" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={loading}>
              {loading ? "Creating…" : "Create case"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
