"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function FirmSettingsForm({
  initial,
}: {
  initial: { name: string; state: string; primaryColor: string; letterhead: string; logoUrl: string };
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/firm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not save");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="card max-w-2xl space-y-5 p-6">
      <div>
        <label className="label">Firm name</label>
        <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">State</label>
          <input className="input" value={form.state} onChange={(e) => set("state", e.target.value)} />
        </div>
        <div>
          <label className="label">Brand color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              className="h-10 w-12 rounded border border-ink-300"
              value={form.primaryColor || "#0891b2"}
              onChange={(e) => set("primaryColor", e.target.value)}
            />
            <input className="input" value={form.primaryColor} onChange={(e) => set("primaryColor", e.target.value)} />
          </div>
        </div>
      </div>
      <div>
        <label className="label">Logo URL</label>
        <input className="input" value={form.logoUrl} onChange={(e) => set("logoUrl", e.target.value)} placeholder="https://…" />
      </div>
      <div>
        <label className="label">Report letterhead</label>
        <textarea
          className="input min-h-[90px]"
          value={form.letterhead}
          onChange={(e) => set("letterhead", e.target.value)}
          placeholder="Appears at the top of firm-branded reports"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
      </div>
    </form>
  );
}
