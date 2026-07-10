"use client";

import { useMemo, useState } from "react";
import { Search, Upload, Loader2, FileText, ExternalLink, X, Plus } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

type Precedent = Record<string, any>;

const SPECIALTIES = [
  "GENERAL", "ORTHOPEDIC_TRAUMA", "HIP_ARTHROPLASTY", "KNEE_ARTHROPLASTY", "SPINE", "AMPUTATION", "TBI",
  "SPINAL_CORD_INJURY", "CHRONIC_PAIN", "CRPS", "BURNS", "BIRTH_INJURY", "NEUROLOGIC", "PSYCHIATRIC", "POLYTRAUMA",
];
const specLabel = (s?: string | null) => (s || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

export function LibraryManager({ initial, canManage }: { initial: Precedent[]; canManage: boolean }) {
  const [list, setList] = useState<Precedent[]>(initial);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  async function refresh() {
    const r = await fetch("/api/precedents");
    if (r.ok) setList((await r.json()).precedents ?? []);
  }
  async function addSample() {
    setBusy("sample");
    await fetch("/api/precedents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sample: true }) });
    await refresh();
    setBusy(null);
  }
  async function remove(id: string, title: string) {
    if (!confirm(`Remove "${title}" from the library?`)) return;
    await fetch(`/api/precedents/${id}`, { method: "DELETE" });
    setList((l) => l.filter((p) => p.id !== id));
  }

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return list;
    return list.filter((p) =>
      ["title", "diagnosis", "icd10Code", "jurisdiction", "mechanism", "clientRef", "outcome", "extractedText", "injurySpecialty"]
        .some((f) => String(p[f] ?? "").toLowerCase().includes(q)),
    );
  }, [list, q]);

  return (
    <div className="space-y-4">
      {/* Search + actions */}
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search by diagnosis, ICD-10, jurisdiction, mechanism, text…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {canManage && (
          <>
            <button className="btn-outline shrink-0" onClick={() => setShowUpload((s) => !s)}><Upload className="h-4 w-4" /> Upload LCP</button>
            <button className="btn-ghost shrink-0" disabled={busy === "sample"} onClick={addSample}>
              {busy === "sample" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Add Sample Library
            </button>
          </>
        )}
      </div>

      {canManage && showUpload && <UploadForm onDone={async () => { setShowUpload(false); await refresh(); }} />}

      <p className="text-xs text-ink-500">{filtered.length} of {list.length} plan{list.length === 1 ? "" : "s"}{q ? ` matching “${query}”` : ""}</p>

      {filtered.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-400">
          {list.length === 0 ? "No finalized LCPs in the library yet. Upload one or add the sample library to begin." : "No plans match your search."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">{p.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {p.injurySpecialty && <Badge tone="brand">{specLabel(p.injurySpecialty)}</Badge>}
                    {p.icd10Code && <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">{p.icd10Code}</span>}
                    {p.jurisdiction && <span className="text-xs text-ink-500">{p.jurisdiction}</span>}
                  </div>
                  {p.diagnosis && <p className="mt-1 text-xs text-ink-600">{p.diagnosis}{p.mechanism ? ` · ${p.mechanism.toLowerCase()}` : ""}</p>}
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-500">
                    {p.age != null && <span>age {p.age}</span>}
                    {p.presentValue != null && <span>PV {formatMoney(p.presentValue)}</span>}
                    {p.lifetimeCost != null && <span>lifetime {formatMoney(p.lifetimeCost)}</span>}
                    {p.outcome && <span className="italic">{p.outcome}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <a href={`/api/precedents/${p.id}/view`} target="_blank" rel="noopener noreferrer" title="Open" className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-brand-700"><ExternalLink className="h-4 w-4" /></a>
                  {canManage && <button title="Remove" onClick={() => remove(p.id, p.title)} className="rounded-md p-1.5 text-ink-300 hover:bg-ink-100 hover:text-red-600"><X className="h-4 w-4" /></button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState<Record<string, string>>({ title: "", diagnosis: "", icd10Code: "", injurySpecialty: "", jurisdiction: "", mechanism: "", age: "", presentValue: "", lifetimeCost: "", careCategories: "", outcome: "", clientRef: "" });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    setSaving(true);
    const fd = new FormData();
    if (file) fd.append("file", file);
    Object.entries(f).forEach(([k, v]) => v.trim() && fd.append(k, v.trim()));
    const r = await fetch("/api/precedents", { method: "POST", body: fd });
    setSaving(false);
    if (r.ok) onDone();
    else alert("Upload failed");
  }

  return (
    <div className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-ink-900">Add a finalized LCP</h3>
      <label className="btn-outline w-fit cursor-pointer">
        <Upload className="h-4 w-4" /> {file ? file.name : "Choose file (PDF / DOCX)"}
        <input type="file" className="hidden" accept=".pdf,.docx,.doc,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Fld label="Title"><input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="De-identified label" /></Fld>
        <Fld label="Client / matter ref"><input className="input" value={f.clientRef} onChange={(e) => set("clientRef", e.target.value)} /></Fld>
        <Fld label="Diagnosis"><input className="input" value={f.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} /></Fld>
        <Fld label="ICD-10"><input className="input" value={f.icd10Code} onChange={(e) => set("icd10Code", e.target.value)} /></Fld>
        <Fld label="Injury specialty">
          <select className="input" value={f.injurySpecialty} onChange={(e) => set("injurySpecialty", e.target.value)}>
            <option value="">—</option>
            {SPECIALTIES.map((s) => <option key={s} value={s}>{specLabel(s)}</option>)}
          </select>
        </Fld>
        <Fld label="Jurisdiction"><input className="input" value={f.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} placeholder="e.g. CA — Orange County" /></Fld>
        <Fld label="Mechanism"><input className="input" value={f.mechanism} onChange={(e) => set("mechanism", e.target.value)} /></Fld>
        <Fld label="Age"><input className="input" type="number" value={f.age} onChange={(e) => set("age", e.target.value)} /></Fld>
        <Fld label="Present value ($)"><input className="input" type="number" value={f.presentValue} onChange={(e) => set("presentValue", e.target.value)} /></Fld>
        <Fld label="Lifetime cost ($)"><input className="input" type="number" value={f.lifetimeCost} onChange={(e) => set("lifetimeCost", e.target.value)} /></Fld>
        <Fld label="Care categories (comma-separated)"><input className="input" value={f.careCategories} onChange={(e) => set("careCategories", e.target.value)} placeholder="PHYSICIAN_VISIT, PHYSICAL_THERAPY, …" /></Fld>
        <Fld label="Outcome / note"><input className="input" value={f.outcome} onChange={(e) => set("outcome", e.target.value)} /></Fld>
      </div>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? "Saving…" : <><Plus className="h-4 w-4" /> Add to Library</>}</button>
        <button className="btn-outline" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="label">{label}</label>{children}</div>;
}
