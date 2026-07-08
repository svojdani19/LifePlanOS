"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Upload,
  FileText,
  Activity,
  GitBranch,
  Stethoscope,
  Calculator,
  ShieldAlert,
  ClipboardCheck,
  FileOutput,
  Loader2,
  Check,
  X,
  Pencil,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatMoney, formatDate, cn } from "@/lib/utils";
import type { Permission } from "@/lib/rbac";
import { DOC_TYPE_GROUPS, TYPE_LABEL, TYPE_GROUP } from "@/lib/documents/taxonomy";

// Loosely-typed serialized case (dates are ISO strings after JSON round-trip).
type AnyRec = Record<string, any>;

const STAGES = ["INTAKE", "RECORDS", "CHRONOLOGY", "CAUSATION", "FUTURE_CARE", "PRICING", "PHYSICIAN_REVIEW", "FINAL"];

const PROB_TONE: Record<string, "green" | "brand" | "amber" | "red"> = {
  PROBABLE: "green",
  POSSIBLE: "brand",
  SPECULATIVE: "amber",
  NOT_SUPPORTED: "red",
};
const VULN_TONE: Record<string, "green" | "amber" | "red"> = { LOW: "green", MODERATE: "amber", HIGH: "red" };
const PHYS_TONE: Record<string, "neutral" | "green" | "red" | "amber"> = { PENDING: "neutral", APPROVED: "green", REJECTED: "red", MODIFIED: "amber" };

export function CaseWorkspace({
  data,
  assumptions,
  totals,
  permissions,
}: {
  data: AnyRec;
  assumptions: { lifeExpectancyYears: number; discountRate: number; medicalInflation: number; geographicFactor: number };
  totals: { totalLifetime: number; totalPresentValue: number };
  permissions: Permission[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const can = (p: Permission) => permissions.includes(p);

  async function call(url: string, method: string, body?: unknown, tag = "op") {
    setBusy(tag);
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    setBusy(null);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(e.error ?? "Request failed");
      return null;
    }
    router.refresh();
    return res.json().catch(() => ({}));
  }

  const hasPlan = data.futureCareItems.length > 0;
  const pendingPhysician = data.futureCareItems.filter((i: AnyRec) => i.physicianStatus === "PENDING").length;
  const defense = data.reviewFindings.filter((f: AnyRec) => f.kind === "DEFENSE");
  const completeness = data.reviewFindings.filter((f: AnyRec) => f.kind === "COMPLETENESS");

  const TABS = [
    { id: "overview", label: "Intake", icon: FileText },
    { id: "records", label: `Records (${data.documents.length})`, icon: Upload },
    { id: "chronology", label: `Chronology (${data.chronologyEvents.length})`, icon: Activity },
    { id: "causation", label: "Causation", icon: GitBranch },
    { id: "futurecare", label: `Future Care (${data.futureCareItems.length})`, icon: Stethoscope },
    { id: "costs", label: "Costs", icon: Calculator },
    { id: "reviews", label: `Reviews (${data.reviewFindings.length})`, icon: ShieldAlert },
    { id: "physician", label: `Physician (${pendingPhysician})`, icon: ClipboardCheck },
    { id: "report", label: "Report", icon: FileOutput },
  ];

  return (
    <div>
      {/* Header */}
      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-ink-900">{data.clientName}</h1>
              <Badge tone="neutral">{data.caseNumber}</Badge>
              <Badge tone={data.side === "PLAINTIFF" ? "brand" : data.side === "DEFENSE" ? "amber" : "slate"}>{data.side.toLowerCase()}</Badge>
            </div>
            <p className="mt-1 text-sm text-ink-600">
              {data.caseType.replace(/_/g, " ").toLowerCase()} · {data.diagnosis || "no diagnosis set"} · {data.jurisdiction || "no jurisdiction"}
            </p>
          </div>
          {can("futurecare.edit") && (
            <button className="btn-primary" disabled={busy === "gen"} onClick={() => call(`/api/cases/${data.id}/generate`, "POST", undefined, "gen")}>
              {busy === "gen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {hasPlan ? "Re-run AI pipeline" : "Run AI pipeline"}
            </button>
          )}
        </div>

        {/* Progress tracker */}
        <div className="mt-5 flex flex-wrap items-center gap-1.5">
          {STAGES.map((s, i) => {
            const reached = STAGES.indexOf(data.status) >= i;
            return (
              <div key={s} className="flex items-center gap-1.5">
                <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", reached ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-400")}>
                  {s.replace(/_/g, " ").toLowerCase()}
                </span>
                {i < STAGES.length - 1 && <span className="text-ink-300">›</span>}
              </div>
            );
          })}
        </div>

        {/* Quick totals */}
        {hasPlan && (
          <div className="mt-5 grid gap-3 sm:grid-cols-4">
            <Stat label="Future care items" value={String(data.futureCareItems.length)} />
            <Stat label="Lifetime (undiscounted)" value={formatMoney(totals.totalLifetime)} />
            <Stat label="Present value" value={formatMoney(totals.totalPresentValue)} highlight />
            <Stat label="Physician pending" value={String(pendingPhysician)} />
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-5 flex flex-wrap gap-1 border-b border-ink-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t.id ? "border-brand-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-800",
            )}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === "overview" && <IntakePanel data={data} canEdit={can("case.edit")} call={call} />}
        {tab === "records" && <RecordsPanel data={data} canEdit={can("records.upload")} call={call} busy={busy} />}
        {tab === "chronology" && <ChronologyPanel data={data} canEdit={can("chronology.edit")} call={call} />}
        {tab === "causation" && <CausationPanel data={data} />}
        {tab === "futurecare" && <FutureCarePanel data={data} canEdit={can("futurecare.edit")} call={call} />}
        {tab === "costs" && <CostsPanel data={data} assumptions={assumptions} totals={totals} canEdit={can("case.edit")} call={call} />}
        {tab === "reviews" && <ReviewsPanel defense={defense} completeness={completeness} hasPlan={hasPlan} />}
        {tab === "physician" && <PhysicianPanel data={data} canReview={can("physician.review")} call={call} />}
        {tab === "report" && <ReportPanel data={data} canExport={can("report.export")} call={call} busy={busy} totals={totals} />}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn("rounded-lg border p-3", highlight ? "border-brand-200 bg-brand-50" : "border-ink-200 bg-white")}>
      <p className="text-xs text-ink-500">{label}</p>
      <p className={cn("mt-0.5 text-lg font-bold", highlight ? "text-brand-800" : "text-ink-900")}>{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card p-10 text-center text-sm text-ink-500">{children}</div>;
}

// ── Intake ───────────────────────────────────────────────────────────────────
const SPECIALTIES = ["GENERAL", "ORTHOPEDIC_TRAUMA", "HIP_ARTHROPLASTY", "KNEE_ARTHROPLASTY", "SPINE", "AMPUTATION", "TBI", "SPINAL_CORD_INJURY", "CHRONIC_PAIN", "CRPS", "BURNS", "BIRTH_INJURY", "NEUROLOGIC", "PSYCHIATRIC", "POLYTRAUMA"];

function IntakePanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [form, setForm] = useState({
    diagnosis: data.diagnosis ?? "",
    mechanism: data.mechanism ?? "",
    jurisdiction: data.jurisdiction ?? "",
    injurySpecialty: data.injurySpecialty ?? "GENERAL",
    preExistingConditions: data.preExistingConditions ?? "",
    currentWorkStatus: data.currentWorkStatus ?? "",
    functionalLimitations: data.functionalLimitations ?? "",
  });
  const [saved, setSaved] = useState(false);
  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  return (
    <div className="card max-w-3xl p-6">
      <h3 className="text-sm font-semibold text-ink-900">Case intake</h3>
      <p className="mt-1 text-xs text-ink-500">The injury specialty drives the specialty-specific recommendation rules used by the AI pipeline.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Primary diagnosis"><input className="input" disabled={!canEdit} value={form.diagnosis} onChange={(e) => set("diagnosis", e.target.value)} /></Field>
        <Field label="Injury specialty">
          <select className="input" disabled={!canEdit} value={form.injurySpecialty} onChange={(e) => set("injurySpecialty", e.target.value)}>
            {SPECIALTIES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Mechanism of injury"><input className="input" disabled={!canEdit} value={form.mechanism} onChange={(e) => set("mechanism", e.target.value)} /></Field>
        <Field label="Jurisdiction"><input className="input" disabled={!canEdit} value={form.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} /></Field>
        <Field label="Pre-existing conditions"><input className="input" disabled={!canEdit} value={form.preExistingConditions} onChange={(e) => set("preExistingConditions", e.target.value)} /></Field>
        <Field label="Current work status"><input className="input" disabled={!canEdit} value={form.currentWorkStatus} onChange={(e) => set("currentWorkStatus", e.target.value)} /></Field>
        <Field label="Functional limitations" wide><textarea className="input min-h-[70px]" disabled={!canEdit} value={form.functionalLimitations} onChange={(e) => set("functionalLimitations", e.target.value)} /></Field>
      </div>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <button className="btn-primary" onClick={async () => { const r = await call(`/api/cases/${data.id}`, "PATCH", form, "intake"); if (r) setSaved(true); }}>Save intake</button>
          {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <div className={wide ? "sm:col-span-2" : ""}><label className="label">{label}</label>{children}</div>;
}

// ── Records ──────────────────────────────────────────────────────────────────
// A varied sample set so the auto-classifier lands documents across many groups.
const SAMPLE_RECORDS = [
  "ED_Admission_Note.pdf",
  "Operative_Report_ORIF.pdf",
  "MRI_Lumbar_Spine.pdf",
  "PT_Progress_Notes.pdf",
  "Billing_Ledger.xlsx",
  "Ortho_Followup_Clinic_Note.pdf",
  "Pharmacy_Printout.pdf",
  "Deposition_Summary_Smith.pdf",
  "IME_Report_Defense.pdf",
  "Neuropsych_Evaluation.pdf",
  "Scanned_Unknown_Document.pdf",
];

function RecordsPanel({ data, canEdit, call, busy }: { data: AnyRec; canEdit: boolean; call: any; busy: string | null }) {
  const [filter, setFilter] = useState<string>("All");
  const [editingId, setEditingId] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    const res = await fetch(`/api/cases/${data.id}/documents`, { method: "POST", body: fd });
    if (res.ok) location.reload();
    else alert("Upload failed");
  }

  const docs: AnyRec[] = data.documents;

  // Count per group; only surface filter chips for groups that have documents.
  const groupCounts: Record<string, number> = {};
  docs.forEach((d) => {
    const g = TYPE_GROUP[d.type] ?? "Other";
    groupCounts[g] = (groupCounts[g] ?? 0) + 1;
  });
  const activeGroups = DOC_TYPE_GROUPS.filter((g) => groupCounts[g.label] > 0);
  const filtered = filter === "All" ? docs : docs.filter((d) => (TYPE_GROUP[d.type] ?? "Other") === filter);

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <label className="btn-outline cursor-pointer">
            <Upload className="h-4 w-4" /> Upload records
            <input type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          </label>
          <button className="btn-ghost" disabled={busy === "sample"} onClick={() => call(`/api/cases/${data.id}/documents`, "POST", { filenames: SAMPLE_RECORDS }, "sample")}>
            {busy === "sample" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Add sample record set
          </button>
          <span className="text-xs text-ink-500">
            Upload unlabeled documents — each is auto-classified on ingest. Click a label to reassign it.
          </span>
        </div>
      )}

      {docs.length === 0 ? (
        <Empty>No records yet. Upload files or add the sample record set to begin.</Empty>
      ) : (
        <>
          {/* Filter chips — one per document group present, plus All. */}
          <div className="flex flex-wrap gap-2">
            <FilterChip label="All" count={docs.length} active={filter === "All"} onClick={() => setFilter("All")} />
            {activeGroups.map((g) => (
              <FilterChip key={g.label} label={g.label} count={groupCounts[g.label]} active={filter === g.label} onClick={() => setFilter(g.label)} />
            ))}
          </div>

          <div className="card overflow-hidden">
            <div className="divide-y divide-ink-100">
              {filtered.map((d) => (
                <div key={d.id} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50/60">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-100 text-[10px] font-bold uppercase text-ink-400">
                    {d.filename.split(".").pop()?.slice(0, 4) ?? "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{d.filename}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      {editingId === d.id ? (
                        <select
                          autoFocus
                          defaultValue={d.type}
                          className="rounded-md border border-ink-300 bg-white px-2 py-0.5 text-xs"
                          onBlur={() => setEditingId(null)}
                          onChange={async (e) => {
                            setEditingId(null);
                            await call(`/api/cases/${data.id}/documents/${d.id}`, "PATCH", { type: e.target.value });
                          }}
                        >
                          {DOC_TYPE_GROUPS.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                              {g.types.map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      ) : canEdit ? (
                        <button onClick={() => setEditingId(d.id)} title="Click to change label" className="inline-flex items-center gap-1 hover:opacity-80">
                          <Badge tone="brand">{TYPE_LABEL[d.type] ?? d.type.replace(/_/g, " ")}</Badge>
                          <Pencil className="h-3 w-3 text-ink-400" />
                        </button>
                      ) : (
                        <Badge tone="brand">{TYPE_LABEL[d.type] ?? d.type.replace(/_/g, " ")}</Badge>
                      )}
                      <span className="text-xs text-ink-400">{d.pageCount ? `${d.pageCount}p` : ""}</span>
                      {d.ocrConfidence != null && (
                        <Badge tone={d.ocrConfidence < 0.75 ? "red" : "green"}>OCR {Math.round(d.ocrConfidence * 100)}%</Badge>
                      )}
                      {d.flags && <span className="text-xs text-amber-700">{d.flags}</span>}
                    </div>
                  </div>
                  {canEdit && (
                    <button className="text-ink-300 hover:text-red-600" title="Remove" onClick={async () => { if (confirm(`Remove ${d.filename}?`)) await call(`/api/cases/${data.id}/documents/${d.id}`, "DELETE"); }}>
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              {filtered.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-400">No documents in this category.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200",
      )}
    >
      {label}
      <span className={cn("rounded-full px-1.5 text-[10px] font-semibold", active ? "bg-white/20" : "bg-white text-ink-500")}>{count}</span>
    </button>
  );
}

// ── Chronology ───────────────────────────────────────────────────────────────
function ChronologyPanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (data.chronologyEvents.length === 0) return <Empty>Run the AI pipeline to build the medical chronology from ingested records.</Empty>;
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Provider</th><th className="px-4 py-2 font-medium">Event</th><th className="px-4 py-2 font-medium">Rel.</th><th className="px-4 py-2 font-medium">Source</th>{canEdit && <th />}</tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {data.chronologyEvents.map((e: AnyRec) => (
            <tr key={e.id} className="align-top">
              <td className="px-4 py-2 whitespace-nowrap text-ink-600">{formatDate(e.eventDate)}</td>
              <td className="px-4 py-2 text-ink-700">{e.provider}<div className="text-xs text-ink-400">{e.specialty}</div></td>
              <td className="px-4 py-2 text-ink-800">
                {editing === e.id ? (
                  <div className="flex gap-2">
                    <input className="input py-1" value={draft} onChange={(ev) => setDraft(ev.target.value)} />
                    <button className="text-emerald-600" onClick={async () => { await call(`/api/cases/${data.id}/chronology/${e.id}`, "PATCH", { summary: draft }); setEditing(null); }}><Check className="h-4 w-4" /></button>
                    <button className="text-ink-400" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <div>{e.summary} {e.edited && <Badge tone="amber">edited</Badge>}<div className="text-xs text-ink-400">{e.diagnosis || e.treatment || ""}</div></div>
                )}
              </td>
              <td className="px-4 py-2"><Badge tone="brand">{e.relevanceScore}</Badge></td>
              <td className="px-4 py-2 text-xs text-ink-400">{e.sourcePage ? `p.${e.sourcePage}` : "—"}</td>
              {canEdit && <td className="px-4 py-2"><button className="text-ink-400 hover:text-ink-700" onClick={() => { setEditing(e.id); setDraft(e.summary); }}><Pencil className="h-3.5 w-3.5" /></button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Causation ────────────────────────────────────────────────────────────────
const REL_TONE: Record<string, "green" | "amber" | "neutral" | "red"> = { RELATED: "green", AGGRAVATION: "amber", PREEXISTING_UNRELATED: "neutral", SUBSEQUENT_UNRELATED: "neutral", UNCLEAR: "red" };
function CausationPanel({ data }: { data: AnyRec }) {
  if (data.conditions.length === 0) return <Empty>Run the AI pipeline to build the causation & apportionment map.</Empty>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data.conditions.map((c: AnyRec) => (
        <div key={c.id} className="card p-5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-ink-900">{c.name}</h3>
            <Badge tone={REL_TONE[c.relatedness]}>{c.relatedness.replace(/_/g, " ").toLowerCase()}</Badge>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-ink-500">
            <span>Confidence</span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-100"><div className="h-full bg-brand-500" style={{ width: `${c.confidence}%` }} /></div>
            <span>{c.confidence}%</span>
            {c.physicianConfirmed && <Badge tone="green">MD confirmed</Badge>}
          </div>
          <p className="mt-3 text-sm text-ink-700">{c.reasoning}</p>
          {c.objectiveEvidence && <p className="mt-2 text-xs text-ink-500"><span className="font-medium">Objective evidence:</span> {c.objectiveEvidence}</p>}
          {c.missingInfo && <p className="mt-1 text-xs text-amber-700"><span className="font-medium">Missing:</span> {c.missingInfo}</p>}
        </div>
      ))}
    </div>
  );
}

// ── Future care ──────────────────────────────────────────────────────────────
function FutureCarePanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [open, setOpen] = useState<string | null>(null);
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline to generate future care recommendations.</Empty>;
  return (
    <div className="space-y-2">
      {data.futureCareItems.map((it: AnyRec) => (
        <div key={it.id} className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink-900">{it.service}</span>
                <Badge tone={PROB_TONE[it.probability]}>{it.probability.toLowerCase()}</Badge>
                <Badge tone={VULN_TONE[it.defenseVulnerability]}>{it.defenseVulnerability.toLowerCase()} vuln</Badge>
                <Badge tone={PHYS_TONE[it.physicianStatus]}>MD: {it.physicianStatus.toLowerCase()}</Badge>
                {it.edited && <Badge tone="amber">edited</Badge>}
              </div>
              <p className="mt-1 text-xs text-ink-500">{it.category.replace(/_/g, " ").toLowerCase()} · {it.specialty} · {it.cptCode || "no CPT"} · {it.frequencyPerYear}/yr {it.isLifetime ? "for life" : it.durationYears ? `× ${it.durationYears}y` : ""}</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-sm font-bold text-brand-800">{formatMoney(it.presentValue)}</div>
                <div className="text-xs text-ink-400">PV · {formatMoney(it.lifetimeCost)} lifetime</div>
              </div>
              <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? "Hide" : "Details"}</button>
            </div>
          </div>
          {open === it.id && (
            <div className="mt-3 grid gap-3 border-t border-ink-100 pt-3 text-sm md:grid-cols-2">
              <div><p className="text-xs font-medium text-ink-500">Medical necessity</p><p className="text-ink-700">{it.rationale}</p></div>
              <div><p className="text-xs font-medium text-ink-500">Evidence</p><p className="text-ink-700">{it.evidenceStrength} — {it.literatureSupport}</p></div>
              {it.lowerCostAlternative && <div><p className="text-xs font-medium text-ink-500">Lower-cost alternative</p><p className="text-ink-700">{it.lowerCostAlternative}</p></div>}
              {it.missingSupport && <div><p className="text-xs font-medium text-amber-700">Missing support</p><p className="text-amber-700">{it.missingSupport}</p></div>}
              <div><p className="text-xs font-medium text-ink-500">Cost basis</p><p className="text-ink-700">{formatMoney(it.unitCost)}/unit · {it.pricingSource} · range {formatMoney(it.lowCost)}–{formatMoney(it.highCost)}</p></div>
              {it.physicianNote && <div><p className="text-xs font-medium text-ink-500">Physician note</p><p className="text-ink-700">{it.physicianNote}</p></div>}
              {canEdit && (
                <div className="md:col-span-2 flex flex-wrap gap-2 pt-1">
                  <InlineProbability item={it} caseId={data.id} call={call} />
                  <button className="btn-outline py-1 text-xs" onClick={async () => { const v = prompt("Frequency per year", String(it.frequencyPerYear)); if (v != null) await call(`/api/cases/${data.id}/future-care/${it.id}`, "PATCH", { frequencyPerYear: Number(v) }); }}>Edit frequency</button>
                  <button className="btn-outline py-1 text-xs" onClick={async () => { const v = prompt("Unit cost (USD)", String(it.unitCost)); if (v != null) await call(`/api/cases/${data.id}/future-care/${it.id}`, "PATCH", { unitCost: Number(v) }); }}>Edit unit cost</button>
                  <button className="py-1 text-xs font-medium text-red-600 hover:underline" onClick={async () => { if (confirm("Remove this item?")) await call(`/api/cases/${data.id}/future-care/${it.id}`, "DELETE"); }}>Remove</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function InlineProbability({ item, caseId, call }: { item: AnyRec; caseId: string; call: any }) {
  return (
    <select className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs" value={item.probability} onChange={(e) => call(`/api/cases/${caseId}/future-care/${item.id}`, "PATCH", { probability: e.target.value })}>
      {["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"].map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
    </select>
  );
}

// ── Costs ────────────────────────────────────────────────────────────────────
function CostsPanel({ data, assumptions, totals, canEdit, call }: { data: AnyRec; assumptions: AnyRec; totals: AnyRec; canEdit: boolean; call: any }) {
  const [a, setA] = useState({
    lifeExpectancyYears: Number(assumptions.lifeExpectancyYears.toFixed(1)),
    discountRate: assumptions.discountRate,
    medicalInflation: assumptions.medicalInflation,
    geographicFactor: assumptions.geographicFactor,
  });
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline to project costs.</Empty>;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Editable assumptions</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <NumField label="Life expectancy (yrs)" value={a.lifeExpectancyYears} step={0.5} disabled={!canEdit} onChange={(v) => setA({ ...a, lifeExpectancyYears: v })} />
          <NumField label="Discount rate" value={a.discountRate} step={0.005} disabled={!canEdit} onChange={(v) => setA({ ...a, discountRate: v })} pct />
          <NumField label="Medical inflation" value={a.medicalInflation} step={0.005} disabled={!canEdit} onChange={(v) => setA({ ...a, medicalInflation: v })} pct />
          <NumField label="Geographic factor" value={a.geographicFactor} step={0.05} disabled={!canEdit} onChange={(v) => setA({ ...a, geographicFactor: v })} />
        </div>
        {canEdit && <button className="btn-primary mt-4" onClick={() => call(`/api/cases/${data.id}`, "PATCH", a, "recompute")}>Recompute costs</button>}
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr><th className="px-4 py-2 font-medium">Service</th><th className="px-4 py-2 font-medium">Annual</th><th className="px-4 py-2 font-medium">Low</th><th className="px-4 py-2 font-medium">Lifetime</th><th className="px-4 py-2 font-medium">Present value</th></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.futureCareItems.map((it: AnyRec) => (
              <tr key={it.id}><td className="px-4 py-2 text-ink-800">{it.service}</td><td className="px-4 py-2 text-ink-600">{formatMoney(it.annualCost)}</td><td className="px-4 py-2 text-ink-500">{formatMoney(it.lowCost)}</td><td className="px-4 py-2 text-ink-600">{formatMoney(it.lifetimeCost)}</td><td className="px-4 py-2 font-medium text-brand-800">{formatMoney(it.presentValue)}</td></tr>
            ))}
            <tr className="bg-ink-50 font-bold"><td className="px-4 py-2">Total</td><td /><td /><td className="px-4 py-2">{formatMoney(totals.totalLifetime)}</td><td className="px-4 py-2 text-brand-800">{formatMoney(totals.totalPresentValue)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, step, disabled, pct }: { label: string; value: number; onChange: (v: number) => void; step: number; disabled?: boolean; pct?: boolean }) {
  return (
    <div>
      <label className="label">{label}{pct && ` (${(value * 100).toFixed(1)}%)`}</label>
      <input type="number" step={step} disabled={disabled} className="input" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

// ── Reviews ──────────────────────────────────────────────────────────────────
function ReviewsPanel({ defense, completeness, hasPlan }: { defense: AnyRec[]; completeness: AnyRec[]; hasPlan: boolean }) {
  if (!hasPlan) return <Empty>Run the AI pipeline to generate the defense vulnerability and completeness reviews.</Empty>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ReviewColumn title="Defense vulnerability review" subtitle="A defense-style critique — before opposing counsel writes it." findings={defense} />
      <ReviewColumn title="Plaintiff completeness review" subtitle="Commonly-expected care that may be missing." findings={completeness} />
    </div>
  );
}
function ReviewColumn({ title, subtitle, findings }: { title: string; subtitle: string; findings: AnyRec[] }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      <p className="text-xs text-ink-500">{subtitle}</p>
      <div className="mt-3 space-y-2">
        {findings.length === 0 && <p className="text-sm text-emerald-600">No findings — clean.</p>}
        {findings.map((f) => (
          <div key={f.id} className="rounded-lg border border-ink-200 p-3">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-ink-900">{f.category}</span><Badge tone={VULN_TONE[f.vulnerability]}>{f.vulnerability.toLowerCase()}</Badge></div>
            <p className="mt-1 text-xs text-ink-600">{f.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Physician ────────────────────────────────────────────────────────────────
function PhysicianPanel({ data, canReview, call }: { data: AnyRec; canReview: boolean; call: any }) {
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline first to build the physician review packet.</Empty>;
  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-ink-600">
        Physician review packet — {canReview ? "approve, reject, or modify each item and attach a medical-necessity statement." : "read-only: your role cannot sign off on medical necessity."}
      </div>
      {data.futureCareItems.map((it: AnyRec) => (
        <div key={it.id} className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-medium text-ink-900">{it.service}</span>
              <Badge tone={PHYS_TONE[it.physicianStatus]} className="ml-2">{it.physicianStatus.toLowerCase()}</Badge>
              <p className="mt-0.5 text-xs text-ink-500">{it.rationale}</p>
            </div>
            {canReview && (
              <div className="flex gap-2">
                <button className="btn-outline py-1 text-xs" onClick={() => call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", { status: "APPROVED", note: "Medical necessity confirmed." })}>Approve</button>
                <button className="btn-outline py-1 text-xs" onClick={() => { const n = prompt("Modification / note"); call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", { status: "MODIFIED", note: n || "Modified" }); }}>Modify</button>
                <button className="py-1 text-xs font-medium text-red-600 hover:underline" onClick={() => { const n = prompt("Reason for rejection"); call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", { status: "REJECTED", note: n || "Not supported" }); }}>Reject</button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
function ReportPanel({ data, canExport, call, busy, totals }: { data: AnyRec; canExport: boolean; call: any; busy: string | null; totals: AnyRec }) {
  const [template, setTemplate] = useState(data.side ?? "PLAINTIFF");
  async function exportReport(format: string) {
    const r = await call(`/api/cases/${data.id}/export`, "POST", { format, template }, "export");
    if (r?.export) window.open(`/api/cases/${data.id}/export/${r.export.id}/download`, "_blank");
  }
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Generate report</h3>
        <p className="text-xs text-ink-500">Present value {formatMoney(totals.totalPresentValue)} across {data.futureCareItems.length} items.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select className="input w-48" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="PLAINTIFF">Plaintiff template</option>
            <option value="DEFENSE">Defense template</option>
            <option value="NEUTRAL">Neutral template</option>
          </select>
          {canExport ? (
            <>
              <button className="btn-primary" disabled={busy === "export" || data.futureCareItems.length === 0} onClick={() => exportReport("DOCX")}>
                {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileOutput className="h-4 w-4" />} Export DOCX
              </button>
              <button className="btn-outline" disabled={data.futureCareItems.length === 0} onClick={() => exportReport("CSV")}>Export cost CSV</button>
            </>
          ) : <span className="text-sm text-ink-500">Your role cannot export reports.</span>}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Export history (version control)</h3>
        {data.reports.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No exports yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-500"><tr><th className="py-2">Version</th><th className="py-2">Format</th><th className="py-2">Template</th><th className="py-2">PV</th><th className="py-2">Created</th><th /></tr></thead>
            <tbody className="divide-y divide-ink-100">
              {data.reports.map((r: AnyRec) => (
                <tr key={r.id}>
                  <td className="py-2 font-medium">v{r.version}</td>
                  <td className="py-2">{r.format}</td>
                  <td className="py-2 text-ink-600">{r.template.toLowerCase()}</td>
                  <td className="py-2">{formatMoney(r.totalPresentValue)}</td>
                  <td className="py-2 text-ink-500">{formatDate(r.createdAt)}</td>
                  <td className="py-2"><a className="text-brand-700 hover:underline" href={`/api/cases/${data.id}/export/${r.id}/download`} target="_blank">Download</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
