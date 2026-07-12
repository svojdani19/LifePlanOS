"use client";

import { useState, useMemo, useRef, useEffect, Fragment } from "react";
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
  Plus,
  Calendar,
  UserRound,
  MapPin,
  Library,
  Pill,
  Accessibility,
  HeartHandshake,
  Bus,
  Lightbulb,
  Siren,
  Syringe,
  Dumbbell,
  Microscope,
  ClipboardList,
  Receipt,
  Scale,
  Gavel,
  Camera,
  ChevronDown,
  ExternalLink,
  File as FileIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatMoney, formatDate, cn } from "@/lib/utils";
import type { Permission } from "@/lib/rbac";
import { DOC_TYPE_GROUPS, TYPE_LABEL, TYPE_GROUP } from "@/lib/documents/taxonomy";
import { pageRange } from "@/lib/documents/meta";
import { recordEncounters, narrativeFor } from "@/lib/documents/recordSummary";
import { structuredConfidence } from "@/lib/engine/citationQuality";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase, type EvidenceItem, type RecommendationDossier } from "@/lib/engine/medicalNecessity";
import { Icd10Search } from "@/components/Icd10Search";
import { PreExistingConditionsModal } from "@/components/PreExistingConditionsModal";
import { parseConditions, serializeConditions, findConditionsInRecords } from "@/lib/intake/preExisting";
import { suggestDiagnoses } from "@/lib/intake/diagnosisSuggest";
import { confidenceBand, confidenceDefinition } from "@/lib/engine/confidence";
import { BookOpenCheck } from "lucide-react";
import { MEDICAL_SPECIALTIES } from "@/lib/intake/specialties";
import { US_STATES } from "@/lib/intake/jurisdictions";

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

// Future-care category groups (mirrors the report's Medical Cost Table
// grouping), each with a representative icon for the filter chips and headers.
const CARE_GROUPS: { title: string; icon: LucideIcon; cats: string[] }[] = [
  { title: "Physician & Specialist Visits", icon: Stethoscope, cats: ["PHYSICIAN_VISIT", "SPECIALIST_VISIT", "PRIMARY_CARE", "NEUROLOGY", "PMR", "PAIN_MANAGEMENT", "PSYCH"] },
  { title: "Surgical & Interventional", icon: Syringe, cats: ["ORTHOPEDIC_SURGERY", "NEUROSURGERY", "FUTURE_SURGERY", "REVISION_SURGERY", "INJECTION", "COMPLICATION_MANAGEMENT"] },
  { title: "Rehabilitation & Therapies", icon: Dumbbell, cats: ["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "SPEECH_THERAPY", "COGNITIVE_THERAPY"] },
  { title: "Diagnostics & Laboratory", icon: Microscope, cats: ["IMAGING", "LABS"] },
  { title: "Medications & Supplies", icon: Pill, cats: ["MEDICATION", "SUPPLIES"] },
  { title: "Equipment & Modifications", icon: Accessibility, cats: ["DME", "ORTHOTICS_PROSTHETICS", "MOBILITY_AID", "HOME_MODIFICATION", "VEHICLE_MODIFICATION", "ASSISTIVE_TECH"] },
  { title: "Attendant & Facility Care", icon: HeartHandshake, cats: ["ATTENDANT_CARE", "SKILLED_NURSING", "CASE_MANAGEMENT"] },
  { title: "Vocational & Transportation", icon: Bus, cats: ["VOCATIONAL_REHAB", "TRANSPORTATION", "MISC"] },
];
const careGroupOf = (cat: string) => CARE_GROUPS.find((g) => g.cats.includes(cat)) ?? CARE_GROUPS[CARE_GROUPS.length - 1];

// Citations are stored as an array of up to two articles from any literature
// source; tolerate legacy single objects and null. Returns only entries with a
// resolvable title + link (PMID, DOI, or URL).
type Cite = { source?: string; title?: string; authors?: string; journal?: string; year?: string; pmid?: string; doi?: string; url?: string };
const SOURCE_LABEL: Record<string, string> = { europepmc: "Europe PMC", crossref: "Crossref", semanticscholar: "Semantic Scholar" };
const citationList = (c: unknown): Cite[] =>
  ((Array.isArray(c) ? c : c ? [c] : []) as Cite[]).filter((x) => x && x.title && (x.pmid || x.doi || x.url));
const citeMeta = (c: Cite): string =>
  [c.authors, c.journal, c.year, c.pmid ? `PMID ${c.pmid}` : c.doi ? `doi:${c.doi}` : "", c.source ? (SOURCE_LABEL[c.source] ?? c.source) : ""].filter(Boolean).join(" · ");

export function CaseWorkspace({
  data,
  assumptions,
  totals,
  permissions,
  precedents = [],
  physicians = [],
}: {
  data: AnyRec;
  assumptions: { lifeExpectancyYears: number; discountRate: number; medicalInflation: number; geographicFactor: number };
  totals: { totalLifetime: number; totalPresentValue: number };
  permissions: Permission[];
  precedents?: AnyRec[];
  physicians?: AnyRec[];
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

  const TABS = [
    { id: "overview", label: "Intake", icon: FileText },
    { id: "records", label: `Records (${data.documents.length})`, icon: Upload },
    { id: "chronology", label: `Chronology (${data.chronologyEvents.length})`, icon: Activity },
    { id: "causation", label: "Causation", icon: GitBranch },
    { id: "providers", label: "Treating Providers", icon: UserRound },
    { id: "evidence", label: "Evidence", icon: Microscope },
    { id: "futurecare", label: `Future Care (${data.futureCareItems.length})`, icon: Stethoscope },
    { id: "costs", label: "Costs", icon: Calculator },
    { id: "reviews", label: `Reviews (${data.reviewFindings.length})`, icon: ShieldAlert },
    { id: "physician", label: `Physician (${pendingPhysician})`, icon: ClipboardCheck },
    { id: "precedents", label: `Precedents (${precedents.length})`, icon: Library },
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
              {data.caseType.replace(/_/g, " ").toLowerCase()} · {data.diagnosis || "no diagnosis set"}
              {data.icd10Code ? <span className="font-mono text-xs text-ink-500"> [{data.icd10Code}]</span> : null} · {data.jurisdiction || "no jurisdiction"}
            </p>
          </div>
          {can("futurecare.edit") && (
            <button className="btn-primary" disabled={busy === "gen"} onClick={() => call(`/api/cases/${data.id}/generate`, "POST", undefined, "gen")}>
              {busy === "gen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {hasPlan ? "Re-run AI Pipeline" : "Run AI Pipeline"}
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
            <Stat label="Future Care Items" value={String(data.futureCareItems.length)} />
            <Stat label="Lifetime (Undiscounted)" value={formatMoney(totals.totalLifetime)} />
            <Stat label="Present Value" value={formatMoney(totals.totalPresentValue)} highlight />
            <Stat label="Physician Pending" value={String(pendingPhysician)} />
          </div>
        )}
      </div>

      {/* Tabs — single non-wrapping row (scrolls horizontally if too narrow) */}
      <div className="mt-5 flex items-center gap-1 overflow-x-auto border-b border-ink-200">
        {TABS.map((t) =>
          t.id === "report" ? (
            // The Report tab is presented as a primary call-to-action button,
            // matching the "Re-run AI Pipeline" button format, kept compact so it
            // fits inline with the other tabs.
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn("btn-primary ml-auto shrink-0 whitespace-nowrap self-center px-3 py-1.5 text-sm", tab === t.id && "ring-2 ring-brand-300 ring-offset-1")}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ) : (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm font-medium transition-colors",
                tab === t.id ? "border-brand-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-800",
              )}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ),
        )}
      </div>

      <div className="mt-5">
        {tab === "overview" && <IntakePanel data={data} canEdit={can("case.edit")} call={call} />}
        {tab === "records" && <RecordsPanel data={data} canEdit={can("records.upload")} call={call} busy={busy} />}
        {tab === "chronology" && <ChronologyPanel data={data} canEdit={can("chronology.edit")} call={call} />}
        {tab === "causation" && <CausationPanel data={data} />}
        {tab === "providers" && <TreatingProvidersPanel data={data} canEdit={can("case.edit") || can("physician.review")} call={call} />}
        {tab === "evidence" && <EvidencePanel data={data} />}
        {tab === "futurecare" && <FutureCarePanel data={data} canEdit={can("futurecare.edit")} call={call} />}
        {tab === "costs" && <CostsPanel data={data} assumptions={assumptions} totals={totals} canEdit={can("case.edit")} call={call} />}
        {tab === "reviews" && <ReviewsPanel points={data.reviewFindings} hasPlan={hasPlan} />}
        {tab === "physician" && <PhysicianPanel data={data} canReview={can("physician.review")} call={call} />}
        {tab === "precedents" && <PrecedentsPanel precedents={precedents} data={data} />}
        {tab === "report" && <ReportPanel data={data} canExport={can("report.export")} canEdit={can("case.edit")} call={call} busy={busy} totals={totals} physicians={physicians} />}
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
const WORK_STATUSES = ["Employed", "Unemployed", "Disabled"];

function IntakePanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [form, setForm] = useState({
    diagnosis: data.diagnosis ?? "",
    icd10Code: data.icd10Code ?? "",
    mechanism: data.mechanism ?? "",
    jurisdiction: data.jurisdiction ?? "",
    specialty: data.specialty ?? "",
    currentWorkStatus: data.currentWorkStatus ?? "",
    disabilityReason: data.disabilityReason ?? "",
    functionalLimitations: data.functionalLimitations ?? "",
  });
  const [saved, setSaved] = useState(false);
  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  // Additional (secondary) diagnoses — each an ICD-10 search row.
  const [additional, setAdditional] = useState<{ diagnosis: string; icd10Code: string }[]>(
    Array.isArray(data.additionalDiagnoses) ? data.additionalDiagnoses : [],
  );
  // Additional specialties for review — each a specialty autocomplete row.
  const [addlSpecialties, setAddlSpecialties] = useState<string[]>(
    Array.isArray(data.additionalSpecialties) ? data.additionalSpecialties : [],
  );

  // Pre-existing conditions — managed via the pop-up picker with its own save.
  const [preConditions, setPreConditions] = useState<string[]>(parseConditions(data.preExistingConditions));
  const [preReviewed, setPreReviewed] = useState<boolean>(!!data.preExistingReviewed);
  const [preOpen, setPreOpen] = useState(false);
  const [preSaving, setPreSaving] = useState(false);

  async function savePreExisting(selected: string[], none: boolean) {
    setPreSaving(true);
    const list = none ? [] : selected;
    const r = await call(`/api/cases/${data.id}`, "PATCH", { preExistingConditions: serializeConditions(list), preExistingReviewed: true }, "pre");
    setPreSaving(false);
    if (r) {
      setPreConditions(list);
      setPreReviewed(true);
      setPreOpen(false);
    }
  }

  // Every diagnosis must link to an ICD-10 code. Flag any with text but no code.
  const unlinkedDx = [
    ...(form.diagnosis.trim() && !form.icd10Code.trim() ? ["Primary Diagnosis"] : []),
    ...additional.map((d, i) => (d.diagnosis.trim() && !d.icd10Code.trim() ? `Additional Diagnosis ${i + 1}` : "")).filter(Boolean),
  ];

  // Diagnoses supported by the record CONTENT that are not yet on the case —
  // suggested to the user; on approval they are saved to the case and flow into
  // the AI pipeline (diagnosis corpus) on the next run.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const suggestions = useMemo(
    () =>
      suggestDiagnoses(data.documents ?? [], [{ diagnosis: form.diagnosis, icd10Code: form.icd10Code }, ...additional]).filter(
        (s) => !dismissed.has(s.icd10Code),
      ),
    [data.documents, form.diagnosis, form.icd10Code, additional, dismissed],
  );

  async function approveSuggestion(s: { diagnosis: string; icd10Code: string }, asPrimary: boolean) {
    if (asPrimary) {
      setForm((f) => ({ ...f, diagnosis: s.diagnosis, icd10Code: s.icd10Code }));
      await call(`/api/cases/${data.id}`, "PATCH", { diagnosis: s.diagnosis, icd10Code: s.icd10Code }, "dx");
    } else {
      const next = [...additional, { diagnosis: s.diagnosis, icd10Code: s.icd10Code }];
      setAdditional(next);
      await call(`/api/cases/${data.id}`, "PATCH", { additionalDiagnoses: next.filter((d) => d.diagnosis.trim()) }, "dx");
    }
  }

  return (
    <div className="card max-w-3xl p-6">
      <h3 className="text-sm font-semibold text-ink-900">Case Intake</h3>
      <p className="mt-1 text-xs text-ink-500">Structured intake. The future-care engine infers specialty-specific rules from the diagnosis.</p>

      {/* Diagnoses detected in the record content, pending user approval. */}
      {canEdit && suggestions.length > 0 && (
        <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50/50 p-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-brand-700" />
            <p className="text-sm font-semibold text-ink-900">Suggested Diagnoses From the Records</p>
          </div>
          <p className="mt-1 text-xs text-ink-500">Found in the content of the ingested records and not yet on this case. Approving adds the diagnosis to the case; the AI pipeline incorporates it on the next run.</p>
          <div className="mt-3 space-y-2">
            {suggestions.map((s) => (
              <div key={s.icd10Code} className="flex flex-wrap items-center gap-2 rounded-md bg-white px-3 py-2">
                <span className="text-sm font-medium text-ink-900">{s.diagnosis}</span>
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">{s.icd10Code}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-400" title={s.sources.join(", ")}>in {s.sources.length} record{s.sources.length === 1 ? "" : "s"}: {s.sources.join(", ")}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {!form.diagnosis.trim() && <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => approveSuggestion(s, true)}>Set as Primary</button>}
                  <button className="btn-outline px-2.5 py-1 text-xs" onClick={() => approveSuggestion(s, false)}>Add as Additional</button>
                  <button className="rounded-md p-1 text-ink-300 hover:bg-ink-100 hover:text-ink-600" title="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(s.icd10Code))}><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Primary Diagnosis (ICD-10)" wide>
          <Icd10Search
            value={form.diagnosis}
            code={form.icd10Code}
            disabled={!canEdit}
            onChange={({ diagnosis, icd10Code }) => { setForm((f) => ({ ...f, diagnosis, icd10Code })); setSaved(false); }}
          />
          {additional.map((d, idx) => (
            <div key={idx} className="mt-2 flex items-start gap-2">
              <div className="flex-1">
                <p className="mb-1 text-xs text-ink-500">Additional Diagnosis {idx + 1}</p>
                <Icd10Search
                  value={d.diagnosis}
                  code={d.icd10Code}
                  disabled={!canEdit}
                  onChange={(v) => { setAdditional((a) => a.map((x, i) => (i === idx ? v : x))); setSaved(false); }}
                />
              </div>
              {canEdit && (
                <button type="button" title="Remove" className="mt-6 rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-red-600" onClick={() => { setAdditional((a) => a.filter((_, i) => i !== idx)); setSaved(false); }}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => { setAdditional((a) => [...a, { diagnosis: "", icd10Code: "" }]); setSaved(false); }}>
              <Plus className="h-3.5 w-3.5" /> Additional Diagnosis
            </button>
          )}
        </Field>
        <Field label="Specialty for Review" wide>
          <select className="input" disabled={!canEdit} value={form.specialty} onChange={(e) => set("specialty", e.target.value)}>
            <option value="">Select a specialty…</option>
            {MEDICAL_SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {addlSpecialties.map((s, idx) => (
            <div key={idx} className="mt-2 flex items-center gap-2">
              <select
                className="input flex-1"
                disabled={!canEdit}
                value={s}
                onChange={(e) => { setAddlSpecialties((prev) => prev.map((x, i) => (i === idx ? e.target.value : x))); setSaved(false); }}
              >
                <option value="">Additional specialty {idx + 1}…</option>
                {MEDICAL_SPECIALTIES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {canEdit && (
                <button type="button" title="Remove" className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-red-600" onClick={() => { setAddlSpecialties((prev) => prev.filter((_, i) => i !== idx)); setSaved(false); }}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => { setAddlSpecialties((prev) => [...prev, ""]); setSaved(false); }}>
              <Plus className="h-3.5 w-3.5" /> Additional Specialty
            </button>
          )}
        </Field>
        <Field label="Mechanism of Injury"><input className="input" disabled={!canEdit} value={form.mechanism} onChange={(e) => set("mechanism", e.target.value)} /></Field>
        <Field label="Jurisdiction">
          <input className="input" list="state-list" disabled={!canEdit} value={form.jurisdiction} placeholder="Search states…" onChange={(e) => set("jurisdiction", e.target.value)} />
          <datalist id="state-list">
            {US_STATES.map((s) => <option key={s} value={s} />)}
          </datalist>
        </Field>

        {/* Pre-existing conditions — pop-up multi-select with Complete/Incomplete status */}
        <Field label="Pre-Existing Conditions" wide>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-outline" disabled={!canEdit} onClick={() => setPreOpen(true)}>
              {preReviewed ? "Edit Conditions" : "Select Conditions"}
            </button>
            <Badge tone={preReviewed ? "green" : "amber"}>{preReviewed ? "Complete" : "Incomplete"}</Badge>
            <span className="text-xs text-ink-500">
              {preReviewed ? (preConditions.length ? `${preConditions.length} condition${preConditions.length === 1 ? "" : "s"} recorded` : "No known pre-existing conditions") : "Not yet reviewed"}
            </span>
          </div>
          {preConditions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {preConditions.map((c) => (
                <span key={c} className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs text-ink-700">{c}</span>
              ))}
            </div>
          )}
        </Field>

        <Field label="Current Work Status">
          <select
            className="input"
            disabled={!canEdit}
            value={form.currentWorkStatus}
            onChange={(e) => setForm((f) => ({ ...f, currentWorkStatus: e.target.value, disabilityReason: e.target.value === "Disabled" ? f.disabilityReason : "" }))}
          >
            <option value="">Select…</option>
            {WORK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        {form.currentWorkStatus === "Disabled" ? (
          <Field label="Reason for Disability">
            <input className="input" disabled={!canEdit} value={form.disabilityReason} placeholder="e.g. lumbar radiculopathy, unable to sit/stand" onChange={(e) => set("disabilityReason", e.target.value)} />
          </Field>
        ) : (
          <div className="hidden sm:block" />
        )}
        <Field label="Functional Limitations" wide><textarea className="input min-h-[70px]" disabled={!canEdit} value={form.functionalLimitations} onChange={(e) => set("functionalLimitations", e.target.value)} /></Field>
      </div>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <button className="btn-primary" onClick={async () => {
            if (unlinkedDx.length) { alert(`Link an ICD-10 code to each diagnosis before saving. Missing: ${unlinkedDx.join(", ")}. Pick a code from the search results.`); return; }
            const r = await call(`/api/cases/${data.id}`, "PATCH", { ...form, additionalDiagnoses: additional.filter((d) => d.diagnosis.trim()), additionalSpecialties: addlSpecialties.map((s) => s.trim()).filter(Boolean) }, "intake"); if (r) setSaved(true);
          }}>Save Intake</button>
          {unlinkedDx.length > 0 && <span className="text-sm text-amber-600">Link an ICD-10 code to {unlinkedDx.length === 1 ? "the flagged diagnosis" : `${unlinkedDx.length} diagnoses`} before saving.</span>}
          {saved && unlinkedDx.length === 0 && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      )}

      {preOpen && (
        <PreExistingConditionsModal
          initial={preConditions}
          detectedInRecords={findConditionsInRecords(data.documents.map((d: AnyRec) => d.extractedText || "").join(" \n "))}
          saving={preSaving}
          onClose={() => setPreOpen(false)}
          onSave={savePreExisting}
        />
      )}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <div className={wide ? "sm:col-span-2" : ""}><label className="label">{label}</label>{children}</div>;
}

// ── Records ──────────────────────────────────────────────────────────────────
// One icon per document group, used both on the group filter chips and as the
// left-hand type label on each record.
const GROUP_ICON: Record<string, LucideIcon> = {
  "Emergency & Acute Care": Siren,
  "Surgical & Procedural": Syringe,
  "Outpatient / Clinic": Stethoscope,
  "Rehabilitation & Therapy": Dumbbell,
  Diagnostics: Microscope,
  "Life Care Plan & Vocational": ClipboardList,
  "Financial & Economic": Receipt,
  "Medicolegal / Expert": Scale,
  "Legal & Liability": Gavel,
  "Scene & Evidence": Camera,
  Other: FileIcon,
};
const iconForType = (type: string): LucideIcon => GROUP_ICON[TYPE_GROUP[type] ?? "Other"] ?? FileIcon;


// Documented date · documenting individual (name, credentials, role) · location.
function RecordMeta({ d, compact }: { d: AnyRec; compact?: boolean }) {
  const fmt = (v: string) => new Date(v).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const pp = (pages: number[]) => { const r = pageRange(pages || []); return r ? (/[–,]/.test(r) ? `pp. ${r}` : `p. ${r}`) : ""; };
  const providers: AnyRec[] = Array.isArray(d.providers) ? d.providers : [];
  const locations: AnyRec[] = Array.isArray(d.locations) ? d.locations : [];
  const datePages: number[] = Array.isArray(d.datePages) ? d.datePages : [];

  const start = d.serviceDate ? fmt(d.serviceDate) : null;
  const end = d.serviceDateEnd ? fmt(d.serviceDateEnd) : null;
  const dateStr = start && end ? `${start} – ${end}` : start;
  const singleWho = d.authorName
    ? `${d.authorName}${d.authorCredentials ? `, ${d.authorCredentials}` : ""}${d.authorRole ? ` — ${d.authorRole}` : ""}`
    : d.authorRole || null;

  if (!dateStr && !singleWho && !d.facility && providers.length === 0 && locations.length === 0) {
    return <p className="mt-1 text-xs italic text-ink-300">No date, author, or location documented in this record.</p>;
  }
  return (
    <div className="mt-1 space-y-1 text-xs text-ink-500">
      {dateStr && (
        <div className="flex items-center gap-1">
          <Calendar className="h-3 w-3 shrink-0 text-ink-400" />
          <span>{dateStr}{end && datePages.length > 1 && <span className="text-ink-400"> · {pp(datePages)}</span>}</span>
        </div>
      )}
      {/* In compact mode (a per-date breakdown follows) the flat provider/location
          lists are omitted — each encounter carries its own below. */}
      {compact ? null : providers.length > 1 ? (
        <div className="flex items-start gap-1">
          <UserRound className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
          <ul className="space-y-0.5">
            {providers.map((p, i) => (
              <li key={i}>{p.name}{p.credentials ? `, ${p.credentials}` : ""}{p.role ? ` — ${p.role}` : ""}{p.pages?.length ? <span className="text-ink-400"> ({pp(p.pages)})</span> : null}</li>
            ))}
          </ul>
        </div>
      ) : singleWho ? (
        <div className="flex items-center gap-1"><UserRound className="h-3 w-3 shrink-0 text-ink-400" />{singleWho}</div>
      ) : null}
      {compact ? null : locations.length > 1 ? (
        <div className="flex items-start gap-1">
          <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
          <ul className="space-y-0.5">
            {locations.map((l, i) => (
              <li key={i}>{l.name}{l.pages?.length ? <span className="text-ink-400"> ({pp(l.pages)})</span> : null}</li>
            ))}
          </ul>
        </div>
      ) : d.facility ? (
        <div className="flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0 text-ink-400" />{d.facility}</div>
      ) : null}
    </div>
  );
}

function RecordsPanel({ data, canEdit, call, busy }: { data: AnyRec; canEdit: boolean; call: any; busy: string | null }) {
  const [filter, setFilter] = useState<string>("All");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
            <Upload className="h-4 w-4" /> Upload Records
            <input type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          </label>
          <button className="btn-ghost" disabled={busy === "sample"} onClick={() => call(`/api/cases/${data.id}/documents`, "POST", { sample: true }, "sample")}>
            {busy === "sample" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Add Sample Record Set
          </button>
          <span className="text-xs text-ink-500">
            Each record is auto-labeled by type. Click a record&apos;s type icon to reassign it.
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
              <FilterChip key={g.label} label={g.label} count={groupCounts[g.label]} icon={GROUP_ICON[g.label]} active={filter === g.label} onClick={() => setFilter(g.label)} />
            ))}
          </div>

          <div className="card overflow-hidden">
            <div className="divide-y divide-ink-100">
              {filtered.map((d) => {
                const TypeIcon = iconForType(d.type);
                const open = expandedId === d.id;
                return (
                  <div key={d.id} className="px-4 py-3 hover:bg-ink-50/60">
                    <div className="flex items-start gap-3">
                      {/* Left: the type icon is the (editable) type label. */}
                      {editingId === d.id ? (
                        <select
                          autoFocus
                          defaultValue={d.type}
                          className="mt-0.5 rounded-md border border-ink-300 bg-white px-2 py-1 text-xs"
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
                      ) : (
                        <button
                          type="button"
                          title={`${TYPE_LABEL[d.type] ?? d.type.replace(/_/g, " ")}${canEdit ? " — click to reassign" : ""}`}
                          onClick={() => canEdit && setEditingId(d.id)}
                          className={cn("group relative mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700", canEdit && "cursor-pointer hover:bg-brand-100")}
                        >
                          <TypeIcon className="h-5 w-5" />
                          {canEdit && <Pencil className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-white p-0.5 text-ink-400 opacity-0 shadow-sm transition-opacity group-hover:opacity-100" />}
                        </button>
                      )}

                      {/* Middle: filename toggles the expandable detail + summary. */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setExpandedId(open ? null : d.id)} className="group flex min-w-0 items-center gap-1.5 text-left" aria-expanded={open}>
                            <span className="truncate text-sm font-medium text-ink-900">{d.filename}</span>
                            <span className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-brand-700 group-hover:underline">
                              Details
                              <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
                            </span>
                          </button>
                          {d.flags && <span title={d.flags} className="shrink-0 text-sm text-amber-500">⚠</span>}
                        </div>

                        {open && (() => {
                          const enc = recordEncounters(d);
                          const consolidated = !!enc && enc.length >= 2;
                          return (
                          <div className="mt-2 space-y-2 rounded-lg bg-ink-50/70 p-3">
                            {/* Consolidated records show a compact header (date range +
                                pages) and detail each encounter below — no duplicate
                                provider/location lists. */}
                            <RecordMeta d={d} compact={consolidated} />
                            {(d.pageCount || d.ocrConfidence != null) && (
                              <p className="text-[11px] text-ink-400">
                                {d.pageCount ? `${d.pageCount} page${d.pageCount === 1 ? "" : "s"}` : ""}
                                {d.pageCount && d.ocrConfidence != null ? " · " : ""}
                                {d.ocrConfidence != null ? `OCR ${Math.round(d.ocrConfidence * 100)}%` : ""}
                                {d.flags ? ` · ${d.flags}` : ""}
                              </p>
                            )}
                            {consolidated ? (
                              <div className="space-y-1.5">
                                <p className="text-[11px] font-medium text-ink-500">{enc!.length} dated encounters in this record:</p>
                                <ul className="space-y-2">
                                  {enc!.map((e, i) => (
                                    <li key={i} className="border-l-2 border-ink-200 pl-2.5 text-xs">
                                      <p className="font-semibold text-ink-900">
                                        {e.label}
                                        {e.provider ? <span className="font-normal text-ink-700"> — {e.provider}</span> : null}
                                        {e.facility ? <span className="font-normal text-ink-400"> · {e.facility}</span> : null}
                                      </p>
                                      <p className="leading-relaxed text-ink-600">{e.summary}</p>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : (
                              <p className="text-xs leading-relaxed text-ink-600">{narrativeFor(d)}</p>
                            )}
                          </div>
                          );
                        })()}
                      </div>

                      {/* Right: open the document, and remove. */}
                      <div className="flex shrink-0 items-center gap-1">
                        <a
                          href={`/api/cases/${data.id}/documents/${d.id}/view`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open document"
                          className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-brand-700"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        {canEdit && (
                          <button className="rounded-md p-1.5 text-ink-300 hover:bg-ink-100 hover:text-red-600" title="Remove" onClick={async () => { if (confirm(`Remove ${d.filename}?`)) await call(`/api/cases/${data.id}/documents/${d.id}`, "DELETE"); }}>
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-400">No documents in this category.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FilterChip({ label, count, active, onClick, icon: Icon }: { label: string; count: number; active: boolean; onClick: () => void; icon?: LucideIcon }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200",
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {label}
      <span className={cn("rounded-full px-1.5 text-[10px] font-semibold", active ? "bg-white/20" : "bg-white text-ink-500")}>{count}</span>
    </button>
  );
}

// ── Chronology (record-derived timeline) ─────────────────────────────────────
const EVENT_STYLE: Record<string, { label: string; dot: string; chip: string }> = {
  SURGERY: { label: "Surgery", dot: "#7c3aed", chip: "bg-purple-100 text-purple-800" },
  IMAGING: { label: "Imaging", dot: "#2563eb", chip: "bg-blue-100 text-blue-800" },
  LAB: { label: "Labs", dot: "#0891b2", chip: "bg-cyan-100 text-cyan-800" },
  CLINIC_VISIT: { label: "Clinic Visit", dot: "#64748b", chip: "bg-ink-200 text-ink-700" },
  ER_VISIT: { label: "ER Visit", dot: "#dc2626", chip: "bg-red-100 text-red-800" },
  HOSPITALIZATION: { label: "Hospitalization", dot: "#4f46e5", chip: "bg-indigo-100 text-indigo-800" },
  THERAPY: { label: "Therapy", dot: "#059669", chip: "bg-emerald-100 text-emerald-800" },
  COMPLICATION: { label: "Complication", dot: "#d97706", chip: "bg-amber-100 text-amber-800" },
  LEGAL_EVENT: { label: "Legal", dot: "#4f46e5", chip: "bg-indigo-100 text-indigo-800" },
  BILLING: { label: "Billing", dot: "#94a3b8", chip: "bg-ink-100 text-ink-600" },
  OTHER: { label: "Record", dot: "#94a3b8", chip: "bg-ink-100 text-ink-600" },
};
const styleFor = (t?: string) => EVENT_STYLE[t ?? "OTHER"] ?? EVENT_STYLE.OTHER;

// LCP-style date: MM/DD/YYYY (matches the "Treatment and Surgeries" format).
const lcpDate = (v: string | Date) => {
  const d = new Date(v);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
};
function ChronologyPanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("ALL");

  const events: AnyRec[] = data.chronologyEvents;
  if (events.length === 0)
    return <Empty>Upload records, then run the AI pipeline to build the medical chronology of the events that bear on the diagnoses and future care.</Empty>;

  const docName: Record<string, string> = {};
  data.documents.forEach((d: AnyRec) => (docName[d.id] = d.filename));

  const typeCounts: Record<string, number> = {};
  events.forEach((e) => (typeCounts[e.eventType ?? "OTHER"] = (typeCounts[e.eventType ?? "OTHER"] ?? 0) + 1));
  const presentTypes = Object.keys(typeCounts);
  const filtered = filter === "ALL" ? events : events.filter((e) => (e.eventType ?? "OTHER") === filter);

  const excluded = Math.max(0, data.documents.length - events.length);

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">
        {events.length} pivotal {events.length === 1 ? "event" : "events"} — those bearing on the diagnoses and future care — screened from {data.documents.length}{" "}
        {data.documents.length === 1 ? "record" : "records"}
        {excluded > 0 ? ` (${excluded} without a bearing on the complaint were excluded)` : ""}.
      </p>

      {/* Type filter chips */}
      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" count={events.length} active={filter === "ALL"} onClick={() => setFilter("ALL")} />
        {presentTypes.map((t) => (
          <FilterChip key={t} label={styleFor(t).label} count={typeCounts[t]} active={filter === t} onClick={() => setFilter(t)} />
        ))}
      </div>

      {/* Vertical timeline */}
      <ol className="relative ml-2 border-l border-ink-200 pl-6">
        {filtered.map((e) => {
          const s = styleFor(e.eventType);
          return (
            <li key={e.id} className="relative mb-6">
              <span className="absolute -left-[31px] top-1.5 h-3.5 w-3.5 rounded-full border-2 border-white" style={{ background: s.dot }} />
              <div className="card p-4">
                {/* LCP-style encounter header: date[-range] · provider / facility · record type */}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-ink-900">
                    {lcpDate(e.eventDate)}{e.eventDateEnd ? ` – ${lcpDate(e.eventDateEnd)}` : ""}
                  </span>
                  <span className="text-sm text-ink-700">
                    — {e.provider || "Treating provider"}{e.facility ? ` / ${String(e.facility).replace(/[.\s]+$/, "")}` : ""}{e.recordType ? ` — ${e.recordType}` : ""}
                  </span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", s.chip)}>{s.label}</span>
                  {e.dateInferred && <Badge tone="amber">date inferred</Badge>}
                  {e.edited && <Badge tone="amber">edited</Badge>}
                  {canEdit && (
                    <button className="ml-auto text-ink-300 hover:text-ink-700" onClick={() => { setEditing(e.id); setDraft(e.summary); }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {editing === e.id ? (
                  <div className="mt-2 flex gap-2">
                    <input className="input py-1" value={draft} onChange={(ev) => setDraft(ev.target.value)} />
                    <button className="text-emerald-600" onClick={async () => { await call(`/api/cases/${data.id}/chronology/${e.id}`, "PATCH", { summary: draft }); setEditing(null); }}><Check className="h-4 w-4" /></button>
                    <button className="text-ink-400" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  /* Labeled clinical sections in LCP order. Falls back to the
                     composed summary when the record had no labeled sections. */
                  <div className="mt-2 space-y-1 text-sm">
                    {[
                      ["Subjective", e.subjective],
                      ["Exam", e.objectiveFindings],
                      ["Diagnostic Studies", e.imagingFindings],
                      ["Assessment", e.diagnosis],
                      ["Plan", e.treatment],
                      ["Procedure", e.procedure],
                      ["Disposition", e.disposition],
                    ].filter(([, v]) => v).map(([label, v]) => (
                      <p key={label as string} className="text-ink-800"><span className="font-semibold text-ink-600">{label}: </span>{v as string}</p>
                    ))}
                    {!e.subjective && !e.objectiveFindings && !e.imagingFindings && !e.diagnosis && !e.treatment && !e.procedure && !e.disposition && (
                      <p className="text-ink-800">{e.summary}</p>
                    )}
                  </div>
                )}

                {/* Clinical significance — ties the event to diagnoses & future care */}
                {e.clinicalSignificance && (
                  <p className="mt-2 rounded-md bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800">
                    <span className="font-semibold">Significance: </span>{e.clinicalSignificance}
                  </p>
                )}

                {/* Source citation for the encounter. */}
                {e.sourceDocumentId && (
                  <a
                    href={`/api/cases/${data.id}/documents/${e.sourceDocumentId}/view`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Source: {docName[e.sourceDocumentId] ?? "record"}
                    {e.sourcePage ? `, p. ${e.sourcePage}` : ""}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── Causation ────────────────────────────────────────────────────────────────
const REL_TONE: Record<string, "green" | "amber" | "neutral" | "red"> = { RELATED: "green", AGGRAVATION: "amber", PREEXISTING_UNRELATED: "neutral", SUBSEQUENT_UNRELATED: "neutral", UNCLEAR: "red" };
function CausationPanel({ data }: { data: AnyRec }) {
  if (data.conditions.length === 0) return <Empty>Run the AI pipeline to build the causation & apportionment map.</Empty>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data.conditions.map((c: AnyRec) => {
        const sources: AnyRec[] = Array.isArray(c.evidenceSources) ? c.evidenceSources : [];
        return (
          <div key={c.id} className="card p-5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-ink-900">{c.name}</h3>
              <Badge tone={REL_TONE[c.relatedness]}>{c.relatedness.replace(/_/g, " ").toLowerCase()}</Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-ink-500">
              <span>Confidence</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-100"><div className="h-full bg-brand-500" style={{ width: `${c.confidence}%` }} /></div>
              <span className="font-medium text-ink-700">{confidenceBand(c.confidence)} · {c.confidence}%</span>
              {c.physicianConfirmed && <Badge tone="green">MD confirmed</Badge>}
            </div>
            {/* What the determined confidence level means and how it was set. */}
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
              {confidenceDefinition({ confidence: c.confidence, physicianConfirmed: c.physicianConfirmed, missingInfo: c.missingInfo, evidenceCount: sources.length })}
            </p>
            <p className="mt-3 text-sm text-ink-700">{c.reasoning}</p>
            {c.objectiveEvidence && <p className="mt-2 text-xs text-ink-500"><span className="font-medium">Objective evidence:</span> {c.objectiveEvidence}</p>}
            {/* Links to the actual evidence: source record + page of the content. */}
            {sources.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {sources.map((s, i) => (
                  <li key={`${s.documentId}-${i}`} className="text-xs">
                    <a
                      href={`/api/cases/${data.id}/documents/${s.documentId}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                    >
                      <FileText className="h-3 w-3 shrink-0" />
                      {s.filename}{s.page ? ` — p. ${s.page}` : ""}
                    </a>
                    {s.quote && <span className="ml-1 italic text-ink-400">“{s.quote}”</span>}
                  </li>
                ))}
              </ul>
            )}
            {c.missingInfo && <p className="mt-1 text-xs text-amber-700"><span className="font-medium">Missing:</span> {c.missingInfo}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ── Standard of Care ─────────────────────────────────────────────────────────
// Per causation item: the located clinical practice guidelines with their
// DIRECT LANGUAGE quoted verbatim from the retrieved source, the documented
// care that corresponds, and a documentation status. Compliance determination
// is explicitly reserved to the reviewing physician.
const SOC_TONE: Record<string, "green" | "amber" | "red"> = { DOCUMENTED: "green", LIMITED: "amber", NOT_DOCUMENTED: "red" };
const VERDICT_META: Record<string, { tone: "green" | "amber" | "red" | "neutral"; label: string }> = {
  CONSISTENT: { tone: "green", label: "Consistent with cited guidance" },
  PARTIAL: { tone: "amber", label: "Partially consistent — gaps noted" },
  POTENTIAL_GAP: { tone: "red", label: "Potential gap — not documented" },
  INDETERMINATE: { tone: "neutral", label: "Indeterminate" },
};
// Add a reviewer note, paste a source, or upload an article for one condition.
// Notes join the evidence corpus; sources become cited guidance; both recompute
// the assessment server-side. router.refresh() (inside `call`) pulls the update.
function SocInputControls({ caseId, conditionName, call }: { caseId: string; conditionName: string; call: any }) {
  const [mode, setMode] = useState<null | "note" | "source">(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function submit() {
    if (!text.trim()) return;
    const body = mode === "note" ? { kind: "note", conditionName, text } : { kind: "source", conditionName, text, title: title || undefined, url: url || undefined };
    const r = await call(`/api/cases/${caseId}/soc`, "POST", body, "soc");
    if (r) { setText(""); setTitle(""); setUrl(""); setMode(null); }
  }

  async function upload(file: File) {
    setUploading(true);
    const fd = new FormData();
    fd.append("conditionName", conditionName);
    fd.append("file", file);
    const res = await fetch(`/api/cases/${caseId}/soc`, { method: "POST", body: fd });
    setUploading(false);
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error ?? "Upload failed"); return; }
    router.refresh();
  }

  return (
    <div className="mt-3 border-t border-ink-100 pt-3">
      {mode === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-500">Add to this analysis:</span>
          <button className="btn-outline px-2.5 py-1 text-xs" onClick={() => setMode("note")}><Plus className="h-3 w-3" /> Note</button>
          <button className="btn-outline px-2.5 py-1 text-xs" onClick={() => setMode("source")}><Plus className="h-3 w-3" /> Source / citation</button>
          <button className="btn-outline px-2.5 py-1 text-xs" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Upload article
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        </div>
      ) : (
        <div className="space-y-2">
          {mode === "source" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input py-1 text-sm" placeholder="Source title / citation (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input className="input py-1 text-sm" placeholder="URL / DOI (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
          )}
          <textarea
            className="input min-h-[70px] text-sm"
            placeholder={mode === "note" ? "Reviewer note — will be incorporated into the assessment (e.g. documented care not captured in the records)…" : "Paste the pertinent guideline / article language to cite…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <button className="btn-primary px-3 py-1 text-xs" onClick={submit}>Add {mode}</button>
            <button className="btn-outline px-3 py-1 text-xs" onClick={() => { setMode(null); setText(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StandardOfCarePanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  if (data.conditions.length === 0) return <Empty>Run the AI pipeline to build the standard-of-care analysis from the causation items.</Empty>;
  const withSoc = data.conditions.filter((c: AnyRec) => c.socAnalysis);
  if (withSoc.length === 0) return <Empty>Re-run the AI pipeline to generate the standard-of-care analysis (requires network access for guideline lookup).</Empty>;
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-ink-50 px-4 py-3 text-xs leading-relaxed text-ink-500">
        For each causation item, published clinical practice guidance is located across the literature databases and its pertinent language quoted <span className="font-medium">verbatim from the retrieved source</span> — never paraphrased into the source&apos;s voice, never invented. The documented care from the chronology is mapped against that guidance. Whether the care <span className="font-medium">met</span> the standard of care is a determination reserved to the reviewing physician.
      </p>
      {withSoc.map((c: AnyRec) => {
        const soc: AnyRec = c.socAnalysis;
        const guidelines: AnyRec[] = Array.isArray(soc.guidelines) ? soc.guidelines : [];
        const support: AnyRec[] = Array.isArray(soc.recordSupport) ? soc.recordSupport : [];
        const assessment: AnyRec | null = soc.assessment ?? null;
        const points: AnyRec[] = assessment && Array.isArray(assessment.points) ? assessment.points : [];
        const vmeta = assessment ? VERDICT_META[assessment.verdict] ?? VERDICT_META.INDETERMINATE : null;
        const addressedOf = (g: AnyRec) => points.find((p) => p.guideline && (g.title.startsWith(p.guideline.replace(/…$/, "")) || p.guideline.startsWith(g.title.slice(0, 60))));
        return (
          <div key={c.id} className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="font-semibold text-ink-900">{c.name}</h3>
              <div className="flex items-center gap-2">
                <Badge tone={REL_TONE[c.relatedness]}>{c.relatedness.replace(/_/g, " ").toLowerCase()}</Badge>
                <Badge tone={SOC_TONE[soc.documentation] ?? "amber"}>{String(soc.documentation).replace(/_/g, " ").toLowerCase()}</Badge>
              </div>
            </div>

            {/* The actual standard-of-care determination. */}
            {assessment && vmeta && (
              <div className={cn("mt-3 rounded-lg border p-3", vmeta.tone === "green" ? "border-emerald-200 bg-emerald-50" : vmeta.tone === "red" ? "border-red-200 bg-red-50" : vmeta.tone === "amber" ? "border-amber-200 bg-amber-50" : "border-ink-200 bg-ink-50")}>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Standard-of-care assessment</span>
                  <Badge tone={vmeta.tone}>{vmeta.label}</Badge>
                </div>
                <p className="mt-1.5 text-sm text-ink-800">{assessment.narrative}</p>
                {assessment.evidence && (
                  <div className="mt-2 border-t border-ink-200/70 pt-2 text-xs text-ink-600">
                    <p>
                      <span className="font-medium text-ink-800">Strength of evidence:</span> {assessment.evidence.strength}
                      <span className="ml-3 font-medium text-ink-800">Clinical confidence:</span>{" "}
                      <Badge tone={assessment.evidence.confidence === "High" ? "green" : assessment.evidence.confidence === "Moderate" ? "amber" : assessment.evidence.confidence === "Low" ? "red" : "neutral"}>{assessment.evidence.confidence.toLowerCase()}</Badge>
                    </p>
                    {assessment.evidence.limitations?.length > 0 && <p className="mt-1"><span className="font-medium text-ink-800">Limitations:</span> {assessment.evidence.limitations.join("; ")}</p>}
                    {assessment.evidence.unknowns?.length > 0 && <p className="mt-0.5"><span className="font-medium text-ink-800">Unknowns:</span> {assessment.evidence.unknowns.join("; ")}</p>}
                  </div>
                )}
                {Array.isArray(assessment.opinion) && assessment.opinion.length > 0 && (
                  <div className="mt-3 border-t border-ink-200/70 pt-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Expert rationale — standard of care as applied to this case</p>
                    <div className="mt-1.5 space-y-2">
                      {assessment.opinion.map((para: string, i: number) => (
                        <p key={i} className="text-sm leading-relaxed text-ink-700">{para}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <p className="mt-3 text-xs text-ink-500">{soc.standard}</p>

            {guidelines.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Applicable guidance — direct language from the source</p>
                <ol className="mt-1.5 space-y-3">
                  {guidelines.map((g, i) => {
                    const pt = addressedOf(g);
                    return (
                      <li key={g.pmid ?? g.doi ?? i} className="rounded-lg bg-brand-50/50 p-3">
                        {pt && (
                          <p className={cn("mb-1.5 flex items-center gap-1 text-[11px] font-medium", pt.addressed ? "text-emerald-700" : "text-ink-400")}>
                            {pt.addressed ? <Check className="h-3.5 w-3.5" /> : <span className="text-xs">○</span>}
                            {pt.addressed ? "Addressed by the record" : "Not evidenced in the reviewed records"}
                            {pt.addressed && pt.support && <span className="font-normal text-ink-500">— {pt.support}</span>}
                          </p>
                        )}
                        <blockquote className="border-l-2 border-brand-300 pl-3 text-sm italic text-ink-800">“{g.quote}”</blockquote>
                        {g.relevance && (
                          <div className="mt-1.5 space-y-0.5 text-[11px]">
                            <p className="text-ink-600"><span className="font-medium">Supports:</span> {g.relevance.supports} · <span className="font-medium">{g.relevance.evidenceLabel}</span> (relevance {g.relevance.score}/100)</p>
                            <p className="text-ink-500"><span className="font-medium">Why relevant:</span> {g.relevance.whyRelevant}</p>
                            {g.relevance.limitations && <p className="text-amber-700"><span className="font-medium">Limitations:</span> {g.relevance.limitations}</p>}
                          </div>
                        )}
                        <div className="mt-1.5 flex items-start justify-between gap-2">
                          <div>
                            <p className="text-xs text-ink-500">
                              {g.url ? <a href={g.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">{g.title}</a> : <span className="font-medium text-ink-700">{g.title}</span>}
                            </p>
                            <p className="text-[11px] text-ink-400">{[g.authors, g.journal, g.year, g.pmid ? `PMID ${g.pmid}` : g.doi ? `doi:${g.doi}` : "", g.source].filter(Boolean).join(" · ")}</p>
                          </div>
                          {g.userProvided && (
                            <span className="flex shrink-0 items-center gap-1">
                              <Badge tone="brand">added by reviewer</Badge>
                              {canEdit && g.userInputId && <button className="text-ink-300 hover:text-red-600" title="Remove source" onClick={() => call(`/api/cases/${data.id}/soc/${g.userInputId}`, "DELETE", undefined, "soc")}><X className="h-3.5 w-3.5" /></button>}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Documented care corresponding to this item</p>
              {support.length ? (
                <ul className="mt-1 space-y-1">
                  {support.map((s, i) => (
                    <li key={i} className="text-xs text-ink-700">
                      <span className="font-medium text-ink-900">{s.date}</span>
                      {s.eventType && <span className="ml-1.5 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">{String(s.eventType).replace(/_/g, " ").toLowerCase()}</span>}
                      <span className="ml-1.5">{s.summary}</span>
                      {s.page != null && <span className="text-ink-400"> (p. {s.page})</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-ink-400">None identified in the reviewed records.</p>
              )}
            </div>

            {soc.gaps && <p className="mt-3 text-xs text-amber-700"><span className="font-medium">Gap:</span> {soc.gaps}</p>}

            {/* Reviewer notes (incorporated into the corpus) with removal. */}
            {Array.isArray(soc.userNotes) && soc.userNotes.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Reviewer notes (incorporated)</p>
                <ul className="mt-1 space-y-1">
                  {soc.userNotes.map((nn: AnyRec) => (
                    <li key={nn.id} className="flex items-start gap-2 text-xs text-ink-700">
                      <span className="mt-0.5 text-ink-300">•</span>
                      <span className="flex-1">{nn.text}</span>
                      {canEdit && <button className="text-ink-300 hover:text-red-600" title="Remove" onClick={() => call(`/api/cases/${data.id}/soc/${nn.id}`, "DELETE", undefined, "soc")}><X className="h-3.5 w-3.5" /></button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canEdit && <SocInputControls caseId={data.id} conditionName={c.name} call={call} />}

            <p className="mt-2 text-[11px] text-ink-400">The assessment is a preliminary, evidence-grounded aid; the final standard-of-care determination is the reviewing physician&apos;s.</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Future care ──────────────────────────────────────────────────────────────
// One-line rationale for the item's probability rating, woven from its own
// evidence/confidence fields (deterministic — mirrors the report's language).
function probabilityReasoning(it: AnyRec): string {
  const conf = it.confidence != null ? ` (confidence ${it.confidence}%)` : "";
  const basis = /case-specific|physician confirmation|confirmation required/i.test(it.evidenceStrength || "")
    ? "the clinical picture and standard-of-care practice"
    : (it.evidenceStrength || "standard-of-care guidance").toLowerCase();
  switch (it.probability) {
    case "PROBABLE":
      return `Probable — the need follows directly from the accepted diagnoses and is supported by ${basis}, making it more likely than not to be required${conf}.`;
    case "POSSIBLE":
      return `Possible — clinically foreseeable given the injury pattern but contingent on symptom progression or treatment response, so it is not established to a probability${conf}.`;
    case "SPECULATIVE":
      return `Speculative — a recognized contingency of the condition that the current record does not establish as more likely than not${it.missingSupport ? `; ${it.missingSupport.toLowerCase()}` : ""}${conf}.`;
    default:
      return `Not supported on the present record — retained only for completeness pending further documentation${conf}.`;
  }
}

// One-line read on how exposed the item is to a defense challenge, factoring in
// physician sign-off status and any lower-cost alternative.
function vulnerabilityReasoning(it: AnyRec): string {
  const md =
    it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED"
      ? "physician sign-off is on file, which blunts the challenge"
      : it.physicianStatus === "REJECTED"
        ? "the reviewing physician declined to endorse it, so it should be withdrawn"
        : "physician sign-off is still pending, which the defense will press on";
  switch (it.defenseVulnerability) {
    case "LOW":
      return `Low — a guideline-supported, standard-of-care item with strong record support; ${md}.`;
    case "MODERATE":
      return `Moderate — defensible but exposed on frequency, duration${it.lowerCostAlternative ? ", or the availability of a lower-cost alternative" : ""}; ${md}.`;
    default:
      return `High — ${it.probability === "SPECULATIVE" || it.probability === "NOT_SUPPORTED" ? "its speculative basis" : "its cost or evidentiary basis"} invites a defense challenge; ${md}.`;
  }
}

// The single strongest, honestly-citable source behind the item (the governing
// guideline/registry rather than a fabricated article — no hallucinated cites).
function mostAgreeableReference(it: AnyRec): string {
  const es = (it.evidenceStrength || "").toLowerCase();
  const spec = it.specialty || "the treating specialty";
  if (/odg|official disability/.test(es)) return "Official Disability Guidelines (ODG) — condition-specific treatment guideline.";
  if (/guideline|cpg|aaos|acr|\baan\b/.test(es)) return `Applicable specialty clinical practice guideline (${spec}).`;
  if (/registry|survivorship/.test(es)) return "National procedure registry / peer-reviewed survivorship data.";
  if (/literature|peer-review|studies|evidence/.test(es)) return "Peer-reviewed clinical literature for the condition.";
  if (/case-specific|physician|treating/.test(es)) return "Treating-physician documentation (case-specific standard of care).";
  return it.literatureSupport || "Accepted standard-of-care practice for the condition.";
}

// The complete physician-quality dossier for one recommendation (Refactor
// Sprint) — Future Care is now the clinical centerpiece; this replaces the
// separate Standard-of-Care view. Everything is synthesized by the shared pure
// engine from the case data already loaded (no extra fetch).
const CONF_TONE_D: Record<string, "green" | "amber" | "red" | "neutral"> = { High: "green", Moderate: "amber", Low: "red", Indeterminate: "neutral" };
function EvidenceBucket({ label, items }: { label: string; items: EvidenceItem[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.slice(0, 4).map((e, i) => (
          <li key={i} className="text-ink-700">{e.text}{e.source ? <span className="text-ink-400"> ({e.source})</span> : null}</li>
        ))}
      </ul>
    </div>
  );
}
function RecommendationDossierView({ dossier }: { dossier: RecommendationDossier }) {
  const se = dossier.supportingEvidence;
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Medical necessity</p>
        <p className="mt-1 leading-relaxed text-ink-800">{dossier.medicalNecessity}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Probability</span>
        <Badge tone={dossier.probability.percentage >= 51 ? "green" : "amber"}>{dossier.probability.percentage}%</Badge>
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Clinical confidence</span>
        <Badge tone={CONF_TONE_D[dossier.confidence.level]}>{dossier.confidence.level.toLowerCase()}</Badge>
      </div>
      <p className="text-ink-700">{dossier.probability.statement}</p>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Supporting clinical evidence</p>
        <div className="mt-1 grid gap-2 md:grid-cols-2">
          <EvidenceBucket label="Supporting diagnoses" items={se.diagnoses} />
          <EvidenceBucket label="Objective findings" items={se.objectiveFindings} />
          <EvidenceBucket label="Imaging" items={se.imaging} />
          <EvidenceBucket label="Examination findings" items={se.examination} />
          <EvidenceBucket label="Functional limitations" items={se.functionalLimitations} />
          <EvidenceBucket label="Prior treatment" items={se.priorTreatment} />
          <EvidenceBucket label="Treating-physician documentation" items={se.physicianDocumentation} />
          <EvidenceBucket label="Clinical guidelines" items={se.guidelines} />
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Supporting literature</p>
        {dossier.literature.length ? (
          <ol className="mt-1 space-y-1.5">
            {dossier.literature.map((l, i) => (
              <li key={i} className="text-ink-700">
                <span className="font-medium">{l.title}</span>{l.year ? ` (${l.year})` : ""} <span className="text-ink-400">· {l.studyType}</span>
                <p className="text-xs text-ink-500">Supports {l.supports}. {l.applicability}.{l.limitations ? ` Limitation: ${l.limitations}.` : ""}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-ink-400">Direct published literature specific to this recommendation is limited; it rests on the applicable clinical guidance and the treating record.</p>
        )}
      </div>
      {dossier.contradictoryEvidence.length > 0 && (
        <div><p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Contradictory evidence</p><ul className="mt-0.5 space-y-0.5">{dossier.contradictoryEvidence.slice(0, 4).map((t, i) => <li key={i} className="text-amber-800">{t}</li>)}</ul></div>
      )}
      {dossier.unknowns.length > 0 && (
        <div><p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Unknowns</p><ul className="mt-0.5 space-y-0.5">{dossier.unknowns.slice(0, 4).map((t, i) => <li key={i} className="text-ink-700">{t}</li>)}</ul></div>
      )}
      <div><p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Potential challenges</p><ul className="mt-0.5 space-y-0.5">{dossier.potentialChallenges.slice(0, 5).map((t, i) => <li key={i} className="text-ink-700">{t}</li>)}</ul></div>
      <p className="text-xs text-ink-500">{dossier.confidence.explanation}</p>
    </div>
  );
}
function dossierForItem(it: AnyRec, data: AnyRec): RecommendationDossier {
  const cond = (data.conditions ?? []).find((c: AnyRec) => c.id === it.conditionId) ?? null;
  const poss = data.sex === "FEMALE" ? "her" : data.sex === "MALE" ? "his" : "the patient's";
  const kase: DossierCase = { subject: data.clientName || "the patient", pronounPoss: poss, lifeExpectancyYears: data.lifeExpectancyYears ?? 40, adult: true };
  const provName = new Map((data.treatingProviders ?? []).map((p: AnyRec) => [p.id, `${p.name}${p.credentials ? `, ${p.credentials}` : ""}`]));
  const interviews = ((data.interviewFindings ?? []) as AnyRec[]).map((f) => ({ subject: f.subject, category: f.category, text: f.text, quote: f.quote, conditionId: f.conditionId, futureCareItemId: f.futureCareItemId, providerName: f.providerId ? provName.get(f.providerId) ?? null : null }));
  return buildRecommendationDossier(it as never, cond as DossierCondition | null, (data.chronologyEvents ?? []) as DossierChronoEvent[], kase, interviews as never);
}

function FutureCarePanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline to generate future care recommendations.</Empty>;

  // Organize by care category group; chips allow selective viewing per group.
  const groups = CARE_GROUPS.map((g) => ({ ...g, items: data.futureCareItems.filter((it: AnyRec) => g.cats.includes(it.category)) })).filter((g) => g.items.length > 0);
  const shown = filter === "All" ? groups : groups.filter((g) => g.title === filter);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" count={data.futureCareItems.length} active={filter === "All"} onClick={() => setFilter("All")} />
        {groups.map((g) => (
          <FilterChip key={g.title} label={g.title} count={g.items.length} icon={g.icon} active={filter === g.title} onClick={() => setFilter(g.title)} />
        ))}
      </div>

      {shown.map((g) => (
        <div key={g.title}>
          <div className="mb-2 flex items-center gap-2 border-b border-ink-200 pb-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700"><g.icon className="h-4.5 w-4.5" /></div>
            <h3 className="text-sm font-semibold text-ink-900">{g.title}</h3>
            <span className="text-xs text-ink-400">{g.items.length} item{g.items.length === 1 ? "" : "s"}</span>
            <span className="ml-auto text-xs font-medium text-brand-800">{formatMoney(g.items.reduce((s: number, it: AnyRec) => s + it.presentValue, 0))} PV</span>
          </div>
          <div className="space-y-2">
      {g.items.map((it: AnyRec) => (
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
            <div className="mt-3 border-t border-ink-100 pt-3">
              <RecommendationDossierView dossier={dossierForItem(it, data)} />
              <div className="mt-3 border-t border-ink-100 pt-2 text-sm text-ink-600">
                <span className="text-xs font-medium text-ink-500">Cost basis: </span>{formatMoney(it.unitCost)}/unit · {it.pricingSource} · range {formatMoney(it.lowCost)}–{formatMoney(it.highCost)}
                {it.lowerCostAlternative ? <> · <span className="text-xs font-medium text-ink-500">Alternative: </span>{it.lowerCostAlternative}</> : null}
              </div>
              {canEdit && (
                <div className="mt-2 flex flex-wrap gap-2 pt-1">
                  <InlineProbability item={it} caseId={data.id} call={call} />
                  <button className="btn-outline py-1 text-xs" onClick={async () => { const v = prompt("Frequency per year", String(it.frequencyPerYear)); if (v != null) await call(`/api/cases/${data.id}/future-care/${it.id}`, "PATCH", { frequencyPerYear: Number(v) }); }}>Edit Frequency</button>
                  <button className="btn-outline py-1 text-xs" onClick={async () => { const v = prompt("Unit cost (USD)", String(it.unitCost)); if (v != null) await call(`/api/cases/${data.id}/future-care/${it.id}`, "PATCH", { unitCost: Number(v) }); }}>Edit Unit Cost</button>
                  <button className="py-1 text-xs font-medium text-red-600 hover:underline" onClick={async () => { if (confirm("Remove this item?")) await call(`/api/cases/${data.id}/future-care/${it.id}`, "DELETE"); }}>Remove</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
          </div>
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
  const [open, setOpen] = useState<string | null>(null);
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline to project costs.</Empty>;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Editable Assumptions</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <NumField label="Life Expectancy (Yrs)" value={a.lifeExpectancyYears} step={0.5} disabled={!canEdit} onChange={(v) => setA({ ...a, lifeExpectancyYears: v })} />
          <NumField label="Discount Rate" value={a.discountRate} step={0.005} disabled={!canEdit} onChange={(v) => setA({ ...a, discountRate: v })} pct />
          <NumField label="Medical Inflation" value={a.medicalInflation} step={0.005} disabled={!canEdit} onChange={(v) => setA({ ...a, medicalInflation: v })} pct />
          <NumField label="Geographic Factor" value={a.geographicFactor} step={0.05} disabled={!canEdit} onChange={(v) => setA({ ...a, geographicFactor: v })} />
        </div>
        {canEdit && (
          <button
            className="btn-primary mt-4"
            onClick={() => {
              // P3 — assumption changes are ledgered with an optional reason.
              const reason = prompt("Reason for the assumption change (optional — recorded in the audit ledger):") ?? undefined;
              call(`/api/cases/${data.id}`, "PATCH", { ...a, assumptionReason: reason || undefined }, "recompute");
            }}
          >
            Recompute Costs
          </button>
        )}
        {Array.isArray(data.assumptionChanges) && data.assumptionChanges.length > 0 && (
          <div className="mt-4 border-t border-ink-100 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Assumption history</p>
            <ul className="mt-1 space-y-0.5">
              {data.assumptionChanges.map((ch: AnyRec) => (
                <li key={ch.id} className="text-xs text-ink-600">
                  {formatDate(ch.createdAt)} — {ch.field}: {ch.originalValue ?? "—"} → {ch.revisedValue ?? "—"}{ch.reason ? ` (${ch.reason})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr><th className="px-4 py-2 font-medium">Service</th><th className="px-4 py-2 font-medium">Annual</th><th className="px-4 py-2 font-medium">Low</th><th className="px-4 py-2 font-medium">Lifetime</th><th className="px-4 py-2 font-medium">Present Value</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.futureCareItems.map((it: AnyRec) => (
              <Fragment key={it.id}>
                <tr>
                  <td className="px-4 py-2 text-ink-800">{it.service}</td>
                  <td className="px-4 py-2 text-ink-600">{formatMoney(it.annualCost)}</td>
                  <td className="px-4 py-2 text-ink-500">{formatMoney(it.lowCost)}</td>
                  <td className="px-4 py-2 text-ink-600">{formatMoney(it.lifetimeCost)}</td>
                  <td className="px-4 py-2 font-medium text-brand-800">{formatMoney(it.presentValue)}</td>
                  <td className="px-4 py-2 text-right"><button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? "Hide" : "Details"}</button></td>
                </tr>
                {open === it.id && (
                  <tr className="bg-ink-50/60">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                        <p><span className="font-medium text-ink-500">Unit cost:</span> {formatMoney(it.unitCost)} {it.cptCode ? `· CPT ${it.cptCode}` : ""}</p>
                        <p><span className="font-medium text-ink-500">Frequency & duration:</span> {it.frequencyPerYear}/yr {it.isLifetime ? `× ${a.lifeExpectancyYears.toFixed(1)} yrs (life)` : it.durationYears ? `× ${it.durationYears} yrs` : "one-time"}</p>
                        <p><span className="font-medium text-ink-500">Pricing basis / source:</span> {it.pricingSource || "UCR benchmark"}</p>
                        <p><span className="font-medium text-ink-500">Cost range (low–high):</span> {formatMoney(it.lowCost)} – {formatMoney(it.highCost)}</p>
                        <p className="sm:col-span-2"><span className="font-medium text-ink-500">Evidence basis:</span> {it.evidenceStrength || "—"}{it.literatureSupport ? ` — ${it.literatureSupport}` : ""}</p>
                        <p><span className="font-medium text-ink-500">Start / trigger:</span> {it.startTrigger || "From date of report"}</p>
                        <p><span className="font-medium text-ink-500">Physician review:</span> {it.physicianStatus === "APPROVED" ? "Physician approved" : it.physicianStatus === "MODIFIED" ? "Physician approved with modification" : it.physicianStatus === "REJECTED" ? "Physician rejected — excluded from totals" : "Awaiting physician review"}</p>
                        <p><span className="font-medium text-ink-500">Probability:</span> {String(it.probability).toLowerCase()}{it.probability === "SPECULATIVE" || it.probability === "NOT_SUPPORTED" ? " — disclosed, not totaled" : ""}</p>
                        <p><span className="font-medium text-ink-500">Category:</span> {String(it.category).replace(/_/g, " ").toLowerCase()}</p>
                        <p className="sm:col-span-2"><span className="font-medium text-ink-500">Economic assumptions:</span> discount {(a.discountRate * 100).toFixed(1)}%, medical inflation {(a.medicalInflation * 100).toFixed(1)}%, geographic factor {a.geographicFactor.toFixed(2)} → present value {formatMoney(it.presentValue)}.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            <tr className="bg-ink-50 font-bold"><td className="px-4 py-2">Total</td><td /><td /><td className="px-4 py-2">{formatMoney(totals.totalLifetime)}</td><td className="px-4 py-2 text-brand-800">{formatMoney(totals.totalPresentValue)}</td><td /></tr>
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
// Contested-points review: each point states the argument one side will make,
// cites its source, and provides the opposing side's counter-argument with its
// own supporting source.
function ReviewsPanel({ points, hasPlan }: { points: AnyRec[]; hasPlan: boolean }) {
  const [filter, setFilter] = useState<"ALL" | "DEFENSE" | "PLAINTIFF">("ALL");
  if (!hasPlan) return <Empty>Run the AI pipeline to generate the contested-points review.</Empty>;
  if (!points.length) return <Empty>No contested points identified — the plan is cleanly supported.</Empty>;

  const defenseN = points.filter((p) => p.side === "DEFENSE").length;
  const plaintiffN = points.filter((p) => p.side === "PLAINTIFF").length;
  const shown = filter === "ALL" ? points : points.filter((p) => p.side === filter);

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">Each contested point states the argument one side will make with its source, and the opposing side&apos;s counter backed by source and/or literature.</p>
      <div className="flex flex-wrap gap-2">
        <FilterChip label="All points" count={points.length} active={filter === "ALL"} onClick={() => setFilter("ALL")} />
        <FilterChip label="Defense raises" count={defenseN} active={filter === "DEFENSE"} onClick={() => setFilter("DEFENSE")} />
        <FilterChip label="Plaintiff raises" count={plaintiffN} active={filter === "PLAINTIFF"} onClick={() => setFilter("PLAINTIFF")} />
      </div>

      <div className="space-y-3">
        {shown.map((p) => {
          const raiser = p.side === "PLAINTIFF" ? "Plaintiff" : "Defense";
          const counter = p.side === "PLAINTIFF" ? "Defense" : "Plaintiff";
          return (
            <div key={p.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink-900">{p.category}</span>
                <Badge tone={VULN_TONE[p.vulnerability]}>{p.vulnerability.toLowerCase()}</Badge>
              </div>

              {/* Argument */}
              <div className="mt-2 rounded-lg border-l-4 border-amber-300 bg-amber-50/60 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">{raiser} argues</p>
                <p className="mt-0.5 text-sm text-ink-800">{p.description}</p>
                {p.sourceRef && <p className="mt-1 text-xs text-ink-500"><span className="font-medium">Source:</span> {p.sourceRef}</p>}
              </div>

              {/* Counter */}
              {p.counterArgument && (
                <div className="mt-2 rounded-lg border-l-4 border-emerald-300 bg-emerald-50/60 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">{counter} counter</p>
                  <p className="mt-0.5 text-sm text-ink-800">{p.counterArgument}</p>
                  {p.counterSource && <p className="mt-1 text-xs text-ink-500"><span className="font-medium">Support:</span> {p.counterSource}</p>}
                  {p.counterCitation && <p className="mt-1 text-xs text-emerald-800"><span className="font-medium">Citation:</span> {p.counterCitation}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Physician ────────────────────────────────────────────────────────────────
function PhysicianPanel({ data, canReview, call }: { data: AnyRec; canReview: boolean; call: any }) {
  const [open, setOpen] = useState<string | null>(null);
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline first to build the physician review packet.</Empty>;

  const pending = data.futureCareItems.filter((i: AnyRec) => i.physicianStatus === "PENDING").length;

  function modify(it: AnyRec) {
    const info = prompt(`Add information for "${it.service}". The paraphrased summary will be updated to include it.`);
    if (info == null) return;
    call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", { status: "MODIFIED", note: info });
  }

  function approveAll() {
    if (!confirm(`Approve all ${pending} pending item${pending === 1 ? "" : "s"}? Each will carry physician sign-off and be included in the report.`)) return;
    call(`/api/cases/${data.id}/future-care/accept-all`, "POST", undefined, "op");
  }

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-ink-600">
        <span className="min-w-0 flex-1">
          Physician review packet — {canReview ? "every item stays Pending until you designate it. Review the paraphrased summary, then approve, reject, or modify by adding information (the summary updates automatically). Use Approve All only when you intend to sign off on the whole packet." : "read-only: your role cannot sign off on medical necessity."}
        </span>
        {canReview && pending > 0 && (
          <button className="btn-primary shrink-0 py-1.5 text-xs" onClick={approveAll}>Approve All ({pending})</button>
        )}
      </div>
      {data.futureCareItems.map((it: AnyRec) => (
        <div key={it.id} className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-medium text-ink-900">{it.service}</span>
              <Badge tone={PHYS_TONE[it.physicianStatus]} className="ml-2">{it.physicianStatus.toLowerCase()}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen(open === it.id ? null : it.id)}>
                {open === it.id ? "Hide summary" : "Summary"}
              </button>
              {canReview && (
                <>
                  <button className="btn-outline py-1 text-xs" onClick={() => call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", { status: "APPROVED", note: it.physicianNote || undefined })}>Approve</button>
                  <button className="btn-outline py-1 text-xs" onClick={() => modify(it)}>Modify</button>
                  <button className="py-1 text-xs font-medium text-red-600 hover:underline" onClick={() => { const n = prompt("Reason for rejection"); if (n != null) call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", { status: "REJECTED", note: n }); }}>Reject</button>
                </>
              )}
            </div>
          </div>

          {/* Expandable paraphrased summary of the point being made */}
          {open === it.id && (
            <div className="mt-3 rounded-lg bg-ink-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Paraphrased summary</p>
              <p className="mt-1 text-sm text-ink-800">{it.physicianSummary || it.rationale || "No summary available."}</p>
              {it.physicianNote && (
                <p className="mt-2 text-xs text-ink-500"><span className="font-medium">Physician note on file:</span> {it.physicianNote}</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Precedents (comparable finalized LCPs, ranked by likeness) ───────────────
const injuryLabel = (s?: string | null) => (s || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
function PrecedentsPanel({ precedents, data }: { precedents: AnyRec[]; data: AnyRec }) {
  if (!precedents.length) {
    return <Empty>No precedents in the firm library yet. Add finalized LCPs in Firm Management → LCP Precedent Library, then return here to see the closest comparables to this case.</Empty>;
  }
  const barColor = (n: number) => (n >= 70 ? "bg-emerald-500" : n >= 45 ? "bg-amber-500" : "bg-ink-300");
  const numColor = (n: number) => (n >= 70 ? "text-emerald-600" : n >= 45 ? "text-amber-600" : "text-ink-400");
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">
        Finalized LCPs from your firm library ranked by <span className="font-medium text-ink-700">likeness</span> to {data.clientName}&apos;s case — the closest precedents to compare against, benchmark, and cite.
      </p>
      <div className="space-y-3">
        {precedents.map((p) => {
          const m = p.match || { likeness: 0, factors: [] };
          const hits = (m.factors || []).filter((f: AnyRec) => f.got > 0).sort((a: AnyRec, b: AnyRec) => b.got - a.got);
          const misses = (m.factors || []).filter((f: AnyRec) => f.got === 0);
          return (
            <div key={p.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">{p.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {p.injurySpecialty && <Badge tone="brand">{injuryLabel(p.injurySpecialty)}</Badge>}
                    {p.icd10Code && <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">{p.icd10Code}</span>}
                    {p.jurisdiction && <span className="text-xs text-ink-500">{p.jurisdiction}</span>}
                  </div>
                  {p.diagnosis && <p className="mt-1 text-xs text-ink-600">{p.diagnosis}{p.mechanism ? ` · ${String(p.mechanism).toLowerCase()}` : ""}</p>}
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-500">
                    {p.age != null && <span>age {p.age}</span>}
                    {p.presentValue != null && <span>PV {formatMoney(p.presentValue)}</span>}
                    {p.lifetimeCost != null && <span>lifetime {formatMoney(p.lifetimeCost)}</span>}
                    {p.outcome && <span className="italic">{p.outcome}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={cn("text-2xl font-bold leading-none", numColor(m.likeness))}>{m.likeness}%</div>
                  <div className="text-[10px] uppercase tracking-wide text-ink-400">likeness</div>
                </div>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                <div className={cn("h-full rounded-full transition-all", barColor(m.likeness))} style={{ width: `${m.likeness}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {hits.map((f: AnyRec, i: number) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800"><Check className="h-3 w-3" />{f.label}: {f.note}</span>
                ))}
                {misses.map((f: AnyRec, i: number) => (
                  <span key={`m${i}`} className="rounded-full bg-ink-50 px-2 py-0.5 text-[11px] text-ink-400">{f.label}: {f.note}</span>
                ))}
              </div>
              <div className="mt-3">
                <a href={`/api/precedents/${p.id}/view`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                  <ExternalLink className="h-3.5 w-3.5" /> Open precedent LCP
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
const ROLE_LABEL_SHORT: Record<string, string> = { ADMIN: "admin", PLANNER: "planner", PHYSICIAN_REVIEWER: "physician" };

// ── Treating Providers & Interviews (EPIC-011) ───────────────────────────────
const INTERVIEW_CATEGORIES = ["Pain", "Headache", "Sleep", "Cognition", "Mood / Psychological", "Mobility / Gait", "ADLs / Self-care", "Vision", "Bladder / Bowel", "Medications", "Work / Vocational", "Sensory / Neurologic", "Other"];
const PROVIDER_STATUS_TONE: Record<string, "green" | "amber" | "neutral"> = { CONFIRMED: "green", SUGGESTED: "amber", DISMISSED: "neutral" };

// A small editor for one interview finding — categorized or free-text, with an
// optional verbatim quote and date. Used for both patient and provider.
function InterviewEditor({ onAdd }: { onAdd: (f: { category?: string; text: string; quote?: string; interviewDate?: string }) => void }) {
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [quote, setQuote] = useState("");
  const [date, setDate] = useState("");
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-ink-50/70 p-3">
      <div className="flex flex-wrap gap-2">
        <select className="input w-52 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Free-text (no category)</option>
          {INTERVIEW_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" className="input w-40 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <textarea className="input w-full text-sm" rows={2} placeholder="Finding (what the interview revealed)…" value={text} onChange={(e) => setText(e.target.value)} />
      <input className="input w-full text-sm" placeholder="Verbatim quote (optional) — the patient's/provider's own words" value={quote} onChange={(e) => setQuote(e.target.value)} />
      <button className="btn-primary py-1.5 text-xs" disabled={!text.trim()} onClick={() => { onAdd({ category: category || undefined, text: text.trim(), quote: quote.trim() || undefined, interviewDate: date || undefined }); setText(""); setQuote(""); setCategory(""); setDate(""); }}>Add finding</button>
    </div>
  );
}
function FindingList({ findings, onDelete, canEdit }: { findings: AnyRec[]; onDelete: (id: string) => void; canEdit: boolean }) {
  if (!findings.length) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {findings.map((f) => (
        <li key={f.id} className="flex items-start gap-2 rounded-lg bg-white p-2 text-sm ring-1 ring-ink-100">
          {f.category && <span className="mt-0.5 shrink-0 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">{f.category}</span>}
          <span className="flex-1">
            <span className="text-ink-800">{f.text}</span>
            {f.quote && <span className="mt-0.5 block italic text-ink-500">“{f.quote}”</span>}
            {f.interviewDate && <span className="text-[11px] text-ink-400"> — {formatDate(f.interviewDate)}</span>}
          </span>
          {canEdit && <button className="text-ink-300 hover:text-red-600" title="Remove" onClick={() => onDelete(f.id)}><X className="h-3.5 w-3.5" /></button>}
        </li>
      ))}
    </ul>
  );
}

function TreatingProvidersPanel({ data, canEdit, call }: { data: AnyRec; canEdit: boolean; call: any }) {
  const [providers, setProviders] = useState<AnyRec[] | null>(null);
  const [patient, setPatient] = useState<AnyRec[]>([]);
  const [openProvider, setOpenProvider] = useState<string | null>(null);

  async function loadProviders(refresh = false) {
    const res = await fetch(`/api/cases/${data.id}/providers${refresh ? "?refresh=1" : ""}`);
    if (res.ok) setProviders((await res.json()).providers ?? []);
  }
  async function loadPatient() {
    const res = await fetch(`/api/cases/${data.id}/interviews?subject=PATIENT`);
    if (res.ok) setPatient((await res.json()).findings ?? []);
  }
  useEffect(() => { loadProviders(true); loadPatient(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [data.id]);

  async function addFinding(body: AnyRec, after: () => void) {
    const res = await fetch(`/api/cases/${data.id}/interviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) after();
  }
  async function delFinding(id: string, after: () => void) {
    const res = await fetch(`/api/cases/${data.id}/interviews/${id}`, { method: "DELETE" });
    if (res.ok) after();
  }
  async function patchProvider(id: string, body: AnyRec) {
    await fetch(`/api/cases/${data.id}/providers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    loadProviders();
  }

  const active = (providers ?? []).filter((p) => p.status !== "DISMISSED");
  const dismissed = (providers ?? []).filter((p) => p.status === "DISMISSED");

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-500">
        The providers affiliated with {data.clientName}&apos;s care, drawn from the reviewed records. Confirm the treating team, record what patient and provider interviews revealed (categorized or free text, with quotes), and it is woven into the generated report.
      </p>

      {/* Patient interview */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Patient Interview</h3>
        <p className="text-xs text-ink-500">Current complaints in the patient&apos;s own words. These populate the report&apos;s Current Complaints section and support the relevant recommendations.</p>
        <FindingList findings={patient} canEdit={canEdit} onDelete={(id) => delFinding(id, loadPatient)} />
        {canEdit && <InterviewEditor onAdd={(f) => addFinding({ subject: "PATIENT", ...f }, loadPatient)} />}
      </div>

      {/* Treating provider roster */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink-900">Treating Providers {providers && <span className="text-xs font-normal text-ink-400">({active.length})</span>}</h3>
          {canEdit && <button className="btn-outline px-3 py-1.5 text-xs" onClick={() => loadProviders(true)}>Refresh from records</button>}
        </div>
        {providers === null && <p className="mt-2 text-sm text-ink-400">Loading…</p>}
        {providers && active.length === 0 && <p className="mt-2 text-sm text-ink-400">No providers extracted yet — run the pipeline or add one below.</p>}
        <div className="mt-3 space-y-2">
          {active.map((p) => {
            const srcs = Array.isArray(p.sourceDocumentIds) ? p.sourceDocumentIds : [];
            return (
              <div key={p.id} className="rounded-lg ring-1 ring-ink-100">
                <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <span className="font-medium text-ink-900">{p.name}</span>
                    {p.credentials && <span className="ml-1 text-ink-500">, {p.credentials}</span>}
                    <Badge tone={PROVIDER_STATUS_TONE[p.status]} className="ml-2">{p.status.toLowerCase()}</Badge>
                    <p className="text-xs text-ink-500">{[p.specialty, p.facility].filter(Boolean).join(" · ") || "specialty/facility not parsed"}{srcs.length ? ` · ${srcs.length} source record${srcs.length === 1 ? "" : "s"}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {canEdit && p.status !== "CONFIRMED" && <button className="btn-outline py-1 text-xs" onClick={() => patchProvider(p.id, { status: "CONFIRMED" })}>Confirm</button>}
                    {canEdit && <button className="py-1 text-xs text-ink-400 hover:text-red-600" onClick={() => patchProvider(p.id, { status: "DISMISSED" })}>Dismiss</button>}
                    <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpenProvider(openProvider === p.id ? null : p.id)}>{openProvider === p.id ? "Hide" : `Interview (${(p.interviewFindings ?? []).length})`}</button>
                  </div>
                </div>
                {openProvider === p.id && (
                  <div className="border-t border-ink-100 p-3">
                    <FindingList findings={p.interviewFindings ?? []} canEdit={canEdit} onDelete={(id) => delFinding(id, () => loadProviders())} />
                    {canEdit && <InterviewEditor onAdd={(f) => addFinding({ subject: "PROVIDER", providerId: p.id, ...f }, () => loadProviders())} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {canEdit && <AddProviderInline data={data} onAdded={() => loadProviders()} />}
        {dismissed.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-ink-400">{dismissed.length} dismissed</summary>
            <ul className="mt-1 space-y-1">
              {dismissed.map((p) => (
                <li key={p.id} className="flex items-center justify-between text-xs text-ink-500">
                  <span>{p.name}{p.credentials ? `, ${p.credentials}` : ""}</span>
                  {canEdit && <button className="text-brand-700 hover:underline" onClick={() => patchProvider(p.id, { status: "SUGGESTED" })}>Restore</button>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
function AddProviderInline({ data, onAdded }: { data: AnyRec; onAdded: () => void }) {
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [credentials, setCredentials] = useState("");
  const [specialty, setSpecialty] = useState("");
  if (!show) return <button className="mt-3 text-xs font-medium text-brand-700 hover:underline" onClick={() => setShow(true)}>+ Add provider</button>;
  return (
    <div className="mt-3 flex flex-wrap gap-2 rounded-lg bg-ink-50/70 p-3">
      <input className="input w-48 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input w-28 text-sm" placeholder="Credentials" value={credentials} onChange={(e) => setCredentials(e.target.value)} />
      <input className="input w-40 text-sm" placeholder="Specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
      <button className="btn-primary py-1.5 text-xs" disabled={name.trim().length < 2} onClick={async () => { await fetch(`/api/cases/${data.id}/providers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), credentials: credentials || undefined, specialty: specialty || undefined }) }); setShow(false); setName(""); setCredentials(""); setSpecialty(""); onAdded(); }}>Add</button>
      <button className="py-1.5 text-xs text-ink-400" onClick={() => setShow(false)}>Cancel</button>
    </div>
  );
}

// ── Evidence Explorer (P2) ────────────────────────────────────────────────────
// Source-backed provenance for any diagnosis or recommendation: why it exists,
// what supports it, what weakens it, what remains unknown, and what approval is
// still required. Everything shown is lifted from the materialized evidence
// graph and the case data — never hidden reasoning.
function EvidencePanel({ data }: { data: AnyRec }) {
  const [links, setLinks] = useState<AnyRec[] | null>(null);
  const [sel, setSel] = useState<string>("");
  const [rebuilding, setRebuilding] = useState(false);
  async function load(method: "GET" | "POST" = "GET") {
    if (method === "POST") setRebuilding(true);
    try {
      const res = await fetch(`/api/cases/${data.id}/evidence`, { method });
      if (res.ok) setLinks((await res.json()).links ?? []);
    } finally {
      setRebuilding(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [data.id]);

  const conditions: AnyRec[] = data.conditions ?? [];
  const items: AnyRec[] = data.futureCareItems ?? [];
  const condById = useMemo(() => new Map(conditions.map((c: AnyRec) => [c.id, c])), [conditions]);
  const itemById = useMemo(() => new Map(items.map((i: AnyRec) => [i.id, i])), [items]);
  const [selType, selId] = sel ? sel.split(":") : [null, null];
  const linksFor = (type: string, id: string) => (links ?? []).filter((l) => l.fromType === type && l.fromId === id);

  // Assemble the five-part, source-backed explanation for the selection.
  const entity = selType === "condition" ? condById.get(selId!) : selType === "futureCareItem" ? itemById.get(selId!) : null;
  const own = entity ? linksFor(selType!, selId!) : [];
  // A recommendation inherits its mapped diagnosis's evidence for display.
  const mappedCondId = selType === "futureCareItem" ? own.find((l) => l.kind === "REC_DIAGNOSIS")?.toId : null;
  const mappedCond = mappedCondId ? condById.get(mappedCondId) : null;
  const inherited = mappedCondId ? linksFor("condition", mappedCondId) : [];
  const supports = [...own, ...inherited].filter((l) => l.kind === "DIAGNOSIS_EVIDENCE" || l.kind === "REC_LITERATURE" || l.kind === "DIAGNOSIS_GUIDELINE");
  const weakens = [...own, ...inherited].filter((l) => l.kind === "CONTRADICTS");
  const unknown = selType === "condition" ? entity?.missingInfo : entity?.missingSupport;
  const approvalNote =
    selType === "futureCareItem"
      ? entity?.physicianStatus === "APPROVED" || entity?.physicianStatus === "MODIFIED"
        ? `Physician ${entity.physicianStatus === "MODIFIED" ? "approved with modification" : "approved"}${entity.physicianNote ? ` — “${entity.physicianNote}”` : ""}.`
        : entity?.physicianStatus === "REJECTED"
          ? "Physician rejected — excluded from the plan totals."
          : "Awaiting physician review; not represented as approved."
      : entity?.physicianConfirmed
        ? "Diagnosis confirmed on physician review."
        : "Diagnosis pending physician confirmation.";

  const KIND_LABEL: Record<string, string> = { DIAGNOSIS_EVIDENCE: "Record evidence", REC_LITERATURE: "Literature", DIAGNOSIS_GUIDELINE: "Clinical guidance", CONTRADICTS: "Contrary evidence" };

  // Structured confidence (Clinical Evidence Sprint) — derived from record
  // quality, objective findings, physician support, guideline support,
  // literature quality, consistency, and missing information.
  const bestLit: number[] = supports
    .filter((l) => l.kind === "REC_LITERATURE" || l.kind === "DIAGNOSIS_GUIDELINE")
    .map((l): number | null => (l.meta?.evidenceLabel === "Clinical practice guideline" ? 1 : l.meta?.evidenceLabel === "Consensus statement" ? 2 : l.meta?.evidenceLabel ? 5 : l.kind === "DIAGNOSIS_GUIDELINE" ? 1 : null))
    .filter((n): n is number => n !== null);
  const confidence = entity
    ? structuredConfidence({
        recordEvidenceCount: [...own, ...inherited].filter((l) => l.kind === "DIAGNOSIS_EVIDENCE").length,
        hasObjectiveFindings: !!(selType === "condition" ? entity.objectiveEvidence : mappedCond?.objectiveEvidence),
        physicianSupport: selType === "futureCareItem" ? entity.physicianStatus === "APPROVED" || entity.physicianStatus === "MODIFIED" : !!entity.physicianConfirmed,
        guidelineSupport: supports.some((l) => l.kind === "DIAGNOSIS_GUIDELINE"),
        bestEvidenceLevel: bestLit.length ? Math.min(...bestLit) : null,
        hasContradictoryEvidence: weakens.length > 0,
        hasMissingInfo: !!unknown,
      })
    : null;
  const CONF_TONE: Record<string, "green" | "amber" | "red" | "neutral"> = { High: "green", Moderate: "amber", Low: "red", Indeterminate: "neutral" };

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Evidence Explorer</h3>
            <p className="text-xs text-ink-500">Select a diagnosis or recommendation to see its source-backed provenance: why it exists, what supports it, what weakens it, what remains unknown, and what approval is still required.</p>
          </div>
          <button className="btn-outline px-3 py-1.5 text-xs" disabled={rebuilding} onClick={() => load("POST")}>
            {rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Rebuild graph
          </button>
        </div>
        <select className="input mt-3 w-full max-w-xl" value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">Select an item…</option>
          <optgroup label="Diagnoses">
            {conditions.map((c: AnyRec) => <option key={c.id} value={`condition:${c.id}`}>{c.name}</option>)}
          </optgroup>
          <optgroup label="Future-care recommendations">
            {items.map((i: AnyRec) => <option key={i.id} value={`futureCareItem:${i.id}`}>{i.service}</option>)}
          </optgroup>
        </select>
        {links !== null && links.length === 0 && <p className="mt-2 text-xs text-amber-700">No evidence graph is stored for this case yet — run “Rebuild graph” (or regenerate the plan).</p>}
      </div>

      {entity && (
        <div className="card space-y-4 p-5">
          {confidence && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Confidence</span>
              <Badge tone={CONF_TONE[confidence.level]}>{confidence.level.toLowerCase()}</Badge>
              <span className="text-[11px] text-ink-400">{confidence.factors.join(" · ")}</span>
            </div>
          )}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Why this item exists</h4>
            <p className="mt-1 text-sm text-ink-800">
              {selType === "condition"
                ? `${entity.name} is on the causation map as ${String(entity.relatedness).replace(/_/g, " ").toLowerCase()}. ${entity.reasoning ?? ""}`
                : `${entity.service} is recommended${mappedCond ? ` for ${mappedCond.name}` : ""}. ${entity.rationale ?? ""}`}
            </p>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">What supports it</h4>
            {supports.length === 0 && <p className="mt-1 text-sm text-ink-500">No structured support links; see the record chronology.</p>}
            <ul className="mt-1 space-y-2">
              {supports.map((l) => (
                <li key={l.id} className="rounded-lg bg-ink-50/70 p-3 text-xs">
                  <span className="mr-2 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">{KIND_LABEL[l.kind]}</span>
                  {l.quote && <span className="italic text-ink-800">“{l.quote}” </span>}
                  <span className="text-ink-500">
                    {l.kind === "DIAGNOSIS_EVIDENCE" && `— ${l.meta?.filename ?? "record"}${l.page ? `, p. ${l.page}` : ""}`}
                    {(l.kind === "REC_LITERATURE" || l.kind === "DIAGNOSIS_GUIDELINE") && `— ${l.meta?.title ?? ""}${l.meta?.year ? ` (${l.meta.year})` : ""}${l.meta?.pmid ? ` · PMID ${l.meta.pmid}` : ""}${l.meta?.evidenceLabel ? ` · ${l.meta.evidenceLabel}` : ""}`}
                  </span>
                  {(l.kind === "REC_LITERATURE" || l.kind === "DIAGNOSIS_GUIDELINE") && l.meta?.supports && (
                    <p className="mt-1 text-[11px] text-ink-600"><span className="font-medium">Supports the claim:</span> {l.meta.supports}.</p>
                  )}
                  {(l.kind === "REC_LITERATURE" || l.kind === "DIAGNOSIS_GUIDELINE") && l.meta?.whyRelevant && (
                    <p className="text-[11px] text-ink-500"><span className="font-medium">Why relevant:</span> {l.meta.whyRelevant}.</p>
                  )}
                  {(l.kind === "REC_LITERATURE" || l.kind === "DIAGNOSIS_GUIDELINE") && l.meta?.limitations && (
                    <p className="text-[11px] text-amber-700"><span className="font-medium">Limitations:</span> {l.meta.limitations}.</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Supporting objective findings</h4>
            <p className="mt-1 text-sm text-ink-700">{(selType === "condition" ? entity.objectiveEvidence : mappedCond?.objectiveEvidence) || "No objective findings recorded for this item."}</p>
          </div>
          {selType === "futureCareItem" && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Supporting physician documentation</h4>
              <p className="mt-1 text-sm text-ink-700">
                {entity.physicianNote
                  ? `Physician note on file: “${entity.physicianNote}”`
                  : entity.physicianStatus === "APPROVED" || entity.physicianStatus === "MODIFIED"
                    ? "Physician review action on file (no note)."
                    : "No physician documentation yet — awaiting review."}
              </p>
            </div>
          )}
          {selType === "futureCareItem" && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Supporting cost &amp; coding</h4>
              <p className="mt-1 text-sm text-ink-700">
                {entity.cptCode ? `CPT ${entity.cptCode} · ` : "Non-code-specific (bundled) · "}
                {formatMoney(entity.unitCost)} per unit · {entity.pricingSource || "UCR benchmark"} · PV {formatMoney(entity.presentValue)}
              </p>
            </div>
          )}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">What weakens it</h4>
            {weakens.length ? (
              weakens.map((l) => <p key={l.id} className="mt-1 text-sm text-amber-800">{l.quote}</p>)
            ) : (
              <p className="mt-1 text-sm text-ink-500">No contradictory evidence identified in the reviewed records.</p>
            )}
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">What remains unknown</h4>
            <p className="mt-1 text-sm text-ink-700">{unknown || "No outstanding evidence gaps recorded for this item."}</p>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">What approval is still required</h4>
            <p className="mt-1 text-sm text-ink-700">{approvalNote}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Version comparison (P3) ───────────────────────────────────────────────────
// Compare any two exported report versions: records, chronology, diagnoses,
// recommendations, frequencies/durations/codes/pricing, literature, physician
// review, totals, and assumptions.
function VersionCompareCard({ caseId }: { caseId: string }) {
  const [snapshots, setSnapshots] = useState<AnyRec[]>([]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [diff, setDiff] = useState<AnyRec | null>(null);
  useEffect(() => {
    fetch(`/api/cases/${caseId}/snapshots`).then(async (r) => { if (r.ok) setSnapshots((await r.json()).snapshots ?? []); });
  }, [caseId]);
  useEffect(() => {
    if (!a || !b || a === b) { setDiff(null); return; }
    fetch(`/api/cases/${caseId}/snapshots?a=${a}&b=${b}`).then(async (r) => { if (r.ok) setDiff((await r.json()).diff); });
  }, [a, b, caseId]);
  if (snapshots.length < 2) return null; // nothing to compare yet
  const money = (n: number) => "$" + Math.round(n).toLocaleString();
  const line = (label: string, items: string[]) => items.length > 0 && (
    <p className="text-xs text-ink-700"><span className="font-medium text-ink-900">{label}:</span> {items.join("; ")}</p>
  );
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-ink-900">Compare Versions</h3>
      <div className="mt-2 flex items-center gap-2 text-sm">
        <select className="input w-36" value={a} onChange={(e) => setA(e.target.value)}>
          <option value="">From…</option>
          {snapshots.map((s) => <option key={s.id} value={s.version}>v{s.version} — {formatDate(s.createdAt)}</option>)}
        </select>
        <span className="text-ink-400">→</span>
        <select className="input w-36" value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">To…</option>
          {snapshots.map((s) => <option key={s.id} value={s.version}>v{s.version} — {formatDate(s.createdAt)}</option>)}
        </select>
      </div>
      {diff && (
        <div className="mt-3 space-y-1.5 rounded-lg bg-ink-50/70 p-3">
          {line("Records added", diff.recordsAdded)}
          {line("Records removed", diff.recordsRemoved)}
          {(diff.chronologyAdded > 0 || diff.chronologyRemoved > 0) && <p className="text-xs text-ink-700"><span className="font-medium text-ink-900">Chronology:</span> {diff.chronologyAdded} added, {diff.chronologyRemoved} removed</p>}
          {line("Diagnoses added", diff.diagnosesAdded)}
          {line("Diagnoses removed", diff.diagnosesRemoved)}
          {line("Recommendations added", diff.itemsAdded)}
          {line("Recommendations removed", diff.itemsRemoved)}
          {diff.fieldChanges.map((f: AnyRec, i: number) => (
            <p key={i} className="text-xs text-ink-700"><span className="font-medium text-ink-900">{f.service}</span> — {f.field}: {String(f.from ?? "—")} → {String(f.to ?? "—")}</p>
          ))}
          {diff.reviewChanges.map((r: AnyRec, i: number) => (
            <p key={i} className="text-xs text-ink-700"><span className="font-medium text-ink-900">{r.service}</span> — physician review: {r.from.toLowerCase()} → {r.to.toLowerCase()}</p>
          ))}
          {diff.literatureChanges.map((l: AnyRec, i: number) => (
            <p key={i} className="text-xs text-ink-700"><span className="font-medium text-ink-900">{l.service}</span> — literature{l.added.length ? ` +${l.added.length}` : ""}{l.removed.length ? ` −${l.removed.length}` : ""}</p>
          ))}
          {diff.assumptionChanges.map((c: AnyRec, i: number) => (
            <p key={i} className="text-xs text-ink-700"><span className="font-medium text-ink-900">Assumption</span> — {c.field}: {c.from} → {c.to}</p>
          ))}
          <p className="border-t border-ink-200/70 pt-1.5 text-xs font-medium text-ink-900">
            Present value: {money(diff.totalChange.pvFrom)} → {money(diff.totalChange.pvTo)} · Lifetime: {money(diff.totalChange.lifetimeFrom)} → {money(diff.totalChange.lifetimeTo)}
          </p>
        </div>
      )}
    </div>
  );
}

// Persisted integrity findings for the case (diagnosis mapping, coding/pricing,
// inclusion eligibility). Critical findings mean the DOCX exports as a DRAFT.
function ValidationCard({ caseId }: { caseId: string }) {
  const [state, setState] = useState<AnyRec | null>(null);
  const [running, setRunning] = useState(false);
  async function load(method: "GET" | "POST" = "GET") {
    if (method === "POST") setRunning(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/validation`, { method });
      if (res.ok) setState(await res.json());
    } finally {
      setRunning(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [caseId]);
  const findings: AnyRec[] = state?.findings ?? [];
  const SEV_TONE: Record<string, "red" | "amber" | "neutral"> = { Critical: "red", High: "amber", Moderate: "neutral", Low: "neutral" };
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-900">Plan Integrity Check</h3>
          {state && (findings.length === 0
            ? <Badge tone="green">clean</Badge>
            : state.blocking
              ? <Badge tone="red">{findings.filter((f) => f.exportBlocking).length} export-blocking</Badge>
              : <Badge tone="amber">{findings.length} to review</Badge>)}
        </div>
        <button className="btn-outline px-3 py-1.5 text-xs" disabled={running} onClick={() => load("POST")}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Re-run check
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Deterministic validation of every recommendation — diagnosis/region mapping, CPT &amp; pricing consistency, record support, and inclusion eligibility. Critical findings export the report as a DRAFT until resolved.
      </p>
      {state && state.counts && (
        <p className="mt-2 text-xs text-ink-600">
          {state.counts.included} of {state.counts.proposed} items eligible for the damages total · {state.counts.physicianApproved} physician-approved · {state.counts.awaitingReview} awaiting review
        </p>
      )}
      {findings.length > 0 && (
        <ul className="mt-3 space-y-2">
          {findings.map((f) => (
            <li key={f.id} className="rounded-lg bg-ink-50/70 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEV_TONE[f.severity] ?? "neutral"}>{f.severity.toLowerCase()}</Badge>
                <span className="font-semibold text-ink-900">{f.service}</span>
                <span className="text-ink-500">— {f.result}{f.exportBlocking ? " (blocks final export)" : ""}</span>
              </div>
              <p className="mt-1 text-ink-700">{f.issue}</p>
              <p className="mt-0.5 text-ink-500"><span className="font-medium">Correction:</span> {f.suggestion}</p>
            </li>
          ))}
        </ul>
      )}
      {state && findings.length === 0 && (
        <p className="mt-2 text-xs text-emerald-700">Every recommendation is region-matched, consistently coded and priced, and supported for inclusion.</p>
      )}
    </div>
  );
}

function ReportPanel({ data, canExport, canEdit, call, busy, totals, physicians = [] }: { data: AnyRec; canExport: boolean; canEdit: boolean; call: any; busy: string | null; totals: AnyRec; physicians?: AnyRec[] }) {
  const [template, setTemplate] = useState(data.side ?? "PLAINTIFF");
  const [preparing, setPreparing] = useState<string>(data.preparingPhysicianId ?? "");
  async function exportReport(format: string) {
    const r = await call(`/api/cases/${data.id}/export`, "POST", { format, template }, "export");
    if (r?.export) window.open(`/api/cases/${data.id}/export/${r.export.id}/download`, "_blank");
  }
  const chosen = physicians.find((p: AnyRec) => p.id === preparing);
  return (
    <div className="space-y-4">
      {/* Preparing physician — only this seat's name & credentials appear in the report. */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Preparing Physician</h3>
        <p className="text-xs text-ink-500">The physician deemed to be preparing this report. Their name, credentials, and signature appear in the report — and only theirs. Leave unset for a planner-prepared plan (no credentials rendered).</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            className="input w-72"
            value={preparing}
            disabled={!canEdit}
            onChange={(e) => { setPreparing(e.target.value); call(`/api/cases/${data.id}`, "PATCH", { preparingPhysicianId: e.target.value || null }); }}
          >
            <option value="">— None (planner-prepared) —</option>
            {physicians.map((p: AnyRec) => <option key={p.id} value={p.id}>{p.name} ({ROLE_LABEL_SHORT[p.role] ?? p.role.toLowerCase()})</option>)}
          </select>
          {chosen && !chosen.credentialSummary && <span className="text-xs text-amber-600">No credential summary on this seat — add one under Team &amp; Seats → Credentials.</span>}
        </div>
      </div>
      <ValidationCard caseId={data.id} />
      <VersionCompareCard caseId={data.id} />
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Generate Report</h3>
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
              <button className="btn-outline" disabled={data.futureCareItems.length === 0} onClick={() => exportReport("CSV")}>Export Cost CSV</button>
            </>
          ) : <span className="text-sm text-ink-500">Your role cannot export reports.</span>}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Export History (Version Control)</h3>
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
