"use client";

import ReportLibrary, { type ReportSelection } from "@/components/case/ReportLibrary";
import { useState, useMemo, useRef, useEffect, useCallback, Fragment } from "react";
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
import { PROVENANCE_UPGRADE_STALE_REASON } from "@/lib/records/provenanceUpgrade";
import { presentClaims, labelForField } from "@/lib/records/claimPresentation";
import { resolveRecommendationCondition } from "@/lib/engine/recommendationCondition";
import { isChronologyOutputRow } from "@/lib/records/encounterLifecycle";
import { compareEvidenceSets, describeEvidenceSet, type EvidenceRowIdentity } from "@/lib/engine/evidenceSet";
import { buildBasis, compareBasis } from "@/lib/engine/recommendationBasis";
import { rankForDisplay } from "@/lib/engine/evidenceLedger";
// Aliased: this file already has a `FindingList` for the case's legal
// findings, which are a different concept from record-audit findings.
import { FindingList as RecordFindingList, FoldedFindings } from "@/components/case/FindingList";

/** Plain-language names for what a finding is, so the chip is self-explaining. */
const FINDING_LABEL: Record<string, string> = {
  CONTRADICTED_DATE: "Adjudicated contradiction — date",
  CONTRADICTED_PROVIDER: "Adjudicated contradiction — provider",
  UNRESOLVED_DISPUTE: "Critic disagreement, unresolved",
  UNSUPPORTED_CLAIM: "Claim not supported by its citation",
  NOT_CORROBORATED: "Blind second reading disagreed",
  UNDATED_CLINICAL: "No supportable service date",
  DATE_ARTIFACT_REJECTED: "Date came from a signature, print or form artifact",
  DATE_AMBIGUOUS: "Date too ambiguous to assert",
  PROVIDER_ROLE_REJECTED: "Named person is not the treating clinician",
  MISSING_ENCOUNTER: "Document completeness — an encounter was not extracted",
  UNCLEAR_NOTE_BOUNDARY: "Note boundary could not be determined",
  SECTION_NOT_PROCESSED: "Document completeness — a section was not processed",
  PAGE_UNREADABLE: "Page problem — unreadable",
  PAGE_LOW_CONFIDENCE: "Page problem — low-confidence OCR",
  PAGE_TRUNCATED: "Page problem — truncated",
  SOURCE_CLIPPED: "Document completeness — source clipped",
  STALE_REVIEW: "Reviewed content whose source changed",
  GENERATION_LOSS: "Prior result not reproduced",
};
/** Headline for the reason panel: what KIND of problem this is. */
const GUIDANCE_TITLE: Record<string, string> = {
  CONTRADICTED_FIELD: "The source contradicts a recorded value",
  FRAGMENT_DISAGREEMENT: "The extracts in this record disagree with each other",
  UNRESOLVED_DISPUTE: "Two passes disagreed, and the source did not settle it",
  NOT_CORROBORATED: "A blind second reading did not reproduce this",
  UNDATED: "No supportable service date",
  STALE: "Reviewed earlier, and the source changed since",
  GENERATION_LOSS: "The current extraction did not reproduce this",
  DOCUMENT_INCOMPLETE: "This record is sound; its document is incomplete",
  INTEGRITY_FAILURE: "Nothing here can be checked against the source",
  LEGACY_CONFLICT: "Flagged by an earlier run that did not record its reason",
  LOW_CONFIDENCE_OCR: "Read from a page the scanner struggled with",
  CARRIED_FORWARD: "Wording repeated from an earlier note",
  REVIEW_FLAG: "An automated check wants a human's eye",
  CLEAN: "Ready for your attestation",
};
const FINDING_SOURCE_LABEL: Record<string, string> = {
  DETERMINISTIC_VALIDATOR: "deterministic check",
  EXTRACTION_CRITIC: "critic pass",
  ADJUDICATOR: "adjudicator",
  CORROBORATION: "blind second reading",
  OCR: "OCR",
  PAGE_LEDGER: "page ledger",
  HUMAN_REVIEW: "human review",
};
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase, type EvidenceItem, type RecommendationDossier } from "@/lib/engine/medicalNecessity";
import { deriveWitnessAssessment, assessmentFromBasis, detectSetConflicts, PROBABILITY_LABEL, EVIDENCE_STRENGTH_LABEL, CONFIDENCE_LABEL, type ReasoningAssessment, type ReasoningItem } from "@/lib/engine/clinicalReasoning";
import type { BasisRecord } from "@/lib/engine/recommendationBasis";
import { filterSortCare, type CareSortKey } from "@/lib/uiFilters";
import { Icd10Search } from "@/components/Icd10Search";
import { PreExistingConditionsModal } from "@/components/PreExistingConditionsModal";
import { parseConditions, serializeConditions, findConditionsInRecords } from "@/lib/intake/preExisting";
import { suggestDiagnoses } from "@/lib/intake/diagnosisSuggest";
import { BookOpenCheck } from "lucide-react";
import { MEDICAL_SPECIALTIES } from "@/lib/intake/specialties";
import { attorneyItemsNeeded } from "@/lib/attorneyItems";
import { US_STATES } from "@/lib/intake/jurisdictions";
import { dateFromFilename } from "@/lib/documents/filenameDate";
import { CaseAssistant } from "@/components/case/CaseAssistant";
import { KIND_LABEL } from "@/lib/records/encounterSubstance";

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
  canVerifyRecords = false,
  canAddEvidence = false,
  precedents = [],
  physicians = [],
  attorneyView = false,
  pendingResolution = 0,
  assignedAttorneys = [],
}: {
  data: AnyRec;
  assumptions: { lifeExpectancyYears: number; discountRate: number; medicalInflation: number; geographicFactor: number };
  totals: {
    /** The SUPPORTED plan — what the record and professional judgement carry. */
    totalLifetime: number;
    totalPresentValue: number;
    /** Both views: supported, and the disclosed candidate/contingency scenario. */
    planTotals?: { supported: { items: number; presentValue: number; lifetimeCost: number }; scenario: { items: number; presentValue: number; lifetimeCost: number } };
  };
  permissions: Permission[];
  /** Server-computed canonical records.verify for THIS case (factual review). */
  canVerifyRecords?: boolean;
  /** Canonical `futurecare.edit`, computed server-side — the SAME grant the
   *  evidence endpoint enforces. */
  canAddEvidence?: boolean;
  precedents?: AnyRec[];
  physicians?: AnyRec[];
  /** Attorney-facing view: dollar values are never rendered (data unchanged). */
  attorneyView?: boolean;
  /** Open export-blocking integrity findings — the attorney banner's Pending Resolution count. */
  pendingResolution?: number;
  /** Case-assigned attorney names, shown in the banner for firm admins. */
  assignedAttorneys?: string[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusCat, setFocusCat] = useState<string | null>(null);
  const can = (p: Permission) => permissions.includes(p);

  // Deep-link support: /cases/{id}?tab=records (used by the case-manager and
  // records workspaces) opens the named tab directly. Runs once after mount so
  // the server-rendered HTML stays stable (no hydration mismatch).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    const valid = ["overview", "records", "chronology", "causation", "providers", "evidence", "futurecare", "costs", "reviews", "physician", "precedents", "report"];
    if (t && valid.includes(t)) setTab(t);
  }, []);

  // Deep-link from the Case Assistant: switch to the right tab, scroll to the
  // exact item, auto-expand its details, and highlight the specific section the
  // finding is about (the target panel maps focusCat → section).
  // Integrity-check "Review": hands the finding to the Case Review agent for a
  // simultaneous summary and resolution options.
  const [reviewFinding, setReviewFinding] = useState<AnyRec | null>(null);

  const focusEntity = (entityType: string | null, rawEntityId: string | null, category: string) => {
    if (!rawEntityId) return;
    // The attention engine falls back to the service NAME when it cannot resolve
    // the item id — map either form to the real recommendation id.
    const items = (data.futureCareItems ?? []) as AnyRec[];
    const entityId = entityType === "recommendation"
      ? (items.find((it) => it.id === rawEntityId)?.id ?? items.find((it) => it.service === rawEntityId)?.id ?? rawEntityId)
      : rawEntityId;
    const targetTab = /pricing|cpt|duplicate_cost/.test(category) ? "costs" : entityType === "document" ? "records" : entityType === "recommendation" ? "futurecare" : tab;
    setTab(targetTab);
    setFocusId(entityId);
    setFocusCat(category);
    // The tab's content mounts asynchronously AND the card's details auto-expand
    // (relayout) after focus — keep re-asserting the scroll until the card is
    // actually centered, rather than firing a single smooth scroll that the
    // expansion cancels.
    const attempt = (n: number) => {
      const card = document.getElementById(`fc-${entityId}`);
      if (card) {
        // Prefer the exact highlighted section inside the expanded card (the
        // area the finding is about); fall back to the card header.
        const section = card.querySelector("[data-focus-target]");
        const el = (section as HTMLElement | null) ?? card;
        const r = el.getBoundingClientRect();
        const settled = r.top >= 0 && r.top < window.innerHeight * (section ? 0.55 : 0.42);
        if (!settled) el.scrollIntoView({ behavior: "auto", block: section ? "center" : "start" });
        if (settled && n > 2) return; // stable — stop
      }
      if (n < 16) setTimeout(() => attempt(n + 1), 150);
    };
    setTimeout(() => attempt(0), 120);
    setTimeout(() => { setFocusId((f) => (f === entityId ? null : f)); setFocusCat(null); }, 6000);
  };

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

  // ── What each header number is ABOUT ──────────────────────────────────────
  // The band read "Future Care Items 34 · Lifetime $149,188 · Present Value
  // $120,499" — three numbers, none of them describing the same set. The count
  // was every disclosed item; the money was the 9 items with documented
  // support. Whichever a reader trusted, they were reading the other one wrong.
  const supportedCount = totals.planTotals?.supported.items ?? data.futureCareItems.length;
  const disclosedCount = totals.planTotals?.scenario.items ?? data.futureCareItems.length;
  // Only qualify the labels when the two sets actually differ; on a plan where
  // everything is supported, "(supported)" on every tile is noise.
  const splitTotals = !!totals.planTotals && totals.planTotals.scenario.presentValue > totals.planTotals.supported.presentValue;
  const itemsLabel = splitTotals ? "Supported Items" : "Future Care Items";
  const itemsValue = splitTotals ? `${supportedCount} of ${disclosedCount}` : String(disclosedCount);

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

  // The numbered clinical workflow (Phase 4). Stage state derives from real
  // case data: completed/current from `data.status`, warning when physician
  // review has pending items. Each stage opens its workspace tab.
  const FLOW: { n: number; label: string; tab: string; stage: string; count?: number; warn?: boolean }[] = [
    { n: 1, label: "Intake", tab: "overview", stage: "INTAKE" },
    { n: 2, label: "Records", tab: "records", stage: "RECORDS", count: data.documents.length },
    { n: 3, label: "Chronology", tab: "chronology", stage: "CHRONOLOGY", count: data.chronologyEvents.length },
    { n: 4, label: "Causation", tab: "causation", stage: "CAUSATION" },
    { n: 5, label: "Future Care", tab: "futurecare", stage: "FUTURE_CARE", count: data.futureCareItems.length },
    { n: 6, label: "Pricing", tab: "costs", stage: "PRICING" },
    { n: 7, label: "Physician", tab: "physician", stage: "PHYSICIAN_REVIEW", count: pendingPhysician, warn: pendingPhysician > 0 },
    { n: 8, label: "Report", tab: "report", stage: "FINAL" },
  ];
  const VISIBLE_FLOW = (attorneyView ? FLOW.filter((f) => f.tab !== "costs") : FLOW).map((f, i) => ({ ...f, n: i + 1 }));
  const stageIdx = Math.max(0, STAGES.indexOf(data.status === "DRAFTING" ? "FINAL" : data.status));
  const SECONDARY = TABS.filter((t) =>
    (attorneyView ? ["providers", "reviews", "precedents"] : ["providers", "evidence", "reviews", "precedents"]).includes(t.id),
  );

  return (
    <div>
      {/* ── Clinical workspace header (sticky) ─────────────────────────────── */}
      <div className="sticky top-0 z-30 -mx-6 border-b border-ink-200 bg-white/95 px-6 pt-3 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        {/* Identity + actions */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="truncate text-lg font-bold tracking-tight text-ink-900">{data.clientName}</h1>
            <span className="font-mono text-xs text-ink-400">{data.caseNumber}</span>
            <Badge tone={data.side === "PLAINTIFF" ? "brand" : data.side === "DEFENSE" ? "warning" : "slate"}>{data.side.toLowerCase()}</Badge>
            <span className="hidden text-xs text-ink-500 md:inline">{data.caseType.replace(/_/g, " ").toLowerCase()}</span>
            {data.diagnosis && (
              <span className="hidden max-w-[24rem] truncate text-xs text-ink-500 xl:inline" title={`${data.diagnosis}${data.icd10Code ? ` [${data.icd10Code}]` : ""}`}>
                · {data.diagnosis}
                {data.icd10Code ? <span className="font-mono text-ink-400"> [{data.icd10Code}]</span> : null}
              </span>
            )}
          </div>
          {assignedAttorneys.length > 0 && (
            <p className="mt-0.5 text-sm text-ink-500" title="Attorney assigned to this matter">
              Attorney: <span className="font-medium text-ink-700">{assignedAttorneys.join(", ")}</span>
            </p>
          )}
          </div>
          <div className="flex items-center gap-2">
            {hasPlan && (
              <CaseAssistant
                caseId={data.id}
                canEdit={can("case.edit")}
                onFocus={focusEntity}
                reviewFinding={reviewFinding as never}
                onReviewDone={() => setReviewFinding(null)}
                canApplyChanges={can("futurecare.edit")}
                redactPricing={attorneyView}
              />
            )}
            {can("futurecare.edit") && (
              <button className="btn-primary px-3 py-1.5 text-sm" disabled={busy === "gen"} onClick={() => call(`/api/cases/${data.id}/generate`, "POST", undefined, "gen")}>
                {busy === "gen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {hasPlan ? "Re-run AI Pipeline" : "Run AI Pipeline"}
              </button>
            )}
          </div>
        </div>

        {/* Full-width case metrics band */}
        {hasPlan && (
          <dl className={cn("mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200", attorneyView ? "sm:grid-cols-[1fr_2fr_1fr]" : "sm:grid-cols-5")} aria-label="Case metrics">
            {(attorneyView
              ? [
                  // Side tiles stay compact; the lifetime estimate is the
                  // attorney's headline number, front and center.
                  { label: itemsLabel, value: itemsValue, cls: "", compact: true },
                  // Estimate range (-30% / +10%, rounded to the nearest $1k) —
                  // over the SUPPORTED items only, which the label now says.
                  { label: splitTotals ? "Lifetime, Supported (Est. Range)" : "Lifetime (Est. Range)", value: moneyRange(totals.totalLifetime), cls: "text-brand-800", center: true },
                  // Absolute count of items blocking ANY report generation.
                  { label: "Pending Resolution", value: String(pendingResolution), cls: pendingResolution > 0 ? "text-amber-700" : "", compact: true },
                ]
              : [
                  { label: itemsLabel, value: itemsValue, cls: "" },
                  { label: splitTotals ? "Lifetime, Supported" : "Lifetime (Undiscounted)", value: formatMoney(totals.totalLifetime), cls: "" },
                  { label: splitTotals ? "Present Value, Supported" : "Present Value", value: formatMoney(totals.totalPresentValue), cls: "text-brand-800" },
                  // The second view, and the axis it differs on is stated. A
                  // candidate nobody has supported is real future care worth
                  // discussing and is not a damages figure — so both numbers
                  // appear, and neither hides inside the other. "(PV)" matters:
                  // sitting between an undiscounted lifetime figure and a
                  // present value, an unlabelled number is read as either.
                  ...(splitTotals
                    ? [{
                        label: `Candidate Scenario, PV (${disclosedCount} items)`,
                        value: formatMoney(totals.planTotals!.scenario.presentValue),
                        cls: "text-ink-500",
                      }]
                    : []),
                  { label: "Physician Pending", value: String(pendingPhysician), cls: pendingPhysician > 0 ? "text-amber-700" : "" },
                  { label: "Open Findings", value: String(data.reviewFindings.length), cls: data.reviewFindings.length > 0 ? "text-amber-700" : "" },
                ]
            ).map((m: { label: string; value: string; cls: string; sm?: boolean; compact?: boolean; center?: boolean }) => (
              <div key={m.label} className={cn("bg-white px-4 py-2", m.center && "text-center")}>
                <dt className="text-meta">{m.label}</dt>
                <dd className={cn("num-metric mt-0.5", m.center ? "text-2xl" : m.compact ? "text-base leading-7" : m.sm ? "text-sm leading-6" : "text-xl", m.cls)}>{m.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* Full-width workflow pipeline — each stage a demarcated segment with
            its own progress rail, so the sequence reads as distinct steps. */}
        <div className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-400">Pipeline</div>
        <ol className="mt-1 flex w-full items-stretch overflow-x-auto" aria-label="Case workflow">
          {VISIBLE_FLOW.map((s, i) => {
            const sIdx = STAGES.indexOf(s.stage);
            const state = sIdx < stageIdx ? "done" : sIdx === stageIdx ? "current" : "next";
            const open = tab === s.tab;
            return (
              <li key={s.tab} className={cn("flex min-w-[7.5rem] flex-1 items-stretch", i > 0 && "border-l border-ink-200")}>
                <button
                  onClick={() => setTab(s.tab)}
                  aria-current={open ? "page" : undefined}
                  title={s.warn ? `${s.count} item${s.count === 1 ? "" : "s"} awaiting physician review` : undefined}
                  className={cn(
                    "focusable flex w-full flex-col justify-between gap-1.5 px-3 pb-0 pt-1.5 text-[13px] transition-colors",
                    open ? "bg-brand-50/60 font-semibold text-brand-800" : state === "next" ? "text-ink-400 hover:bg-ink-50 hover:text-ink-700" : "text-ink-600 hover:bg-ink-50 hover:text-ink-900",
                  )}
                >
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      aria-hidden
                      className={cn(
                        "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10px] font-semibold",
                        state === "done" && "bg-emerald-100 text-emerald-800",
                        state === "current" && "bg-brand-600 text-white",
                        state === "next" && "bg-ink-100 text-ink-400",
                        s.warn && "bg-amber-100 text-amber-800",
                      )}
                    >
                      {state === "done" && !s.warn ? "✓" : s.n}
                    </span>
                    {s.label}
                    {typeof s.count === "number" && s.count > 0 && <span className="text-[11px] font-normal text-ink-400">{s.count}</span>}
                  </span>
                  {/* Per-segment progress rail */}
                  <span
                    aria-hidden
                    className={cn(
                      "block h-[3px] w-full rounded-t-full",
                      s.warn ? "bg-amber-400" : state === "done" ? "bg-emerald-500" : state === "current" ? "bg-brand-600" : "bg-ink-200",
                      open && "bg-brand-600",
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ol>

        {/* Secondary workspaces — a visually separate band of their own */}
        <div className="-mx-6 flex items-center gap-1.5 border-t border-ink-200 bg-ink-50/70 px-6 py-1.5" role="navigation" aria-label="Case workspaces">
          <span className="text-label mr-2.5 shrink-0">Workspaces</span>
          {SECONDARY.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={cn(
                // Every tab carries a visible outline so the band clearly reads
                // as a row of clickable workspaces, not plain text.
                "focusable flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[13px] transition-colors",
                tab === t.id
                  ? "border-brand-300 bg-white font-semibold text-brand-800 shadow-sm"
                  : "border-ink-200 bg-white/60 text-ink-600 hover:border-ink-300 hover:bg-white hover:text-ink-900",
              )}
            >
              <t.icon className="h-3.5 w-3.5" aria-hidden /> {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        {tab === "overview" && <IntakePanel data={data} canEdit={can("case.edit") || attorneyView} call={call} />}
        {tab === "records" && <RecordsPanel data={data} canEdit={can("records.upload")} canUpload={attorneyView} canVerify={canVerifyRecords} call={call} busy={busy} />}
        {tab === "chronology" && <ChronologyPanel data={data} canEdit={can("chronology.edit")} canVerify={canVerifyRecords} call={call} />}
        {tab === "causation" && <CausationPanel data={data} />}
        {/* Roster management stays behind case.edit (matching the server);
            physician reviewers may RECORD interview/provider findings — the
            action the interviews route actually authorizes for them. */}
        {tab === "providers" && <TreatingProvidersPanel data={data} canEdit={can("case.edit")} canInterview={can("case.edit") || can("physician.review")} attorneyView={attorneyView} call={call} />}
        {tab === "evidence" && !attorneyView && <EvidencePanel data={data} />}
        {tab === "futurecare" && <FutureCarePanel data={data} canEdit={can("futurecare.edit")} canAddEvidence={canAddEvidence} attorneyView={attorneyView} call={call} focusId={focusId} focusCat={focusCat} />}
        {tab === "costs" && !attorneyView && <CostsPanel data={data} assumptions={assumptions} totals={totals} canEdit={can("case.edit")} canApprove={can("physician.review")} call={call} focusId={focusId} />}
        {tab === "reviews" && <ReviewsPanel points={data.reviewFindings} hasPlan={hasPlan} redactPricing={attorneyView} />}
        {tab === "physician" && <PhysicianPanel data={data} canReview={can("physician.review")} attorneyView={attorneyView} call={call} />}
        {tab === "precedents" && <PrecedentsPanel precedents={precedents} data={data} />}
        {tab === "report" && (attorneyView
          ? <AttorneyReportPanel caseId={data.id} caseData={data} exports={data.reports ?? []} physicians={physicians} onNavigate={setTab} />
          : <ReportPanel data={data} canExport={can("report.export")} canEdit={can("case.edit")} call={call} busy={busy} totals={totals} physicians={physicians} onReview={setReviewFinding} />)}
      </div>
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
    dateOfBirth: data.dateOfBirth ? String(data.dateOfBirth).slice(0, 10) : "",
    dateOfInjury: data.dateOfInjury ? String(data.dateOfInjury).slice(0, 10) : "",
    diagnosis: data.diagnosis ?? "",
    icd10Code: data.icd10Code ?? "",
    mechanism: data.mechanism ?? "",
    jurisdiction: data.jurisdiction ?? "",
    zipCode: data.zipCode ?? "",
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
    <div className="card p-6">
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
        <Field label="Client Date of Birth">
          <input type="date" className="input" disabled={!canEdit} value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} />
        </Field>
        <Field label="Date of Injury">
          <input type="date" className="input" disabled={!canEdit} value={form.dateOfInjury} onChange={(e) => set("dateOfInjury", e.target.value)} />
        </Field>
        <Field label="Primary Diagnosis" wide>
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
                {/* A saved value outside the canonical list (e.g. an engine-recommended
                    specialty added via "Add for me") still displays and stays selectable. */}
                {s && !MEDICAL_SPECIALTIES.includes(s) && <option value={s}>{s}</option>}
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
        <Field label="ZIP Code (venue pricing)">
          <input className="input" disabled={!canEdit} value={form.zipCode} placeholder="e.g. 92626" maxLength={10} onChange={(e) => set("zipCode", e.target.value)} />
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
            const r = await call(`/api/cases/${data.id}`, "PATCH", { ...form, dateOfBirth: form.dateOfBirth || null, dateOfInjury: form.dateOfInjury || null, additionalDiagnoses: additional.filter((d) => d.diagnosis.trim()), additionalSpecialties: addlSpecialties.map((s) => s.trim()).filter(Boolean) }, "intake"); if (r) setSaved(true);
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

function RecordsPanel({ data, canEdit, canUpload = false, canVerify = false, call, busy }: { data: AnyRec; canEdit: boolean; canUpload?: boolean; canVerify?: boolean; call: any; busy: string | null }) {
  const mayUpload = canEdit || canUpload;
  const [filter, setFilter] = useState<string>("All");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDelDoc, setConfirmDelDoc] = useState<string | null>(null);
  // Structured AI-extraction view (source-grounded pipeline): per-document
  // status + cited encounters + the undated review group.
  const [extractions, setExtractions] = useState<AnyRec | null>(null);
  const loadExtractions = useCallback(async () => {
    const res = await fetch(`/api/cases/${data.id}/records/extractions`);
    if (res.ok) setExtractions(await res.json());
  }, [data.id]);
  useEffect(() => { void loadExtractions(); }, [loadExtractions]);

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
      {mayUpload && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <label className="btn-outline cursor-pointer">
            <Upload className="h-4 w-4" /> Upload Records
            <input type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          </label>
          {canEdit && (
            <button className="btn-ghost" disabled={busy === "sample"} onClick={() => call(`/api/cases/${data.id}/documents`, "POST", { sample: true }, "sample")}>
              {busy === "sample" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Add Sample Record Set
            </button>
          )}
          <span className="text-xs text-ink-500">
            {canEdit ? "Each record is auto-labeled by type. Click a record's type icon to reassign it." : "Each record is auto-labeled by type and processed into the case pipeline."}
          </span>
        </div>
      )}

      {/* Case-level findings: nobody's document owns them, so without this row
          they were persisted, allowed to block a final export, and shown to
          nobody. Once, here — never copied onto notes. */}
      {!!extractions?.caseFindings?.length && (
        <div className="card border-red-200 bg-red-50/40 p-3">
          <p className="mb-1.5 text-xs font-semibold text-red-900">Case-level findings</p>
          <RecordFindingList
            caseId={data.id}
            findings={extractions.caseFindings as AnyRec[] as never}
            canDisposition={!!extractions?.canVerify && canVerify !== false}
            onChanged={loadExtractions}
          />
        </div>
      )}

      {/* Processing limitations the reviewer must see before trusting the set. */}
      {!!extractions?.limitations?.length && (
        <div className="card border-amber-200 bg-amber-50/50 p-3">
          <p className="text-xs font-semibold text-amber-900">Processing and extraction limitations</p>
          <ul className="mt-1 space-y-0.5">
            {extractions.limitations.map((l: string, i: number) => (
              <li key={i} className="text-[11px] text-amber-800">• {l}</li>
            ))}
          </ul>
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
                        {/* At-a-glance metadata: what this record is without opening it. */}
                        <div className="mt-0.5 truncate text-xs text-ink-500">
                          {[
                            d.serviceDate ? `${formatDate(new Date(d.serviceDate))}${d.serviceDateEnd && d.serviceDateEnd !== d.serviceDate ? ` – ${formatDate(new Date(d.serviceDateEnd))}` : ""}` : null,
                            d.provider || null,
                            d.facility || null,
                            d.pageCount ? `${d.pageCount} pp.` : null,
                          ].filter(Boolean).join(" · ") || "No metadata extracted yet"}
                        </div>
                        {d.flags && <div className="mt-0.5 text-xs text-amber-600">{d.flags}</div>}

                        {open && (() => {
                          // Prefer persisted sub-documents (segmented at ingest);
                          // fall back to on-the-fly encounter splitting for legacy
                          // rows not yet segmented.
                          const segs: AnyRec[] | null = Array.isArray(d.segments) ? (d.segments as AnyRec[]) : null;
                          const fallbackEnc = segs ? null : recordEncounters(d);
                          const allClinical: AnyRec[] = segs ? segs.filter((s) => s.kind === "clinical") : (fallbackEnc ?? []);
                          // Dated care reads as a sequence; unresolved items
                          // interleaved among it read as part of that sequence
                          // and quietly undermine it. They are separated, kept,
                          // and each says why it is still undated.
                          const clinical = allClinical.filter((e) => e.date);
                          const unresolved = allClinical.filter((e) => !e.date);
                          const adminBearing: AnyRec[] = segs ? segs.filter((s) => s.kind === "administrative" && s.bearsOnCare) : [];
                          const adminOther: AnyRec[] = segs ? segs.filter((s) => s.kind === "administrative" && !s.bearsOnCare) : [];
                          const consolidated = segs ? clinical.length + adminBearing.length + adminOther.length > 0 : !!fallbackEnc && fallbackEnc.length >= 2;
                          const segPages = (s: AnyRec) => (s.pageStart && s.pageEnd ? (s.pageStart === s.pageEnd ? `p. ${s.pageStart}` : `pp. ${s.pageStart}–${s.pageEnd}`) : "");
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
                              <div className="space-y-2.5">
                                {clinical.length > 0 && (
                                  <div className="space-y-1.5">
                                    <p className="text-[11px] font-medium text-ink-500">{clinical.length} clinical encounter{clinical.length === 1 ? "" : "s"} in this record:</p>
                                    <ul className="space-y-2">
                                      {clinical.map((e, i) => (
                                        <li key={i} className="border-l-2 border-ink-200 pl-2.5 text-xs">
                                          <p className="font-semibold text-ink-900">
                                            {e.label}
                                            {e.noteTitle ? <span className="font-normal text-ink-500"> · {e.noteTitle}</span> : null}
                                            {e.provider ? <span className="font-normal text-ink-700"> — {e.provider}</span> : null}
                                            {e.facility ? <span className="font-normal text-ink-400"> · {e.facility}</span> : null}
                                            {segPages(e) ? <span className="font-normal text-ink-300"> · {segPages(e)}</span> : null}
                                          </p>
                                          <p className="leading-relaxed text-ink-600">{e.summary}</p>
                                          <DateProvenance seg={e} />
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {unresolved.length > 0 && (
                                  <div className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50/60 p-2">
                                    <p className="text-[11px] font-medium text-amber-800">
                                      Undated — requires review ({unresolved.length})
                                    </p>
                                    <ul className="space-y-2">
                                      {unresolved.map((e, i) => (
                                        <li key={i} className="border-l-2 border-amber-300 pl-2.5 text-xs">
                                          <p className="font-semibold text-ink-900">
                                            {e.noteTitle ? <span className="font-normal text-ink-600">{e.noteTitle}</span> : "Undated record"}
                                            {e.provider ? <span className="font-normal text-ink-700"> — {e.provider}</span> : null}
                                            {e.facility ? <span className="font-normal text-ink-400"> · {e.facility}</span> : null}
                                            {segPages(e) ? <span className="font-normal text-ink-300"> · {segPages(e)}</span> : null}
                                          </p>
                                          <p className="leading-relaxed text-ink-600">{e.summary}</p>
                                          <p className="mt-0.5 text-[11px] text-amber-700">{undatedReason(e.unresolvedReason)}</p>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {adminBearing.length > 0 && (
                                  <div className="space-y-1.5">
                                    <p className="text-[11px] font-medium text-ink-500">Administrative &amp; consent bearing on care:</p>
                                    <ul className="space-y-2">
                                      {Object.entries(
                                        adminBearing.reduce((acc: Record<string, AnyRec[]>, s) => {
                                          (acc[s.category as string] ??= []).push(s);
                                          return acc;
                                        }, {}),
                                      ).map(([cat, items], i) => {
                                        const pages = items.map((x) => x.pageStart).filter((n): n is number => !!n);
                                        const detail = items.map((x) => x.summary as string).find((s) => s && s.includes(":"));
                                        const dates = [...new Set(items.map((x) => x.label))];
                                        return (
                                          <li key={i} className="border-l-2 border-amber-300 pl-2.5 text-xs">
                                            <p className="font-semibold text-ink-900">
                                              {cat}
                                              <span className="font-normal text-ink-400">
                                                {" "}
                                                · {items.length} page{items.length === 1 ? "" : "s"}
                                                {pages.length ? ` (pp. ${pageRange(pages)})` : ""}
                                              </span>
                                            </p>
                                            <p className="leading-relaxed text-ink-600">{detail ?? dates.slice(0, 4).join(", ") + (dates.length > 4 ? "…" : "")}</p>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </div>
                                )}
                                {adminOther.length > 0 && (
                                  <p className="text-[11px] text-ink-400">
                                    + {adminOther.length} standard administrative page{adminOther.length === 1 ? "" : "s"}
                                    {(() => {
                                      const cats = [...new Set(adminOther.map((s) => s.category))].filter(Boolean) as string[];
                                      return cats.length ? ` (${cats.join(", ").toLowerCase()})` : "";
                                    })()}
                                    .
                                  </p>
                                )}
                                {clinical.length === 0 && adminBearing.length === 0 && (
                                  <p className="text-xs leading-relaxed text-ink-600">{narrativeFor(d)}</p>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs leading-relaxed text-ink-600">{narrativeFor(d)}</p>
                            )}
                            <ExtractionBlock
                              caseId={data.id}
                              doc={extractions?.documents?.find((x: AnyRec) => x.documentId === d.id) ?? null}
                              canVerify={!!extractions?.canVerify && canVerify !== false}
                              onChanged={loadExtractions}
                            />
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
                        {canEdit && (confirmDelDoc === d.id ? (
                          <span className="flex items-center gap-1.5">
                            <button className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700" onClick={async () => { setConfirmDelDoc(null); await call(`/api/cases/${data.id}/documents/${d.id}`, "DELETE"); }}>Confirm remove</button>
                            <button className="text-xs font-medium text-ink-500 hover:underline" onClick={() => setConfirmDelDoc(null)}>Cancel</button>
                          </span>
                        ) : (
                          <button className="rounded-md p-1.5 text-ink-300 hover:bg-ink-100 hover:text-red-600" title={`Remove ${d.filename}`} aria-label={`Remove ${d.filename}`} onClick={() => setConfirmDelDoc(d.id)}>
                            <X className="h-4 w-4" />
                          </button>
                        ))}
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
function ChronologyPanel({ data, canEdit, canVerify = false, call }: { data: AnyRec; canEdit: boolean; canVerify?: boolean; call: any }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("ALL");
  // Master-detail review (Phase 8): search + type/year filters over a compact
  // event list, full detail beside it. Renders ONLY extracted record content —
  // no content or evidence mappings are altered or invented here.
  const [chronoQ, setChronoQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  const events: AnyRec[] = data.chronologyEvents;
  if (events.length === 0)
    return <Empty>Upload records, then run the AI pipeline to build the medical chronology of the events that bear on the diagnoses and future care.</Empty>;

  const docName: Record<string, string> = {};
  data.documents.forEach((d: AnyRec) => (docName[d.id] = d.filename));

  const typeCounts: Record<string, number> = {};
  events.forEach((e) => (typeCounts[e.eventType ?? "OTHER"] = (typeCounts[e.eventType ?? "OTHER"] ?? 0) + 1));
  const presentTypes = Object.keys(typeCounts);
  const q = chronoQ.trim().toLowerCase();
  const filtered = events.filter((e) => {
    if (filter !== "ALL" && (e.eventType ?? "OTHER") !== filter) return false;
    if (q && !`${e.provider ?? ""} ${e.facility ?? ""} ${e.diagnosis ?? ""} ${e.summary ?? ""} ${e.procedure ?? ""} ${e.imagingFindings ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const years = [...new Set(events.map((e) => String(e.eventDate).slice(0, 4)))].sort();
  const selected = filtered.find((e) => e.id === selectedId) ?? filtered[0] ?? null;

  const excluded = Math.max(0, data.documents.length - events.length);
  const jumpToYear = (y: string) => {
    const target = filtered.find((e) => String(e.eventDate).startsWith(y));
    if (target) {
      setSelectedId(target.id);
      listRef.current?.querySelector(`[data-ev="${target.id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };

  // Full event detail — the exact content the timeline always showed (labeled
  // clinical sections, significance, source citation, edit), unchanged.
  const detail = (e: AnyRec) => {
    const s = styleFor(e.eventType);
    return (
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
                  /* Factual encounter summary FIRST, then the labeled clinical
                     sections in LCP order. */
                  <div className="mt-2 space-y-1 text-sm">
                    <p className="text-ink-900">{e.summary}</p>
                    {[
                      ["Subjective", e.subjective],
                      ["Past medical history", e.pastMedicalHistory],
                      ["Exam", e.objectiveFindings],
                      ["Diagnostic Studies", e.imagingFindings],
                      ["Assessment", e.diagnosis],
                      ["Plan", e.treatment],
                      ["Procedure", e.procedure],
                      ["Medications", e.medications],
                      ["Functional status", e.functionalStatus],
                      ["Work status", e.workStatus],
                      ["Restrictions", e.restrictions],
                      ["Impairment / MMI", e.impairmentRating],
                      ["Disposition", e.disposition],
                    ].filter(([, v]) => v).map(([label, v]) => (
                      <p key={label as string} className="text-ink-800"><span className="font-semibold text-ink-600">{label}: </span>{v as string}</p>
                    ))}
                  </div>
                )}

                {/* System-suggested relevance — a recommendation, never a record fact. */}
                {e.clinicalSignificance && (
                  <p className="mt-2 rounded-md bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800">
                    <span className="font-semibold">System-suggested relevance — pending human confirmation: </span>{e.clinicalSignificance}
                  </p>
                )}
                {/* Human-review status + factual verification (records.verify). */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={cn("rounded-full px-2 py-0.5 font-medium", e.reviewStatus === "VERIFIED" ? "bg-emerald-100 text-emerald-800" : e.reviewStatus === "REVIEWED" ? "bg-sky-100 text-sky-800" : e.reviewStatus === "HUMAN_EDITED" || e.edited ? "bg-amber-100 text-amber-800" : e.reviewStatus === "STALE" ? "bg-red-100 text-red-700" : e.reviewStatus === "GENERATION_LOSS" ? "bg-orange-100 text-orange-800" : "bg-slate-100 text-slate-600")}>
                    {e.reviewStatus === "VERIFIED" ? "Human-verified" : e.reviewStatus === "REVIEWED" ? "Human-reviewed" : e.reviewStatus === "HUMAN_EDITED" || e.edited ? "Human-edited" : e.reviewStatus === "STALE" ? "Stale — source changed" : e.reviewStatus === "GENERATION_LOSS" ? "Not reproduced by current extraction — confirm or reject" : "AI draft — pending review"}
                  </span>
                  {e.staleReason && <span className="text-red-600">{e.staleReason}</span>}
                  {canVerify && e.reviewStatus !== "VERIFIED" && (
                    <button className="btn-outline px-2 py-0.5 text-[11px]" onClick={() => call(`/api/cases/${data.id}/chronology/${e.id}`, "POST", { action: "verify" })}>Verify</button>
                  )}
                  {canVerify && e.reviewStatus === "VERIFIED" && (
                    <button className="btn-outline px-2 py-0.5 text-[11px]" onClick={() => call(`/api/cases/${data.id}/chronology/${e.id}`, "POST", { action: "reopen" })}>Reopen</button>
                  )}
                  {/* A STALE copy is resolved either by re-verifying it (above)
                      or by dismissing it in favor of the fresh draft: reopen
                      returns it to AI_DRAFT, which the next rebuild replaces. */}
                  {canVerify && e.reviewStatus === "STALE" && (
                    <button className="btn-outline px-2 py-0.5 text-[11px]" onClick={() => call(`/api/cases/${data.id}/chronology/${e.id}`, "POST", { action: "reopen" })}>Dismiss stale copy</button>
                  )}
                </div>

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

                {/* Treatment-series membership: the series row asserts a count
                    and range, so every member visit must stay citable — each
                    date links to its own document and page. */}
                {Array.isArray(e.seriesMembers) && e.seriesMembers.length > 0 && (
                  <div className="mt-1.5 text-xs text-ink-700">
                    <span className="font-semibold text-ink-600">Series visits ({e.seriesMembers.length}): </span>
                    {(e.seriesMembers as { date?: string; documentId?: string; page?: number | null }[]).map((m, i) => (
                      <a
                        key={`${m.date}-${i}`}
                        href={m.documentId ? `/api/cases/${data.id}/documents/${m.documentId}/view` : undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="mr-2 whitespace-nowrap text-brand-700 hover:underline"
                      >
                        {m.date}{m.page ? ` (p. ${m.page})` : ""}
                      </a>
                    ))}
                  </div>
                )}
              </div>
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-500">
        {events.length} pivotal {events.length === 1 ? "event" : "events"} — those bearing on the diagnoses and future care — screened from {data.documents.length}{" "}
        {data.documents.length === 1 ? "record" : "records"}
        {excluded > 0 ? ` (${excluded} without a bearing on the complaint were excluded)` : ""}.
      </p>

      {/* One-time provenance upgrade: reviews that predate content
          fingerprinting were staled beside fresh drafts. Shown only while any
          remain unresolved, then disappears for good. */}
      {(() => {
        const upgraded = (data.chronologyEvents as AnyRec[]).filter(
          (e) => e.reviewStatus === "STALE" && e.staleReason === PROVENANCE_UPGRADE_STALE_REASON,
        ).length;
        if (!upgraded) return null;
        return (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            <p className="font-semibold">One-time re-review: {upgraded} previously reviewed {upgraded === 1 ? "event predates" : "events predate"} content verification.</p>
            <p className="mt-1 text-amber-800">
              These events were reviewed before the system stored a content fingerprint, so their content can no longer be
              proven to match the records. Nothing was deleted: each is marked{" "}
              <span className="font-medium">Stale — source changed</span> with a fresh draft beside it for comparison.
              For each one, either <span className="font-medium">Verify</span> the stale entry if its content is still
              correct, or <span className="font-medium">Dismiss stale copy</span> to keep the fresh draft. This notice
              disappears once all are resolved and will not recur.
            </p>
          </div>
        );
      })()}

      {/* Search + type chips + jump-to-year */}
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-56 py-1.5 text-sm" placeholder="Search events…" aria-label="Search chronology events" value={chronoQ} onChange={(e) => { setChronoQ(e.target.value); setSelectedId(null); }} />
        <div className="flex flex-wrap gap-1.5">
          <FilterChip label="All" count={events.length} active={filter === "ALL"} onClick={() => setFilter("ALL")} />
          {presentTypes.map((t) => (
            <FilterChip key={t} label={styleFor(t).label} count={typeCounts[t]} active={filter === t} onClick={() => setFilter(t)} />
          ))}
        </div>
        {years.length > 1 && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Jump to year">
            <span className="text-meta">Jump:</span>
            {years.map((y) => (
              <button key={y} className="focusable rounded px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-50" onClick={() => jumpToYear(y)}>{y}</button>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <Empty>No events match the current filters.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
          {/* Master list — compact, scrollable, keyboard-navigable */}
          <ol
            ref={listRef}
            aria-label="Chronology events"
            className={cn("max-h-[70vh] space-y-1 overflow-y-auto pr-1 lg:block", mobileDetail && "hidden")}
            onKeyDown={(e) => {
              const idx = filtered.findIndex((x) => x.id === selected?.id);
              if (e.key === "ArrowDown" && idx < filtered.length - 1) { e.preventDefault(); setSelectedId(filtered[idx + 1].id); }
              if (e.key === "ArrowUp" && idx > 0) { e.preventDefault(); setSelectedId(filtered[idx - 1].id); }
              if (e.key === "Enter") setMobileDetail(true);
            }}
          >
            {filtered.map((e, i) => {
              const s = styleFor(e.eventType);
              const active = selected?.id === e.id;
              // The factual event summary is the primary content of the list —
              // a diagnosis label never substitutes for the event itself.
              const headline = e.summary || e.procedure || e.imagingFindings || e.diagnosis || "";
              // Prior-history band: care predating the injury is retained (it
              // is evidence) but presented in its own band, the way a
              // physician reviewer separates history from the injury course.
              const doi = data.dateOfInjury ? new Date(data.dateOfInjury).getTime() : null;
              const isPrior = doi != null && new Date(e.eventDate).getTime() < doi;
              const prevPrior = doi != null && i > 0 && new Date(filtered[i - 1].eventDate).getTime() < doi;
              const bandLabel =
                doi == null ? null
                : i === 0 && isPrior ? "Prior medical history — before the date of injury"
                : prevPrior && !isPrior ? "Date of injury forward"
                : null;
              return (
                <li key={e.id} data-ev={e.id}>
                  {bandLabel && (
                    <div className="my-2 flex items-center gap-2 px-1">
                      <span className="h-px flex-1 bg-ink-200" />
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{bandLabel}</span>
                      <span className="h-px flex-1 bg-ink-200" />
                    </div>
                  )}
                  <button
                    onClick={() => { setSelectedId(e.id); setMobileDetail(true); }}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "focusable w-full rounded-lg border px-3 py-2 text-left transition-colors",
                      active ? "border-brand-300 bg-brand-50" : "border-transparent hover:bg-ink-50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                      <span className="text-xs font-semibold text-ink-900">{lcpDate(e.eventDate)}</span>
                      <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", s.chip)}>{s.label}</span>
                      {e.dateInferred && <span className="text-[10px] text-amber-700">inferred</span>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-600">{e.provider || "Treating provider"}{e.facility ? ` · ${String(e.facility).replace(/[.\s]+$/, "")}` : ""}</p>
                    {headline && <p className="mt-0.5 truncate text-xs text-ink-500">{headline}</p>}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Detail pane — the full encounter, exactly as extracted */}
          <div className={cn("min-w-0 lg:block", !mobileDetail && "hidden")}>
            <button className="focusable mb-2 rounded text-xs font-medium text-brand-700 hover:underline lg:hidden" onClick={() => setMobileDetail(false)}>
              ← Back to event list
            </button>
            {selected ? detail(selected) : <Empty>Select an event to view its full detail.</Empty>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Causation ────────────────────────────────────────────────────────────────
const REL_TONE: Record<string, "green" | "amber" | "neutral" | "red"> = { RELATED: "green", AGGRAVATION: "amber", PREEXISTING_UNRELATED: "neutral", SUBSEQUENT_UNRELATED: "neutral", UNCLEAR: "red" };
// The confidence BAR and PERCENTAGE are deliberately absent.
//
// A causation opinion is a physician's judgement, and dressing it in a
// progress bar and a two-digit number implied a precision the underlying
// model does not have — "78%" reads as a measurement, not an inference, and
// nobody could say what would move it to 79. The relatedness badge, the
// reasoning, the objective evidence and the cited sources are what a reader
// should weigh; "MD confirmed" is the only status that means anything here,
// because it is the one a person actually asserted.
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
            {c.physicianConfirmed && <div className="mt-2"><Badge tone="green">MD confirmed</Badge></div>}
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
  // The band, not the number. `confidence` is an uncalibrated internal score;
  // printing it as a percentage in report language gave a two-digit figure the
  // authority of a measurement.
  const conf = it.confidence != null ? ` (${it.confidence >= 75 ? "high" : it.confidence >= 60 ? "moderate" : "low"} confidence)` : "";
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
// ── Dossier layout ──────────────────────────────────────────────────────────
// A recommendation dossier is eight or nine sections of dense clinical prose,
// and it used to be a flat `space-y-3` stack of identical tiny grey labels.
// Nothing marked where one section stopped and the next began, so the
// necessity narrative, the probability, four columns of cited findings, the
// literature and the challenges ran together into one grey wall.
//
// Two rules fix it, and both are about BOUNDARIES rather than decoration:
// every section is separated by a rule and carries a heading of its own
// weight, and every cited finding is a two-line unit — the finding, then its
// citation beneath — so twelve of them read as twelve things.

/** One titled section of the dossier, visibly separated from its neighbours. */
function DossierSection({
  label,
  tone = "neutral",
  focusRef,
  highlighted,
  children,
}: {
  label: string;
  tone?: "neutral" | "warning";
  focusRef?: boolean;
  highlighted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      data-focus-target={focusRef ? "" : undefined}
      className={cn("border-t border-ink-100 pt-3", highlighted && "rounded-md bg-amber-50 p-2 ring-2 ring-amber-400")}
    >
      <h4 className={cn("text-[11px] font-semibold uppercase tracking-wider", tone === "warning" ? "text-amber-700" : "text-ink-400")}>{label}</h4>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/**
 * Which four findings a physician sees used to be decided by array order —
 * whatever the extractor happened to emit first — and the rest were dropped
 * with no indication they existed. Cited findings come first now, most recent
 * within that, and the remainder is disclosed and reachable rather than
 * silently truncated.
 */
function rankEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  // A date at the head of the source line ("05/29/2023 · Paul English (p. 1)").
  const dateOf = (e: EvidenceItem): number => {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(e.source ?? "");
    return m ? new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`).getTime() : 0;
  };
  // A finding that cites a page can be checked; one that cannot, cannot.
  const cited = (e: EvidenceItem): number => (/p\.\s*\d+/.test(e.source ?? "") ? 0 : 1);
  return [...items].sort((a, b) => cited(a) - cited(b) || dateOf(b) - dateOf(a));
}

function EvidenceBucket({ label, items }: { label: string; items: EvidenceItem[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return null;
  const ranked = rankEvidence(items);
  // Condition-level context sat inside these buckets unmarked, so a statement
  // about the INJURY read as support for THIS service. Both belong here — a
  // reader wants the diagnosis in view — but they are different claims.
  const shown = showAll ? ranked : ranked.slice(0, 4);
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/50 p-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      <ul className="mt-1.5 space-y-1.5">
        {shown.map((e, i) => (
          // The citation on its own line: inline and parenthesised, it ran
          // into the next finding and the two became one paragraph.
          <li key={i} className="border-l-2 border-ink-200 pl-2 text-[13px] leading-snug text-ink-800">
            {e.text}
            {e.source || e.scope === "CONDITION" ? (
              <span className="mt-0.5 block text-[11px] text-ink-400">
                {e.scope === "CONDITION" ? <span className="mr-1 rounded bg-ink-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-ink-500">condition context</span> : null}
                {e.source}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {ranked.length > 4 && (
        <button
          type="button"
          className="mt-1.5 text-[11px] font-medium text-brand-700 hover:underline"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show the strongest four" : `Show all ${ranked.length} — ${ranked.length - 4} more not displayed`}
        </button>
      )}
    </div>
  );
}
/**
 * The recorded evidence ledger — read from what was PERSISTED, not re-derived.
 *
 * Everything else on this panel is rebuilt in the browser from the case as it
 * stands right now. That is fine for a summary and wrong for an evidentiary
 * record: the ledger written when the plan was generated is what the physician
 * approved and what the report cites, and until now nothing displayed it, so
 * nobody could see when the two had parted company.
 *
 * The current derivation is still computed — as the WITNESS. When the two sets
 * differ the recorded one is shown and the difference is stated. Reconciling
 * them is a decision about the case, so it is offered to a person rather than
 * taken silently by a render.
 */
function RecordedEvidence({ rows, derived }: { rows: AnyRec[]; derived?: EvidenceRowIdentity[] }) {
  const [showAll, setShowAll] = useState(false);
  const status = compareEvidenceSets(rows as unknown as EvidenceRowIdentity[], derived ?? []);
  const notice = describeEvidenceSet(status);
  // Nothing recorded and nothing derivable: this recommendation simply has no
  // ledger, which the buckets above already convey. Do not add an empty box.
  if (!rows.length && !(derived ?? []).length) return null;

  const source = rows.length ? (rows as unknown as EvidenceRowIdentity[]) : (derived ?? []);
  const byClaim = new Map<string, EvidenceRowIdentity[]>();
  for (const r of source) byClaim.set(r.claim, [...(byClaim.get(r.claim) ?? []), r]);

  return (
    <DossierSection label="Recorded evidence, by claim" tone={status.state === "CURRENT" ? undefined : "warning"}>
      {notice ? <p className="mb-2 text-[12px] leading-snug text-amber-800">{notice}</p> : null}
      <div className="space-y-2">
        {[...byClaim.entries()].map(([claim, group]) => {
          const ranked = rankForDisplay(group as never) as unknown as AnyRec[];
          const shown = showAll ? ranked : ranked.slice(0, 3);
          return (
            <div key={claim} className="rounded-md border border-ink-100 bg-white/60 p-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                {CLAIM_LABEL[claim] ?? claim} <span className="font-normal normal-case text-ink-400">· {ranked.length} finding{ranked.length === 1 ? "" : "s"}</span>
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {shown.map((r, i) => (
                  <li key={i} className={cn("border-l-2 pl-2 text-[13px] leading-snug text-ink-800", r.stance === "OPPOSES" ? "border-amber-400" : "border-ink-200")}>
                    {r.stance === "OPPOSES" ? <span className="mr-1 rounded bg-amber-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-amber-800">argues against</span> : null}
                    {r.quote as string}
                    <span className="mt-0.5 block text-[11px] text-ink-400">
                      {/* Whose words these are. A chronology field is the
                          extraction's prose about an encounter; only a claim
                          excerpt is the clinician's own sentence. */}
                      {r.verbatim ? "quoted from the record" : "summarised from the record"}
                      {" · "}
                      {String(r.strength).toLowerCase()}
                      {r.recordedOn ? ` · ${new Date(r.recordedOn as string).toLocaleDateString()}` : ""}
                      {r.page ? ` · p. ${r.page}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {source.length > 3 && (
        <button type="button" className="mt-1.5 text-[11px] font-medium text-brand-700 hover:underline" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show the strongest three per claim" : "Show every recorded finding"}
        </button>
      )}
    </DossierSection>
  );
}

// Which dossier section a Case Assistant finding category points at, so the
// deep-link can highlight the exact area that needs to be addressed.
const HIGHLIGHT_SECTION: Record<string, "reasoning" | "evidence" | "literature"> = {
  diagnosis_mismatch: "reasoning", unsupported_recommendation: "reasoning", staged_care: "reasoning",
  recommendation_conflict: "reasoning", duplicate_cost: "reasoning", physician_review_pending: "reasoning",
  missing_evidence: "evidence",
  literature: "literature",
};
const HL = "rounded-md bg-amber-50 p-2 ring-2 ring-amber-400";

// Attorney-facing estimate range: -30% to +10% of the computed value, rounded
// to the nearest $1,000 so the figures read as an estimate, not a total.
function moneyRange(v: number): string {
  const k = (x: number) => Math.round(x / 1000) * 1000;
  return `${formatMoney(k(v * 0.7))} – ${formatMoney(k(v * 1.1))}`;
}

/**
 * Paste a DOI, a PMID or a title, say which claim it answers, and the server
 * resolves it against Europe PMC / Crossref before storing anything. A
 * reference that cannot be looked up is refused rather than printed — the same
 * rule the automated literature pass lives by.
 */
function AddCitation({ onAdd }: { onAdd: (input: { reference: string; claim: string; stance: string; note?: string }) => Promise<string | null> }) {
  const [reference, setReference] = useState("");
  const [claim, setClaim] = useState("NECESSITY");
  const [stance, setStance] = useState("SUPPORTS");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reference.trim()) return;
    setBusy(true);
    setError(await onAdd({ reference: reference.trim(), claim, stance, note: note.trim() || undefined }));
    setBusy(false);
    setReference("");
    setNote("");
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          className="input h-7 min-w-[16rem] flex-1 text-[11px]"
          placeholder="DOI, PMID, or article title"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          aria-label="DOI, PMID, or article title"
        />
        <select className="input h-7 w-auto py-0 text-[11px]" value={claim} onChange={(e) => setClaim(e.target.value)} aria-label="Which claim this supports">
          {Object.entries(CLAIM_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select className="input h-7 w-auto py-0 text-[11px]" value={stance} onChange={(e) => setStance(e.target.value)} aria-label="Supports or argues against">
          <option value="SUPPORTS">supports</option>
          <option value="OPPOSES">argues against</option>
        </select>
        <button type="button" className="btn h-7 px-2 text-[11px]" disabled={busy || !reference.trim()} onClick={submit}>
          {busy ? "Resolving…" : "Attach"}
        </button>
      </div>
      <input
        className="input h-7 w-full text-[11px]"
        placeholder="Why it applies to this patient (optional — quoted as your words)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Why this citation applies"
      />
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  );
}

/** Who chose a citation, in the words a reader needs. */
const CONTRIBUTOR_LABEL: Record<string, string> = {
  PHYSICIAN_REVIEWER: "the reviewing physician",
  PLANNER: "the life care planner",
  ADMIN: "a firm administrator",
  PARALEGAL: "a paralegal",
  ATTORNEY_REVIEWER: "the reviewing attorney",
};

/** What each claim is called on screen. */
const CLAIM_LABEL: Record<string, string> = {
  NECESSITY: "medical necessity",
  FREQUENCY: "frequency",
  DURATION: "duration",
  FUNCTIONAL_NEED: "functional need",
  PRIOR_TREATMENT: "prior treatment",
  COST: "cost",
};

function RecommendationDossierView({
  dossier,
  assessment,
  highlight,
  condensed = false,
  physicianEvidence = [],
  recordedEvidence = [],
  witnessLedger,
  basisState,
  onAddEvidence,
}: {
  dossier: RecommendationDossier;
  assessment?: ReasoningAssessment;
  highlight?: string | null;
  condensed?: boolean;
  physicianEvidence?: AnyRec[];
  /** The MACHINE ledger as it was recorded against this plan. The read model. */
  recordedEvidence?: AnyRec[];
  /** The current derivation over OUTPUT rows — the comparison's witness. */
  witnessLedger?: EvidenceRowIdentity[];
  /** Set when the recorded basis and the current record disagree. */
  basisState?: { state: string; notice: string | null } | null;
  /** Present only when the viewer may attach evidence. */
  onAddEvidence?: (input: { reference: string; claim: string; stance: string; note?: string }) => Promise<string | null>;
}) {
  const se = dossier.supportingEvidence;
  const target = highlight ? HIGHLIGHT_SECTION[highlight] : undefined;
  return (
    <div className="space-y-4 text-sm">
      {assessment && (
        <div data-focus-target={target === "reasoning" ? "" : undefined} className={cn("rounded-lg border border-brand-100 bg-brand-50/60 p-3", target === "reasoning" && "ring-2 ring-amber-400")}>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Clinical reasoning</p>
          <p className="mt-0.5 leading-relaxed text-ink-800"><span className="font-medium">{PROBABILITY_LABEL[assessment.probabilityClassification]}.</span> {assessment.inclusionRationale}</p>
          <p className="mt-1 text-xs text-ink-600">Pathway: {assessment.clinicalPathway} · Evidence strength: {EVIDENCE_STRENGTH_LABEL[assessment.evidenceStrength]} · Confidence: {CONFIDENCE_LABEL[assessment.recommendationConfidence]}{assessment.frequencySupported ? "" : " · frequency unverified"}</p>
          <p className="mt-1 text-xs text-ink-600">{assessment.residualUncertainty}</p>
          {assessment.conflictFlags.length > 0 && (
            <ul className="mt-1 space-y-0.5">{assessment.conflictFlags.map((f, i) => <li key={i} className="text-xs text-amber-800">⚠ {f.note}</li>)}</ul>
          )}
        </div>
      )}
      <DossierSection label="Medical necessity">
        <p className="leading-relaxed text-ink-800">{dossier.medicalNecessity}</p>
      </DossierSection>

      <DossierSection label="Probability and confidence">
        <div className="flex flex-wrap items-center gap-2">
          {/* No percentage. "74%" reads as a measurement, and it was produced
              by adding weights for broad factors — any prior treatment, any
              guideline, physician involvement — against no calibration set.
              The qualitative band is the honest form of the same judgement,
              and the sentence beneath already says it in words. */}
          <Badge tone={dossier.probability.percentage >= 51 ? "green" : "amber"}>{dossier.probability.classification}</Badge>
          <Badge tone={CONF_TONE_D[dossier.confidence.level]}>{dossier.confidence.level.toLowerCase()} confidence</Badge>
        </div>
        <p className="mt-1.5 text-ink-700">{dossier.probability.statement}</p>
      </DossierSection>

      {/* Attorney-condensed view ends at the probability statement — the
          clinical evidence detail below is the clinical team's surface. */}
      {condensed ? null : (<>
      <DossierSection label="Supporting clinical evidence" focusRef={target === "evidence"} highlighted={target === "evidence"}>
        <div className="grid gap-2 md:grid-cols-2">
          <EvidenceBucket label="Supporting diagnoses" items={se.diagnoses} />
          {/* Named as history, never as support — it argues the condition
              pre-dates the incident. */}
          <EvidenceBucket label="Recorded as prior history" items={se.priorHistory} />
          <EvidenceBucket label="Objective findings" items={se.objectiveFindings} />
          <EvidenceBucket label="Imaging" items={se.imaging} />
          <EvidenceBucket label="Examination findings" items={se.examination} />
          <EvidenceBucket label="Functional limitations" items={se.functionalLimitations} />
          <EvidenceBucket label="Prior treatment" items={se.priorTreatment} />
          <EvidenceBucket label="Treating-physician documentation" items={se.physicianDocumentation} />
          <EvidenceBucket label="Clinical guidelines" items={se.guidelines} />
        </div>
      </DossierSection>

      {/* The physician's own citation. The endpoint exists to be used from
          here — a capture path with no control is a feature nobody has. */}
      {onAddEvidence && (
        <DossierSection label="Add a citation">
          <AddCitation onAdd={onAddEvidence} />
        </DossierSection>
      )}
      {basisState?.notice ? (
        <DossierSection label="Recorded basis" tone="warning">
          <p className="text-[12px] leading-snug text-amber-800">{basisState.notice}</p>
        </DossierSection>
      ) : null}

      <RecordedEvidence rows={recordedEvidence} derived={witnessLedger ?? dossier.ledger} />

      {/* "Expert-selected", not "Physician-selected": planners hold this
          permission too and do legitimate literature work. Each row names who
          actually chose it, so the heading no longer asserts a credential the
          row may not carry. */}
      {physicianEvidence.length > 0 && (
        <DossierSection label="Expert-selected evidence">
          <ul className="space-y-2">
            {physicianEvidence.map((e: AnyRec) => (
              <li key={e.id as string} className={cn("border-l-2 pl-2", e.stance === "OPPOSES" ? "border-amber-300" : "border-brand-300")}>
                <p className="text-ink-800">
                  <span className="font-medium">{e.citationTitle as string}</span>
                  {e.citationYear ? ` (${e.citationYear})` : ""}
                  {e.citationJournal ? <span className="text-ink-400"> · {e.citationJournal as string}</span> : null}
                </p>
                <p className="mt-0.5 text-xs text-ink-600">&ldquo;{e.quote as string}&rdquo;</p>
                <p className="mt-0.5 text-[11px] text-ink-400">
                  Selected by {CONTRIBUTOR_LABEL[e.addedByRole as string] ?? "a case contributor"}
                  {e.addedByCredential ? `, ${e.addedByCredential}` : ""} · {CLAIM_LABEL[e.claim as string] ?? (e.claim as string)}
                  {e.stance === "OPPOSES" ? " · argues against" : ""}
                  {e.citationDoi ? ` · doi:${e.citationDoi}` : e.citationPmid ? ` · PMID ${e.citationPmid}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </DossierSection>
      )}
      <DossierSection label="Supporting literature" focusRef={target === "literature"} highlighted={target === "literature"}>
        {dossier.literature.length ? (
          <ol className="space-y-2">
            {dossier.literature.map((l, i) => (
              <li key={i} className="border-l-2 border-ink-200 pl-2 text-ink-700">
                <span className="font-medium">{l.title}</span>{l.year ? ` (${l.year})` : ""} <span className="text-ink-400">· {l.studyType}</span>
                <p className="mt-0.5 text-xs text-ink-500">Supports {l.supports}. {l.applicability}.{l.limitations ? ` Limitation: ${l.limitations}.` : ""}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-ink-400">Direct published literature specific to this recommendation is limited; it rests on the applicable clinical guidance and the treating record.</p>
        )}
      </DossierSection>

      {dossier.contradictoryEvidence.length > 0 && (
        <DossierSection label="Contradictory evidence" tone="warning">
          <ul className="space-y-1">{dossier.contradictoryEvidence.slice(0, 4).map((t, i) => <li key={i} className="border-l-2 border-amber-300 pl-2 text-amber-800">{t}</li>)}</ul>
        </DossierSection>
      )}
      {dossier.unknowns.length > 0 && (
        <DossierSection label="Unknowns">
          <ul className="space-y-1">{dossier.unknowns.slice(0, 4).map((t, i) => <li key={i} className="border-l-2 border-ink-200 pl-2 text-ink-700">{t}</li>)}</ul>
        </DossierSection>
      )}
      <DossierSection label="Potential challenges">
        <ul className="space-y-1">{dossier.potentialChallenges.slice(0, 5).map((t, i) => <li key={i} className="border-l-2 border-ink-200 pl-2 text-ink-700">{t}</li>)}</ul>
      </DossierSection>
      <p className="border-t border-ink-100 pt-2 text-xs italic text-ink-500">{dossier.confidence.explanation}</p>
      </>)}
    </div>
  );
}
function caseInputs(it: AnyRec, data: AnyRec) {
  // The SAME resolution the reasoning engine uses. Reading `it.conditionId`
  // here while the assessment beside it remapped the item meant one panel
  // could argue about one diagnosis and cite findings from another.
  const cond = resolveRecommendationCondition(it as never, (data.conditions ?? []) as never).condition as AnyRec | null;
  const poss = data.sex === "FEMALE" ? "her" : data.sex === "MALE" ? "his" : "the patient's";
  const kase: DossierCase = { subject: data.clientName || "the patient", pronounPoss: poss, lifeExpectancyYears: data.lifeExpectancyYears ?? 40, adult: true };
  const provName = new Map((data.treatingProviders ?? []).map((p: AnyRec) => [p.id, `${p.name}${p.credentials ? `, ${p.credentials}` : ""}`]));
  const interviews = ((data.interviewFindings ?? []) as AnyRec[]).map((f) => ({ subject: f.subject, category: f.category, text: f.text, quote: f.quote, conditionId: f.conditionId, futureCareItemId: f.futureCareItemId, providerName: f.providerId ? provName.get(f.providerId) ?? null : null }));
  return { cond, kase, interviews };
}
/**
 * Does the recorded basis still match what this panel would derive?
 *
 * Neither side wins automatically. A recorded basis that no longer matches is
 * not obviously wrong — the record may have moved since a physician approved
 * it, which is the thing a reviewer needs told rather than resolved.
 */
function basisStateFor(it: AnyRec, data: AnyRec): { state: string; notice: string | null } | null {
  const stored = ((data.recommendationBases ?? []) as AnyRec[]).find((b) => b.futureCareItemId === it.id) ?? null;
  const derived = buildBasis(it as never, dossierForItem(it, data));
  const c = compareBasis(stored as never, derived);
  return c.state === "CURRENT" ? null : { state: c.state, notice: c.notice };
}

function dossierForItem(it: AnyRec, data: AnyRec): RecommendationDossier {
  const { cond, kase, interviews } = caseInputs(it, data);
  return buildRecommendationDossier(it as never, cond as DossierCondition | null, (data.chronologyEvents ?? []) as DossierChronoEvent[], kase, interviews as never);
}

/**
 * The dossier the recorded ledger is COMPARED against.
 *
 * The workspace holds the review chronology — current rows plus stale ones,
 * kept for comparison — while the ledger is built from output rows only. Given
 * two different inputs the comparison faithfully reported drift on every case
 * with a stale row, which is a true answer to a question nobody asked. Same
 * rule, same answer.
 */
function witnessDossierForItem(it: AnyRec, data: AnyRec): RecommendationDossier {
  const { cond, kase, interviews } = caseInputs(it, data);
  const output = ((data.chronologyEvents ?? []) as AnyRec[]).filter(isChronologyOutputRow);
  return buildRecommendationDossier(it as never, cond as DossierCondition | null, output as DossierChronoEvent[], kase, interviews as never);
}
/**
 * The determination the panel DISPLAYS — read from the recorded basis.
 *
 * This called the shared builder, which derives every conclusion from the
 * current record; the recorded basis only coloured the hash. So a physician
 * looking at an approved recommendation could be shown a probability class,
 * inclusion rationale, confidence or duration verdict that had been recomputed
 * since they approved it, presented as the recorded one.
 *
 * The witness below is reachable only when no basis carries the material
 * conclusions. That state is a BASIS_MISSING / BASIS_STALE finding, which the
 * integrity card surfaces and which blocks a final export.
 */
function assessmentForItem(it: AnyRec, data: AnyRec): ReasoningAssessment {
  const { kase, interviews } = caseInputs(it, data);
  const items = (data.futureCareItems ?? []) as ReasoningItem[];
  const { flags, replacedByActive } = detectSetConflicts(items);
  const live = { conflictFlags: flags.get(it.id) ?? [], physicianReviewStatus: (it.physicianStatus as string | undefined) ?? undefined };
  const recorded = ((data.recommendationBases ?? []) as AnyRec[]).find((b) => b.futureCareItemId === it.id) as BasisRecord | undefined;
  const fromBasis = recorded ? assessmentFromBasis(recorded, live) : null;
  if (fromBasis) return fromBasis;
  return deriveWitnessAssessment(
    it as ReasoningItem,
    (data.conditions ?? []) as never,
    (data.chronologyEvents ?? []) as DossierChronoEvent[],
    kase,
    {
      interviews: interviews as never,
      setContext: { conflicts: flags.get(it.id) ?? [], replacedByActive: replacedByActive.has(it.id) },
      handEnteredEvidence: ((data.physicianEvidence ?? []) as AnyRec[]).filter((e) => e.futureCareItemId === it.id) as never,
    },
  );
}


// Manually add a future-care item (docs: templates miss case-specific care;
// the item enters the normal lifecycle: PENDING review, validated, assessed).
const CARE_CATEGORIES = ["PHYSICIAN_VISIT","SPECIALIST_VISIT","PRIMARY_CARE","ORTHOPEDIC_SURGERY","NEUROSURGERY","NEUROLOGY","PMR","PAIN_MANAGEMENT","PSYCH","PHYSICAL_THERAPY","OCCUPATIONAL_THERAPY","SPEECH_THERAPY","COGNITIVE_THERAPY","MEDICATION","INJECTION","IMAGING","LABS","DME","ORTHOTICS_PROSTHETICS","MOBILITY_AID","HOME_MODIFICATION","VEHICLE_MODIFICATION","ATTENDANT_CARE","SKILLED_NURSING","CASE_MANAGEMENT","VOCATIONAL_REHAB","FUTURE_SURGERY","REVISION_SURGERY","COMPLICATION_MANAGEMENT","ASSISTIVE_TECH","SUPPLIES","TRANSPORTATION","MISC"];

function AddCareItemForm({ data, call, onDone }: { data: AnyRec; call: any; onDone: () => void }) {
  const [f, setF] = useState<AnyRec>({ service: "", category: "SPECIALIST_VISIT", specialty: "", conditionId: "", rationale: "", cptCode: "", probability: "POSSIBLE", frequencyPerYear: "1", durationYears: "", isLifetime: false, unitCost: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x: AnyRec) => ({ ...x, [k]: v }));
  return (
    <div className="card border-brand-200 p-4">
      <div className="mb-2 text-sm font-semibold text-ink-900">Add future-care item</div>
      <p className="mb-3 text-xs text-ink-500">
        For care the records support but the generator did not propose. The item enters physician review like any other — it is never final until reviewed.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs text-ink-600">Service *
          <input className="input mt-0.5 py-1.5 text-sm" value={f.service} onChange={(e) => set("service", e.target.value)} placeholder="e.g. Aquatic therapy program" /></label>
        <label className="text-xs text-ink-600">Category *
          <select className="input mt-0.5 py-1.5 text-sm" value={f.category} onChange={(e) => set("category", e.target.value)}>
            {CARE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
          </select></label>
        <label className="text-xs text-ink-600">Specialty *
          <input className="input mt-0.5 py-1.5 text-sm" value={f.specialty} onChange={(e) => set("specialty", e.target.value)} placeholder="e.g. Physical Therapy" /></label>
        <label className="text-xs text-ink-600">Supporting diagnosis
          <select className="input mt-0.5 py-1.5 text-sm" value={f.conditionId} onChange={(e) => set("conditionId", e.target.value)}>
            <option value="">— select —</option>
            {(data.conditions ?? []).map((c: AnyRec) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className="text-xs text-ink-600">Probability
          <select className="input mt-0.5 py-1.5 text-sm" value={f.probability} onChange={(e) => set("probability", e.target.value)}>
            <option value="PROBABLE">Probable</option><option value="POSSIBLE">Possible</option><option value="SPECULATIVE">Speculative</option>
          </select></label>
        <label className="text-xs text-ink-600">CPT code
          <input className="input mt-0.5 py-1.5 text-sm" value={f.cptCode} onChange={(e) => set("cptCode", e.target.value)} /></label>
        <label className="text-xs text-ink-600">Frequency / year *
          <input type="number" min={0} step="0.1" className="input mt-0.5 py-1.5 text-sm" value={f.frequencyPerYear} onChange={(e) => set("frequencyPerYear", e.target.value)} /></label>
        <label className="text-xs text-ink-600">Duration (years)
          <input type="number" min={0} step="0.5" className="input mt-0.5 py-1.5 text-sm" value={f.durationYears} disabled={f.isLifetime} onChange={(e) => set("durationYears", e.target.value)} /></label>
        <label className="mt-5 flex items-center gap-1.5 text-xs text-ink-600">
          <input type="checkbox" checked={f.isLifetime} onChange={(e) => set("isLifetime", e.target.checked)} /> Lifetime care</label>
        <label className="text-xs text-ink-600">Unit cost (USD) *
          <input type="number" min={0} className="input mt-0.5 py-1.5 text-sm" value={f.unitCost} onChange={(e) => set("unitCost", e.target.value)} /></label>
        <label className="text-xs text-ink-600 sm:col-span-2">Clinical rationale * <span className="text-ink-400">(cite the record basis)</span>
          <textarea className="input mt-0.5 h-16 py-1.5 text-sm" value={f.rationale} onChange={(e) => set("rationale", e.target.value)} placeholder="Why this care is reasonably anticipated for this patient, per the records…" /></label>
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={async () => {
          setErr(null); setBusy(true);
          try {
            const body = {
              service: f.service, category: f.category, specialty: f.specialty,
              conditionId: f.conditionId || null, rationale: f.rationale, cptCode: f.cptCode || null,
              probability: f.probability, frequencyPerYear: Number(f.frequencyPerYear),
              durationYears: f.isLifetime ? null : f.durationYears === "" ? null : Number(f.durationYears),
              isLifetime: f.isLifetime, unitCost: Number(f.unitCost),
            };
            const r = await call(`/api/cases/${data.id}/future-care`, "POST", body, "addcare");
            if (r?.item) onDone();
            else setErr(r?.error ?? "Could not add the item.");
          } finally { setBusy(false); }
        }}>{busy ? "Adding…" : "Add item"}</button>
        <button className="btn-outline px-3 py-1.5 text-xs" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function FutureCarePanel({ data, canEdit, canAddEvidence = false, attorneyView = false, call, focusId, focusCat }: { data: AnyRec; canEdit: boolean; canAddEvidence?: boolean; attorneyView?: boolean; call: any; focusId?: string | null; focusCat?: string | null }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string>("All");
  // Review-at-scale controls (Phase 11): search, probability / MD-status
  // filters, sorting, compact density, expand/collapse all.
  const [q, setQ] = useState("");
  const [prob, setProb] = useState("");
  const [phys, setPhys] = useState("");
  const [sortKey, setSortKey] = useState<CareSortKey>(attorneyView ? "service" : "presentValue");
  const [compact, setCompact] = useState(false);
  const toggleOpen = (id: string) => setOpenIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Deep-link: when the assistant focuses an item, make sure it is visible
  // (reset filters) and auto-expand its details so the finding's section can
  // be highlighted in place.
  useEffect(() => {
    if (focusId && data.futureCareItems.some((it: AnyRec) => it.id === focusId)) {
      setFilter("All"); setQ(""); setProb(""); setPhys("");
      setOpenIds((s) => new Set(s).add(focusId));
    }
  }, [focusId, data.futureCareItems]);
  const [showAdd, setShowAdd] = useState(false);
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline to generate future care recommendations.</Empty>;

  // Organize by care category group; chips allow selective viewing per group.
  const groups = CARE_GROUPS
    .map((g) => ({ ...g, items: filterSortCare(data.futureCareItems.filter((it: AnyRec) => g.cats.includes(it.category)) as never, { q, probability: prob, physicianStatus: phys, sortKey }) as AnyRec[] }))
    .filter((g) => g.items.length > 0);
  const shown = filter === "All" ? groups : groups.filter((g) => g.title === filter);
  const shownCount = shown.reduce((s, g) => s + g.items.length, 0);
  const allShownIds = shown.flatMap((g) => g.items.map((it: AnyRec) => it.id as string));

  return (
    <div className="space-y-5">
      {showAdd && canEdit && <AddCareItemForm data={data} call={call} onDone={() => setShowAdd(false)} />}
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && !showAdd && (
          <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => setShowAdd(true)}>+ Add item</button>
        )}
        <input className="input w-52 py-1.5 text-sm" placeholder="Search recommendations…" aria-label="Search recommendations" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by probability" value={prob} onChange={(e) => setProb(e.target.value)}>
          <option value="">All probabilities</option>
          {["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"].map((p) => <option key={p} value={p}>{p.replace(/_/g, " ").toLowerCase()}</option>)}
        </select>
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by physician status" value={phys} onChange={(e) => setPhys(e.target.value)}>
          <option value="">All MD statuses</option>
          {["PENDING", "APPROVED", "MODIFIED", "REJECTED"].map((p) => <option key={p} value={p}>MD: {p.toLowerCase()}</option>)}
        </select>
        <select className="input w-auto py-1.5 text-sm" aria-label="Sort recommendations" value={sortKey} onChange={(e) => setSortKey(e.target.value as CareSortKey)}>
          {!attorneyView && <option value="presentValue">Sort: present value</option>}
          {!attorneyView && <option value="lifetimeCost">Sort: lifetime cost</option>}
          <option value="service">Sort: name</option>
          <option value="physicianStatus">Sort: MD status</option>
        </select>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-ink-400">{shownCount} of {data.futureCareItems.length}</span>
          <button className="focusable rounded font-medium text-ink-500 hover:text-ink-800" onClick={() => setCompact((c) => !c)}>{compact ? "Detailed view" : "Compact view"}</button>
          <button className="focusable rounded font-medium text-brand-700 hover:underline" onClick={() => setOpenIds(new Set(allShownIds))}>Expand all</button>
          <button className="focusable rounded font-medium text-ink-500 hover:text-ink-800" onClick={() => setOpenIds(new Set())}>Collapse all</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" count={data.futureCareItems.length} active={filter === "All"} onClick={() => setFilter("All")} />
        {groups.map((g) => (
          <FilterChip key={g.title} label={g.title} count={g.items.length} icon={g.icon} active={filter === g.title} onClick={() => setFilter(g.title)} />
        ))}
      </div>

      {shownCount === 0 && <Empty>No recommendations match the current filters.</Empty>}

      {shown.map((g) => (
        <div key={g.title}>
          <div className="mb-2 flex items-center gap-2 border-b border-ink-200 pb-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700"><g.icon className="h-4.5 w-4.5" /></div>
            <h3 className="text-sm font-semibold text-ink-900">{g.title}</h3>
            <span className="text-xs text-ink-400">{g.items.length} item{g.items.length === 1 ? "" : "s"}</span>
            {!attorneyView && <span className="ml-auto text-xs font-medium text-brand-800">{formatMoney(g.items.reduce((s: number, it: AnyRec) => s + it.presentValue, 0))} PV</span>}
          </div>
          <div className="space-y-2">
      {g.items.map((it: AnyRec) => (
        <div key={it.id} id={`fc-${it.id}`} className={cn("card scroll-mt-24 transition-shadow", compact ? "p-2.5" : "p-4", focusId === it.id && "ring-2 ring-brand-400 ring-offset-2")}>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              {/* The service name gets its own line. Sharing a wrapping flex
                  row with the badges meant a long name — "Functional
                  restoration program (3-day evaluation + 160 hours)" — took
                  the line, one badge fitted beside it and the rest broke
                  away, splitting the badge group across two rows at a
                  different point for every item. */}
              <h4 className={cn("break-words font-semibold text-ink-900", compact ? "text-sm" : "text-base")}>{it.service}</h4>
              {/* The badges wrap as one group, so they break together or not
                  at all. */}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone={PROB_TONE[it.probability]}>{it.probability.toLowerCase()}</Badge>
                {!compact && <Badge tone={VULN_TONE[it.defenseVulnerability]} title="How exposed this item is to defense challenge, from the engine's weakening-evidence analysis">defense vulnerability: {it.defenseVulnerability.toLowerCase()}</Badge>}
                {(it.origin === "PLANNER_ADDED" || it.origin === "PHYSICIAN_ADDED") && <Badge tone="brand" title="This item was added manually, not generated from the care templates">{it.origin === "PHYSICIAN_ADDED" ? "physician-added" : "manually added"}</Badge>}
                <Badge tone={PHYS_TONE[it.physicianStatus]}>MD: {it.physicianStatus.toLowerCase()}</Badge>
                {!compact && it.edited && <Badge tone="amber">edited</Badge>}
              </div>
              {!compact && (
                <p className="mt-1 text-xs text-ink-500">
                  {it.category.replace(/_/g, " ").toLowerCase()} · {it.specialty}
                  {/* Codes and frequency are clinical detail — hidden from the attorney view. */}
                  {!attorneyView && <> · {it.cptCode || "no CPT"} · {it.frequencyPerYear}/yr {it.isLifetime ? "for life" : it.durationYears ? `× ${it.durationYears}y` : ""}</>}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-4">
              {!attorneyView && (
                <div className="text-right">
                  <div className="num-metric text-sm text-brand-800">{formatMoney(it.presentValue)}</div>
                  {!compact && <div className="text-xs text-ink-400">PV · {formatMoney(it.lifetimeCost)} lifetime</div>}
                </div>
              )}
              <button
                className="focusable rounded text-xs font-medium text-brand-700 hover:underline"
                aria-expanded={openIds.has(it.id)}
                onClick={() => toggleOpen(it.id)}
              >
                {openIds.has(it.id) ? "Hide" : "Details"}
              </button>
            </div>
          </div>
          {openIds.has(it.id) && (
            <div className="mt-3 border-t border-ink-100 pt-3">
              <RecommendationDossierView
                dossier={dossierForItem(it, data)}
                assessment={assessmentForItem(it, data)}
                highlight={focusId === it.id ? focusCat : null}
                condensed={attorneyView}
                physicianEvidence={((data.physicianEvidence ?? []) as AnyRec[]).filter((e) => e.futureCareItemId === it.id)}
                recordedEvidence={((data.recordedEvidence ?? []) as AnyRec[]).filter((e) => e.futureCareItemId === it.id)}
                basisState={basisStateFor(it, data)}
                witnessLedger={witnessDossierForItem(it, data).ledger as unknown as EvidenceRowIdentity[]}
                onAddEvidence={
                  canAddEvidence
                    ? async (input) => {
                        // `call` refreshes the route on success and surfaces
                        // the server's own message on failure, so the resolver's
                        // refusal reaches the physician verbatim.
                        const out = await call(`/api/cases/${data.id}/future-care/${it.id}/evidence`, "POST", input, "evidence");
                        return out ? null : "The citation was not attached.";
                      }
                    : undefined
                }
              />
              {!attorneyView && (
                <div data-focus-target={focusId === it.id && focusCat && /cpt|pricing|duplicate_cost/.test(focusCat) ? "" : undefined} className={cn("mt-3 border-t border-ink-100 pt-2 text-sm text-ink-600", focusId === it.id && focusCat && /cpt|pricing|duplicate_cost/.test(focusCat) && "rounded-md bg-amber-50 p-2 ring-2 ring-amber-400")}>
                  <span className="text-xs font-medium text-ink-500">Cost basis: </span>{formatMoney(it.unitCost)}/unit · {it.pricingSource} · range {formatMoney(it.lowCost)}–{formatMoney(it.highCost)}
                  {it.lowerCostAlternative ? <> · <span className="text-xs font-medium text-ink-500">Alternative: </span>{it.lowerCostAlternative}</> : null}
                </div>
              )}
              {canEdit && <InlineItemEdit item={it} caseId={data.id} call={call} />}
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
    <select className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs" aria-label="Probability" value={item.probability} onChange={(e) => call(`/api/cases/${caseId}/future-care/${item.id}`, "PATCH", { probability: e.target.value })}>
      {["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"].map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
    </select>
  );
}

// Inline recommendation editing — no browser prompt()/confirm() dialogs (they
// are blocked in embedded browsers). Frequency and unit cost edit in place;
// Remove is a two-step confirm.
function InlineItemEdit({ item, caseId, call }: { item: AnyRec; caseId: string; call: any }) {
  const [freq, setFreq] = useState(String(item.frequencyPerYear ?? 1));
  const [cost, setCost] = useState(String(item.unitCost ?? 0));
  const [dur, setDur] = useState<string>(item.isLifetime ? "" : String(item.durationYears ?? ""));
  const [life, setLife] = useState<boolean>(!!item.isLifetime);
  const durChanged = life !== !!item.isLifetime || (!life && dur !== String(item.durationYears ?? ""));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const freqChanged = Number(freq) !== item.frequencyPerYear && Number.isFinite(Number(freq));
  const costChanged = Number(cost) !== item.unitCost && Number.isFinite(Number(cost));
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 pt-1">
      <InlineProbability item={item} caseId={caseId} call={call} />
      <label className="text-[11px] text-ink-500">
        Frequency / yr
        <input type="number" min={0} className="input mt-0.5 w-24 py-1 text-xs" value={freq} onChange={(e) => setFreq(e.target.value)} />
      </label>
      <label className="text-[11px] text-ink-500">
        Unit cost (USD)
        <input type="number" min={0} className="input mt-0.5 w-28 py-1 text-xs" value={cost} onChange={(e) => setCost(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        Duration (yrs)
        <input type="number" min={0} step="0.5" className="input mt-0.5 w-20 py-1 text-xs" value={dur} disabled={life} onChange={(e) => setDur(e.target.value)} />
      </label>
      <label className="mt-4 flex items-center gap-1 text-xs text-ink-500">
        <input type="checkbox" checked={life} onChange={(e) => setLife(e.target.checked)} /> Lifetime
      </label>
      {(freqChanged || costChanged || durChanged) && (
        <button
          className="btn-primary px-2.5 py-1 text-xs"
          onClick={async () => {
            const body: AnyRec = {};
            if (freqChanged) body.frequencyPerYear = Number(freq);
            if (costChanged) body.unitCost = Number(cost);
            if (durChanged) { body.isLifetime = life; body.durationYears = life ? null : dur === "" ? null : Number(dur); }
            await call(`/api/cases/${caseId}/future-care/${item.id}`, "PATCH", body);
          }}
        >
          Save changes
        </button>
      )}
      {confirmRemove ? (
        <span className="flex items-center gap-2">
          <button className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700" onClick={async () => { setConfirmRemove(false); await call(`/api/cases/${caseId}/future-care/${item.id}`, "DELETE"); }}>
            Confirm remove
          </button>
          <button className="text-xs font-medium text-ink-500 hover:underline" onClick={() => setConfirmRemove(false)}>Cancel</button>
        </span>
      ) : (
        <button className="py-1 text-xs font-medium text-red-600 hover:underline" onClick={() => setConfirmRemove(true)}>Remove</button>
      )}
    </div>
  );
}

// ── Costs ────────────────────────────────────────────────────────────────────
// ── Life-expectancy basis (sourced projection horizon) ───────────────────────
// Shows WHERE the lifetime projection horizon comes from: an actuarial table
// baseline for the patient's age and sex, documented adjustments with reason +
// source, or a physician determination — with physician sign-off. When no basis
// is recorded, the validation layer raises a finding (blocking above $100k of
// lifetime present value), and this card is where it gets resolved.
function LifeExpectancyBasisCard({ data, canEdit, canApprove, call }: { data: AnyRec; canEdit: boolean; canApprove: boolean; call: any }) {
  const basis = data.lifeExpectancyBasis as AnyRec | null;
  const [adj, setAdj] = useState({ deltaYears: 0, reason: "", source: "" });
  const [phys, setPhys] = useState({ years: 0, source: "", reason: "" });
  const [showPhys, setShowPhys] = useState(false);
  const put = (body: AnyRec) => call(`/api/cases/${data.id}/life-expectancy`, "PUT", body, "lebasis");
  const methodLabel =
    basis?.method === "PHYSICIAN_DETERMINED" ? "Physician-determined" : basis?.method === "ADJUSTED" ? "Actuarial baseline, adjusted" : basis?.method === "ACTUARIAL_BASELINE" ? "Actuarial baseline" : "Unstated";
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Life-Expectancy Basis</h3>
        <Badge tone={basis ? (basis.approvedAt ? "success" : "brand") : "warning"}>{basis ? (basis.approvedAt ? "approved" : methodLabel.toLowerCase()) : "not recorded"}</Badge>
      </div>
      {!basis ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink-600">
            The {Number(data.lifeExpectancyYears ?? 0) > 0 ? `${Number(data.lifeExpectancyYears).toFixed(1)}-year` : ""} projection horizon every lifetime item multiplies through has no recorded basis. Derive it from the actuarial table, or record a physician determination.
          </p>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary py-1.5 text-sm" onClick={() => put({ mode: "actuarial", adjustments: [] })} disabled={!data.dateOfBirth} title={!data.dateOfBirth ? "Requires the patient's date of birth on intake" : undefined}>
                Use actuarial baseline (SSA table)
              </button>
              <button className="btn-outline py-1.5 text-sm" onClick={() => setShowPhys((s) => !s)}>Record physician determination…</button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-sm text-ink-700">
          {basis.baselineLabel && (
            <p><span className="font-medium text-ink-500">Baseline:</span> {basis.baselineYears?.toFixed?.(1) ?? basis.baselineYears} yrs — {basis.baselineLabel}</p>
          )}
          {(basis.adjustments ?? []).map((a: AnyRec, i: number) => (
            <p key={i} className="pl-3 text-xs text-ink-600">
              {a.deltaYears >= 0 ? "+" : ""}{Number(a.deltaYears).toFixed(1)} yrs — {a.reason || <span className="text-amber-700">no reason recorded</span>}
              {" "}<span className="text-ink-400">({a.source || "no source"}{a.enteredByName ? ` · ${a.enteredByName}` : ""})</span>
            </p>
          ))}
          <p><span className="font-medium text-ink-500">Determined:</span> <span className="font-semibold text-ink-900">{Number(basis.determinedYears).toFixed(1)} years</span>{basis.approvedByName ? ` · approved by ${basis.approvedByName}` : ""}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {canApprove && !basis.approvedAt && (
              <button className="btn-primary py-1 text-xs" onClick={() => put({ mode: "approve" })}>Approve determination</button>
            )}
            {canEdit && basis.method !== "PHYSICIAN_DETERMINED" && data.dateOfBirth && (
              <button className="btn-outline py-1 text-xs" onClick={() => put({ mode: "actuarial", adjustments: (basis.adjustments ?? []).map((a: AnyRec) => ({ deltaYears: a.deltaYears, reason: a.reason, source: a.source })) })}>
                Re-derive at current age
              </button>
            )}
            {canEdit && <button className="btn-outline py-1 text-xs" onClick={() => setShowPhys((s) => !s)}>Physician determination…</button>}
            {canEdit && <button className="btn-outline py-1 text-xs text-ink-500" onClick={() => put({ mode: "clear" })}>Clear</button>}
          </div>
        </div>
      )}
      {canEdit && basis && basis.method !== "PHYSICIAN_DETERMINED" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
          <NumField label="Adjustment (± yrs)" value={adj.deltaYears} step={0.5} onChange={(v) => setAdj({ ...adj, deltaYears: v })} />
          <input className="input w-56 py-1.5 text-sm" placeholder="Clinical reason" aria-label="Adjustment reason" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
          <input className="input w-56 py-1.5 text-sm" placeholder="Source (report / literature)" aria-label="Adjustment source" value={adj.source} onChange={(e) => setAdj({ ...adj, source: e.target.value })} />
          <button
            className="btn-outline py-1.5 text-sm"
            disabled={!adj.deltaYears || !adj.reason.trim() || !adj.source.trim()}
            onClick={() => {
              put({ mode: "actuarial", adjustments: [...(basis.adjustments ?? []).map((a: AnyRec) => ({ deltaYears: a.deltaYears, reason: a.reason, source: a.source })), { deltaYears: adj.deltaYears, reason: adj.reason.trim(), source: adj.source.trim() }] });
              setAdj({ deltaYears: 0, reason: "", source: "" });
            }}
          >
            Add adjustment
          </button>
        </div>
      )}
      {canEdit && showPhys && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
          <NumField label="Determined yrs" value={phys.years} step={0.5} onChange={(v) => setPhys({ ...phys, years: v })} />
          <input className="input w-56 py-1.5 text-sm" placeholder="Source (e.g. IME of Dr. …)" aria-label="Determination source" value={phys.source} onChange={(e) => setPhys({ ...phys, source: e.target.value })} />
          <input className="input w-56 py-1.5 text-sm" placeholder="Clinical rationale" aria-label="Determination rationale" value={phys.reason} onChange={(e) => setPhys({ ...phys, reason: e.target.value })} />
          <button
            className="btn-primary py-1.5 text-sm"
            disabled={!phys.years || !phys.source.trim() || !phys.reason.trim()}
            onClick={() => {
              put({ mode: "physician", years: phys.years, source: phys.source.trim(), reason: phys.reason.trim() });
              setShowPhys(false);
              setPhys({ years: 0, source: "", reason: "" });
            }}
          >
            Record determination
          </button>
        </div>
      )}
    </div>
  );
}

function CostsPanel({ data, assumptions, totals, canEdit, canApprove, call, focusId }: { data: AnyRec; assumptions: AnyRec; totals: AnyRec; canEdit: boolean; canApprove: boolean; call: any; focusId?: string | null }) {
  const [a, setA] = useState({
    lifeExpectancyYears: Number(assumptions.lifeExpectancyYears.toFixed(1)),
    discountRate: assumptions.discountRate,
    medicalInflation: assumptions.medicalInflation,
    geographicFactor: assumptions.geographicFactor,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [costCat, setCostCat] = useState("");
  const [costSort, setCostSort] = useState("presentValue");
  const [recomputeReason, setRecomputeReason] = useState("");
  // Deep-link from the Case Assistant: expand the focused line's cost details.
  useEffect(() => {
    if (focusId && data.futureCareItems.some((it: AnyRec) => it.id === focusId)) { setCostCat(""); setOpen(focusId); }
  }, [focusId, data.futureCareItems]);
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline to project costs.</Empty>;
  const costCategories = [...new Set(data.futureCareItems.map((it: AnyRec) => it.category as string))].sort() as string[];
  const notTotaled = (it: AnyRec) => it.contingencyOnly || it.physicianStatus === "REJECTED";
  const costRows = (data.futureCareItems as AnyRec[])
    .filter((it) => !costCat || it.category === costCat)
    .sort((x, y) => (y[costSort] ?? 0) - (x[costSort] ?? 0));
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
          // Assumption changes are ledgered with an optional reason — captured
          // inline (browser prompt() is blocked in embedded browsers). A
          // recompute affects downstream physician-reviewed totals, so the
          // action is explicit and the audit ledger records every change.
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              className="input w-72 py-1.5 text-sm"
              placeholder="Reason for change (optional — audit ledger)"
              aria-label="Reason for assumption change"
              value={recomputeReason}
              onChange={(e) => setRecomputeReason(e.target.value)}
            />
            <button
              className="btn-primary py-1.5"
              onClick={() => {
                call(`/api/cases/${data.id}`, "PATCH", { ...a, assumptionReason: recomputeReason.trim() || undefined }, "recompute");
                setRecomputeReason("");
              }}
            >
              Recompute Costs
            </button>
          </div>
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
      <LifeExpectancyBasisCard data={data} canEdit={canEdit} canApprove={canApprove} call={call} />
      {/* Cost table controls (Phase 12) — filter + sort are view-only; the
          Total row always reflects the SERVER-computed case totals so a
          filtered view can never misstate the damages figure. */}
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1.5 text-sm" aria-label="Filter by category" value={costCat} onChange={(e) => setCostCat(e.target.value)}>
          <option value="">All categories</option>
          {costCategories.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
        </select>
        <select className="input w-auto py-1.5 text-sm" aria-label="Sort cost rows" value={costSort} onChange={(e) => setCostSort(e.target.value)}>
          <option value="presentValue">Sort: present value</option>
          <option value="lifetimeCost">Sort: lifetime</option>
          <option value="annualCost">Sort: annual</option>
        </select>
        <span className="ml-auto text-meta">
          {costRows.length} of {data.futureCareItems.length} rows · <span className="text-emerald-700">included</span> rows enter totals; <span className="text-ink-500">contingent/excluded</span> rows are disclosed only
        </span>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr><th className="px-4 py-2 font-medium">Service</th><th className="px-4 py-2 font-medium">Basis</th><th className="px-4 py-2 font-medium">Annual</th><th className="px-4 py-2 font-medium">Low</th><th className="px-4 py-2 font-medium">Lifetime</th><th className="px-4 py-2 font-medium">Present Value</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {costRows.map((it: AnyRec) => (
              <Fragment key={it.id}>
                <tr id={`fc-${it.id}`} className={cn("scroll-mt-24", notTotaled(it) && "opacity-60", focusId === it.id && "bg-amber-50 ring-2 ring-inset ring-amber-400")}>
                  <td className="px-4 py-2 text-ink-800">
                    {it.service}
                    {it.contingencyOnly ? <Badge tone="neutral" className="ml-2" title="Disclosed as a contingency — not entered into totals">contingency</Badge>
                      : it.physicianStatus === "REJECTED" ? <Badge tone="danger" className="ml-2" title="Physician rejected — excluded from totals">excluded</Badge>
                      : it.startTrigger ? <Badge tone="info" className="ml-2" title={`Conditional: ${it.startTrigger}`}>conditional</Badge> : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-500">{it.isLifetime ? "lifetime" : it.durationYears ? `${it.durationYears}y recurring` : "one-time"}</td>
                  <td className="px-4 py-2 tabular-nums text-ink-600">{formatMoney(it.annualCost)}</td>
                  <td className="px-4 py-2 tabular-nums text-ink-500">{formatMoney(it.lowCost)}</td>
                  <td className="px-4 py-2 tabular-nums text-ink-600">{formatMoney(it.lifetimeCost)}</td>
                  <td className="px-4 py-2 font-medium tabular-nums text-brand-800">{formatMoney(it.presentValue)}</td>
                  <td className="px-4 py-2 text-right"><button className="focusable rounded text-xs font-medium text-brand-700 hover:underline" aria-expanded={open === it.id} onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? "Hide" : "Details"}</button></td>
                </tr>
                {open === it.id && (
                  <tr className="bg-ink-50/60">
                    <td colSpan={7} className="px-4 py-3">
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
            <tr className="bg-ink-50 font-bold"><td className="px-4 py-2">Total — included items (all categories)</td><td /><td /><td /><td className="px-4 py-2 tabular-nums">{formatMoney(totals.totalLifetime)}</td><td className="px-4 py-2 tabular-nums text-brand-800">{formatMoney(totals.totalPresentValue)}</td><td /></tr>
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
function ReviewsPanel({ points, hasPlan, redactPricing = false }: { points: AnyRec[]; hasPlan: boolean; redactPricing?: boolean }) {
  // Pricing-restricted viewers (attorney) see the contested points with all
  // dollar figures withheld; the argument structure is unchanged.
  const rp = (t: unknown) => (redactPricing ? redactMoney(String(t ?? "")) : String(t ?? ""));
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
                <p className="mt-0.5 text-sm text-ink-800">{rp(p.description)}</p>
                {p.sourceRef && <p className="mt-1 text-xs text-ink-500"><span className="font-medium">Source:</span> {rp(p.sourceRef)}</p>}
              </div>

              {/* Counter */}
              {p.counterArgument && (
                <div className="mt-2 rounded-lg border-l-4 border-emerald-300 bg-emerald-50/60 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">{counter} counter</p>
                  <p className="mt-0.5 text-sm text-ink-800">{rp(p.counterArgument)}</p>
                  {p.counterSource && <p className="mt-1 text-xs text-ink-500"><span className="font-medium">Support:</span> {rp(p.counterSource)}</p>}
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
// Inline review forms (no window.prompt/confirm — those are blocked in embedded
// browsers and gave the reviewer no way to reject or modify). Every action the
// API supports is exposed: approve (optional note), modify (note + probability
// + frequency + duration), reject (reason required), and reopen to Pending.
function PhysicianReviewForm({ it, mode, onSubmit, onCancel }: { it: AnyRec; mode: "approve" | "modify" | "reject"; onSubmit: (body: AnyRec) => void; onCancel: () => void }) {
  const [note, setNote] = useState<string>("");
  const [probability, setProbability] = useState<string>(it.probability);
  const [freq, setFreq] = useState<string>(String(it.frequencyPerYear ?? 1));
  const [years, setYears] = useState<string>(it.isLifetime ? "" : String(it.durationYears ?? ""));
  const title = mode === "approve" ? "Approve — optional note for the record" : mode === "modify" ? "Modify — adjust the clinical parameters and state what changed" : "Reject — a documented reason is required";
  const canSubmit = mode !== "reject" || note.trim().length > 0;
  return (
    <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-600">{title}</p>
      {mode === "modify" && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-ink-600">Probability
            <select className="input mt-0.5 w-full py-1 text-sm" value={probability} onChange={(e) => setProbability(e.target.value)}>
              {["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"].map((p) => <option key={p} value={p}>{p.replace(/_/g, " ").toLowerCase()}</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-600">Frequency / year
            <input type="number" min={0} className="input mt-0.5 w-full py-1 text-sm" value={freq} onChange={(e) => setFreq(e.target.value)} />
          </label>
          <label className="text-xs text-ink-600">{it.isLifetime ? "Duration (lifetime)" : "Duration (years)"}
            <input type="number" min={0} disabled={it.isLifetime} placeholder={it.isLifetime ? "for life" : "years"} className="input mt-0.5 w-full py-1 text-sm disabled:opacity-50" value={years} onChange={(e) => setYears(e.target.value)} />
          </label>
        </div>
      )}
      <textarea
        className="input mt-2 w-full py-1.5 text-sm"
        rows={2}
        autoFocus
        placeholder={mode === "approve" ? "Optional medical-necessity note…" : mode === "modify" ? "What changed and why (folded into the summary)…" : "Reason for rejection (required; recorded in the review ledger)…"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          className={cn("py-1.5 text-xs", mode === "reject" ? "rounded-lg bg-red-600 px-3 font-medium text-white hover:bg-red-700 disabled:opacity-40" : "btn-primary")}
          disabled={!canSubmit}
          onClick={() => {
            const body: AnyRec = { status: mode === "approve" ? "APPROVED" : mode === "modify" ? "MODIFIED" : "REJECTED" };
            if (note.trim()) body.note = note.trim();
            if (mode === "modify") {
              if (probability !== it.probability) body.probability = probability;
              const f = Number(freq);
              if (Number.isFinite(f) && f !== it.frequencyPerYear) body.frequencyPerYear = f;
              if (!it.isLifetime) {
                const y = years === "" ? null : Number(years);
                if (y !== it.durationYears) body.durationYears = y;
              }
            }
            onSubmit(body);
          }}
        >
          {mode === "approve" ? "Approve" : mode === "modify" ? "Save modification" : "Reject item"}
        </button>
        <button className="text-xs font-medium text-ink-500 hover:underline" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Electronic attestation (EPIC-005) ────────────────────────────────────────
// The formal signing ceremony: a physician signs an immutable attestation over
// the SPECIFIC recommendation versions they have approved/modified, with their
// credentials snapshotted at signing. A material change to any covered item
// invalidates the signature (shown here with the reason); re-signing supersedes.
function AttestationCard({ caseId, canReview, items }: { caseId: string; canReview: boolean; items: AnyRec[] }) {
  const [state, setState] = useState<AnyRec[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/attestation`);
    if (res.ok) setState((await res.json()).attestations ?? []);
  }, [caseId]);
  useEffect(() => { void load(); }, [load]);
  async function sign() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/cases/${caseId}/attestation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, note: note.trim() || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setError(e.error ?? "Signing failed");
      return;
    }
    setConfirmed(false);
    setNote("");
    load();
  }
  const attestable = items.filter((i) => i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED").length;
  const active = (state ?? []).filter((a) => a.status === "ACTIVE" && a.verification?.valid);
  const invalidated = (state ?? []).find((a) => a.status === "INVALIDATED");
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Physician Attestation</h3>
        {state && (active.length ? <Badge tone="success">attested</Badge> : <Badge tone="warning">not attested</Badge>)}
      </div>
      {active.map((a) => (
        <div key={a.id} className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-sm text-ink-700">
          <p>
            Signed by <span className="font-semibold">{a.physicianName}</span> on {formatDate(a.signedAt)} — covers {a.itemCount} recommendation{a.itemCount === 1 ? "" : "s"},{" "}
            {formatMoney(a.totalPresentValue)} present value.
          </p>
          {a.physicianNote && <p className="mt-1 text-xs text-ink-600">Qualification: {a.physicianNote}</p>}
          <p className="mt-1 font-mono text-[10px] text-ink-400" title="SHA-256 over the signed statement + pinned scope">hash {String(a.contentHash).slice(0, 16)}…</p>
        </div>
      ))}
      {!active.length && invalidated && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800">
          <p className="font-semibold">A prior attestation by {invalidated.physicianName} ({formatDate(invalidated.signedAt)}) was invalidated:</p>
          <p className="mt-0.5">{invalidated.invalidatedReason}</p>
          <p className="mt-0.5">Re-review the changed items and sign again.</p>
        </div>
      )}
      {canReview && (
        <div className="mt-3 border-t border-ink-100 pt-3">
          {attestable === 0 ? (
            <p className="text-xs text-ink-500">Nothing to attest yet — approve or modify recommendations below first. The attestation covers only items you have acted on.</p>
          ) : (
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-xs text-ink-700">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>
                  I have personally reviewed each of the {attestable} approved/modified recommendation{attestable === 1 ? "" : "s"} and attest, to a reasonable degree of medical
                  probability, that each is medically necessary at its stated frequency and duration. My credentials on file will be snapshotted with this signature; a material
                  change to any covered item will invalidate it.
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input className="input w-80 py-1.5 text-xs" placeholder="Optional qualification (recorded verbatim on the attestation)" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn-primary py-1.5 text-sm" disabled={!confirmed || busy} onClick={sign}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Sign attestation
                </button>
              </div>
              {active.length > 0 && <p className="text-[11px] text-ink-400">Signing again supersedes your current attestation with one covering today&apos;s approved set.</p>}
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PhysicianPanel({ data, canReview, attorneyView = false, call }: { data: AnyRec; canReview: boolean; attorneyView?: boolean; call: any }) {
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string; mode: "approve" | "modify" | "reject" } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  // Attorney filter: the specialties requested on intake drive the dropdown.
  const [specialtyFilter, setSpecialtyFilter] = useState<string>("");
  const requestedSpecialties: string[] = [data.specialty, ...(Array.isArray(data.additionalSpecialties) ? data.additionalSpecialties : [])].filter(Boolean);
  const matchesRequested = (have: string) => requestedSpecialties.some((want) => specMatch(String(have), String(want)));
  const offSpecialty: string[] = requestedSpecialties.length
    ? Array.from(new Set((data.futureCareItems as AnyRec[]).filter((it) => it.specialty && !matchesRequested(it.specialty)).map((it) => String(it.specialty))))
    : [];
  const [addingSpecs, setAddingSpecs] = useState(false);
  // "Add for me": append the flagged specialties to the case's Specialty for
  // Review list (canonicalized to the intake list's names where they match).
  async function addOffSpecialties() {
    setAddingSpecs(true);
    try {
      // Canonicalize to the intake list: substring match first, then a
      // singular/plural-insensitive token-subset match ("Orthopedics" →
      // "Orthopedic Surgery"). Unmatched names are kept verbatim.
      const canonical = (spec: string) => MEDICAL_SPECIALTIES.find((m) => specMatch(m, spec)) ?? spec;
      const same = specMatch;
      const merged: string[] = Array.isArray(data.additionalSpecialties) ? [...(data.additionalSpecialties as string[])] : [];
      for (const raw of offSpecialty) {
        const spec = canonical(raw);
        // Skip anything already covered by the primary or an existing entry.
        if (data.specialty && same(spec, String(data.specialty))) continue;
        if (merged.some((m) => same(m, spec))) continue;
        merged.push(spec);
      }
      const r = await call(`/api/cases/${data.id}`, "PATCH", { additionalSpecialties: merged }, "addspec");
      // Keep the integrity check in sync — the advisory clears on re-run.
      if (r) void fetch(`/api/cases/${data.id}/validation`, { method: "POST" });
    } finally {
      setAddingSpecs(false);
    }
  }
  if (data.futureCareItems.length === 0) return <Empty>Run the AI pipeline first to build the physician review packet.</Empty>;

  // Review-speed affordances (Phase 14): live counts double as filters.
  const countOf = (s: string) => data.futureCareItems.filter((i: AnyRec) => i.physicianStatus === s).length;
  const pending = countOf("PENDING");
  const REVIEW_STATES: { key: string; label: string; tone: "warning" | "success" | "info" | "danger" }[] = [
    { key: "PENDING", label: "Pending", tone: "warning" },
    { key: "APPROVED", label: "Approved", tone: "success" },
    { key: "MODIFIED", label: "Modified", tone: "info" },
    { key: "REJECTED", label: "Rejected", tone: "danger" },
  ];
  const items = statusFilter ? data.futureCareItems.filter((i: AnyRec) => i.physicianStatus === statusFilter) : data.futureCareItems;
  const submit = (it: AnyRec, body: AnyRec) => { setForm(null); call(`/api/cases/${data.id}/future-care/${it.id}/physician`, "POST", body); };

  return (
    <div className="space-y-3">
      {!attorneyView && <AttestationCard caseId={data.id} canReview={canReview} items={data.futureCareItems} />}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-ink-600">
        <span className="min-w-0 flex-1">
          Physician review packet — {canReview ? "every item stays Pending until you designate it. Review the paraphrased summary, then approve, modify (adjust probability, frequency, or duration), or reject with a documented reason. A decided item can be reopened." : "read-only: your role cannot sign off on medical necessity."}
        </span>
        {canReview && pending > 0 && (
          confirmAll ? (
            <span className="flex shrink-0 items-center gap-2">
              <button className="btn-primary py-1.5 text-xs" onClick={() => { setConfirmAll(false); call(`/api/cases/${data.id}/future-care/accept-all`, "POST", undefined, "op"); }}>Confirm — sign off on all {pending}</button>
              <button className="text-xs font-medium text-ink-500 hover:underline" onClick={() => setConfirmAll(false)}>Cancel</button>
            </span>
          ) : (
            <button className="btn-primary shrink-0 py-1.5 text-xs" onClick={() => setConfirmAll(true)}>Approve All ({pending})</button>
          )
        )}
      </div>

      {/* Status counts — click to filter */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by review status">
        {REVIEW_STATES.map((s) => {
          const n = countOf(s.key);
          const active = statusFilter === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setStatusFilter(active ? "" : s.key)}
              aria-pressed={active}
              className={cn("focusable rounded-full transition-shadow", active && "ring-2 ring-brand-400 ring-offset-1")}
            >
              <Badge tone={n === 0 ? "neutral" : s.tone}>{s.label} {n}</Badge>
            </button>
          );
        })}
        {statusFilter && <button className="text-xs font-medium text-ink-500 hover:underline" onClick={() => setStatusFilter("")}>Show all</button>}
        {attorneyView && (
          <select
            className="input ml-auto w-auto py-1 text-xs"
            aria-label="Filter by requested specialty"
            value={specialtyFilter}
            onChange={(e) => setSpecialtyFilter(e.target.value)}
          >
            <option value="">All specialties</option>
            {requestedSpecialties.map((sp) => (
              <option key={sp} value={sp}>{sp}</option>
            ))}
          </select>
        )}
      </div>
      {/* Recommended specialties beyond what intake requested — surfaced, never silent. */}
      {offSpecialty.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900">
          The recommendations include {offSpecialty.length === 1 ? "a specialty" : "specialties"} not requested at intake:{" "}
          <span className="font-semibold">{offSpecialty.join(", ")}</span>. Add {offSpecialty.length === 1 ? "it" : "them"} under Specialty for
          Review on the Intake page if this care should be reviewed, or the clinical team can reassign the items.
          <div className="mt-2">
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={addingSpecs} onClick={() => void addOffSpecialties()}>
              {addingSpecs ? "Adding…" : `Add ${offSpecialty.length === 1 ? "it" : "them"} for me`}
            </button>
          </div>
        </div>
      )}

      {items.length === 0 && <Empty>No items with this review status.</Empty>}
      {((): [string | null, AnyRec[]][] => {
        if (!specialtyFilter) return [[null, items]];
        // Token match: item specialties are short forms ("PM&R"); the intake
        // list carries the long names ("Physical Medicine & Rehabilitation (PM&R)").
        const filtered = (items as AnyRec[]).filter((it) => it.specialty && specMatch(String(it.specialty), specialtyFilter));
        return [[specialtyFilter, filtered]];
      })().map(([groupLabel, groupItems]) => (
        <div key={groupLabel ?? "__all"} className="space-y-3">
          {groupLabel && (
            <div className="mt-1 flex items-center gap-2 border-b border-ink-200 pb-1.5">
              <h4 className="text-sm font-semibold text-ink-900">{groupLabel}</h4>
              <span className="text-xs text-ink-400">{groupItems.length} item{groupItems.length === 1 ? "" : "s"}</span>
            </div>
          )}
          {groupItems.map((it: AnyRec) => (
        <div key={it.id} className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-medium text-ink-900">{it.service}</span>
              {attorneyView && (
                <Badge tone={it.specialty && requestedSpecialties.length && !matchesRequested(it.specialty) ? "amber" : "brand"} className="ml-2">
                  {it.specialty || "unassigned"}
                  {it.specialty && requestedSpecialties.length && !matchesRequested(it.specialty) ? " — not requested at intake" : ""}
                </Badge>
              )}
              <Badge tone={PHYS_TONE[it.physicianStatus]} className="ml-2">{it.physicianStatus.toLowerCase()}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen(open === it.id ? null : it.id)}>
                {open === it.id ? "Hide summary" : "Summary"}
              </button>
              {canReview && it.physicianStatus === "PENDING" && (
                <>
                  <button className="btn-outline py-1 text-xs" onClick={() => setForm(form?.id === it.id && form?.mode === "approve" ? null : { id: it.id, mode: "approve" })}>Approve</button>
                  <button className="btn-outline py-1 text-xs" onClick={() => setForm(form?.id === it.id && form?.mode === "modify" ? null : { id: it.id, mode: "modify" })}>Modify</button>
                  <button className="py-1 text-xs font-medium text-red-600 hover:underline" onClick={() => setForm(form?.id === it.id && form?.mode === "reject" ? null : { id: it.id, mode: "reject" })}>Reject</button>
                </>
              )}
              {canReview && it.physicianStatus !== "PENDING" && (
                <>
                  <button className="btn-outline py-1 text-xs" onClick={() => setForm(form?.id === it.id && form?.mode === "modify" ? null : { id: it.id, mode: "modify" })}>Modify</button>
                  <button className="py-1 text-xs font-medium text-ink-500 hover:underline" title="Return this item to Pending for re-review" onClick={() => submit(it, { status: "PENDING" })}>Reopen</button>
                </>
              )}
            </div>
          </div>

          {/* Inline review form — approve note / modify parameters / reject reason */}
          {canReview && form !== null && form.id === it.id && (
            <PhysicianReviewForm key={`${form.id}:${form.mode}`} it={it} mode={form.mode} onSubmit={(body) => submit(it, body)} onCancel={() => setForm(null)} />
          )}

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
      ))}
    </div>
  );
}

// ── Precedents (comparable finalized LCPs, ranked by likeness) ───────────────
const injuryLabel = (s?: string | null) => (s || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
function PrecedentsPanel({ precedents, data }: { precedents: AnyRec[]; data: AnyRec }) {
  const [pq, setPq] = useState("");
  const [compareId, setCompareId] = useState<string | null>(null);
  if (!precedents.length) {
    return <Empty>No precedents in the firm library yet. Add finalized LCPs in Firm Management → LCP Precedent Library, then return here to see the closest comparables to this case.</Empty>;
  }
  const barColor = (n: number) => (n >= 70 ? "bg-emerald-500" : n >= 45 ? "bg-amber-500" : "bg-ink-300");
  const numColor = (n: number) => (n >= 70 ? "text-emerald-600" : n >= 45 ? "text-amber-600" : "text-ink-400");
  const pqLower = pq.trim().toLowerCase();
  const shownPrecedents = pqLower
    ? precedents.filter((p) => `${p.title ?? ""} ${p.diagnosis ?? ""} ${p.jurisdiction ?? ""} ${p.mechanism ?? ""}`.toLowerCase().includes(pqLower))
    : precedents;
  // Side-by-side rows — ONLY fields both records actually carry; a missing
  // value renders as an explicit em-dash, never inferred. Case cost totals are
  // deliberately not recomputed here (the audited totals live in Costs/Report).
  const caseAge = data.dateOfBirth ? Math.floor((Date.now() - new Date(data.dateOfBirth).getTime()) / (365.25 * 24 * 3600 * 1000)) : null;
  const compareRows = (p: AnyRec): [string, string, string][] => [
    ["Diagnosis", data.diagnosis ?? "—", p.diagnosis ?? "—"],
    ["ICD-10", data.icd10Code ?? "—", p.icd10Code ?? "—"],
    ["Specialty", injuryLabel(data.injurySpecialty) || "—", injuryLabel(p.injurySpecialty) || "—"],
    ["Age", caseAge != null ? String(caseAge) : "—", p.age != null ? String(p.age) : "—"],
    ["Jurisdiction", data.jurisdiction ?? "—", p.jurisdiction ?? "—"],
    ["Mechanism", data.caseType ? String(data.caseType).replace(/_/g, " ").toLowerCase() : "—", p.mechanism ? String(p.mechanism).toLowerCase() : "—"],
    ["Present value", "see Costs tab", p.presentValue != null ? formatMoney(p.presentValue) : "—"],
    ["Lifetime cost", "see Costs tab", p.lifetimeCost != null ? formatMoney(p.lifetimeCost) : "—"],
    ["Resolution", "open case", p.outcome ?? "—"],
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">
        Finalized LCPs from your firm library ranked by <span className="font-medium text-ink-700">likeness</span> to {data.clientName}&apos;s case — the closest precedents to compare against, benchmark, and cite.
      </p>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="note">
        Precedent cases are contextual references only — they do not determine medical necessity or the value of this case. Clinical determinations remain the reviewing physician&apos;s.
      </div>
      <div className="flex items-center gap-2">
        <input className="input w-64 py-1.5 text-sm" placeholder="Search precedents…" aria-label="Search precedents" value={pq} onChange={(e) => setPq(e.target.value)} />
        <span className="text-meta">{shownPrecedents.length} of {precedents.length} · ranked by likeness</span>
      </div>
      <div className="space-y-3">
        {shownPrecedents.length === 0 && <Empty>No precedents match the search.</Empty>}
        {shownPrecedents.map((p) => {
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
              <div className="mt-3 flex items-center gap-4">
                <a href={`/api/precedents/${p.id}/view`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                  <ExternalLink className="h-3.5 w-3.5" /> Open precedent LCP
                </a>
                <button className="focusable rounded text-xs font-medium text-brand-700 hover:underline" aria-expanded={compareId === p.id} onClick={() => setCompareId(compareId === p.id ? null : p.id)}>
                  {compareId === p.id ? "Hide comparison" : "Compare side-by-side"}
                </button>
              </div>
              {compareId === p.id && (
                <table className="mt-3 w-full border-t border-ink-100 text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-ink-400">
                      <th className="py-1.5 pr-2 font-medium" />
                      <th className="py-1.5 pr-2 font-medium">This case — {data.clientName}</th>
                      <th className="py-1.5 font-medium">Precedent — {p.title}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {compareRows(p).map(([label, a2, b2]) => (
                      <tr key={label}>
                        <td className="py-1.5 pr-2 font-medium text-ink-500">{label}</td>
                        <td className="py-1.5 pr-2 text-ink-800">{a2}</td>
                        <td className="py-1.5 text-ink-800">{b2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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

function TreatingProvidersPanel({ data, canEdit, canInterview = canEdit, attorneyView = false, call }: { data: AnyRec; canEdit: boolean; canInterview?: boolean; attorneyView?: boolean; call: any }) {
  const [providers, setProviders] = useState<AnyRec[] | null>(null);
  const [patient, setPatient] = useState<AnyRec[]>([]);
  const [openProvider, setOpenProvider] = useState<string | null>(null);

  const loadProviders = useCallback(async (refresh = false) => {
    const res = await fetch(`/api/cases/${data.id}/providers${refresh ? "?refresh=1" : ""}`);
    if (res.ok) setProviders((await res.json()).providers ?? []);
  }, [data.id]);
  const loadPatient = useCallback(async () => {
    const res = await fetch(`/api/cases/${data.id}/interviews?subject=PATIENT`);
    if (res.ok) setPatient((await res.json()).findings ?? []);
  }, [data.id]);
  useEffect(() => { void loadProviders(true); void loadPatient(); }, [loadPatient, loadProviders]);

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
        {canInterview && <InterviewEditor onAdd={(f) => addFinding({ subject: "PATIENT", ...f }, loadPatient)} />}
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
                    <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpenProvider(openProvider === p.id ? null : p.id)}>{openProvider === p.id ? "Hide" : attorneyView ? `Attorney input${p.depositionSummary || p.attorneyNotes ? " ✓" : ""}` : `Interview (${(p.interviewFindings ?? []).length})`}</button>
                  </div>
                </div>
                {openProvider === p.id && (
                  <div className="border-t border-ink-100 p-3">
                    {!attorneyView && <FindingList findings={p.interviewFindings ?? []} canEdit={canEdit} onDelete={(id) => delFinding(id, () => loadProviders())} />}
                    {!attorneyView && canInterview && <InterviewEditor onAdd={(f) => addFinding({ subject: "PROVIDER", providerId: p.id, ...f }, () => loadProviders())} />}
                    {!attorneyView && (p.depositionSummary || p.attorneyNotes) && (
                      <div className="mt-2 rounded-md bg-ink-50 p-2.5 text-sm">
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Attorney-provided context</p>
                        {p.depositionSummary && <p className="mt-1 whitespace-pre-wrap text-ink-700"><span className="text-xs font-medium text-ink-500">Deposition summary: </span>{p.depositionSummary}</p>}
                        {p.attorneyNotes && <p className="mt-1 whitespace-pre-wrap text-ink-700"><span className="text-xs font-medium text-ink-500">Notes: </span>{p.attorneyNotes}</p>}
                      </div>
                    )}
                    {attorneyView && <AttorneyProviderInput caseId={data.id} provider={p} onSaved={() => loadProviders()} />}
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
// Attorney contribution surface: deposition summary + notes (persisted on the
// provider via the attorney-scoped PATCH) and deposition transcript upload
// (ingested into records as a DEPOSITION document, server-enforced).
function AttorneyProviderInput({ caseId, provider, onSaved }: { caseId: string; provider: AnyRec; onSaved: () => void }) {
  const [dep, setDep] = useState<string>(provider.depositionSummary ?? "");
  const [notes, setNotes] = useState<string>(provider.attorneyNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/cases/${caseId}/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depositionSummary: dep.trim() || null, attorneyNotes: notes.trim() || null }),
    });
    setBusy(false);
    setMsg(res.ok ? "Saved." : "Could not save — try again.");
    if (res.ok) onSaved();
  }

  async function upload(file: File) {
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.append("files", file);
    fd.append("typeMap", JSON.stringify({ [file.name]: "DEPOSITION" }));
    const res = await fetch(`/api/cases/${caseId}/documents`, { method: "POST", body: fd });
    setBusy(false);
    setMsg(res.ok ? `Deposition "${file.name}" uploaded to the case records.` : "Upload failed — try again.");
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-ink-500">Your deposition summary and notes for this provider are shared with the clinical team and woven into case context. Uploaded transcripts are filed in the case records as depositions.</p>
      <label className="block text-xs text-ink-600">Deposition summary
        <textarea className="input mt-0.5 w-full py-1.5 text-sm" rows={4} value={dep} onChange={(e) => setDep(e.target.value)} placeholder="Key testimony, opinions on causation and future care, concessions, impeachment points…" />
      </label>
      <label className="block text-xs text-ink-600">Notes
        <textarea className="input mt-0.5 w-full py-1.5 text-sm" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Scheduling, credibility, relationship to the case, follow-ups…" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void save()}>Save</button>
        <label className="btn-outline cursor-pointer px-3 py-1.5 text-xs">
          Upload deposition transcript
          <input type="file" className="hidden" accept=".pdf,.doc,.docx,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        </label>
        {msg && <span className="text-xs text-ink-500">{msg}</span>}
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
  // CRE v1 §15 — the Explorer displays the PERSISTED clinical reasoning
  // assessment for a selected recommendation (the same structured object the
  // report narrative renders from), never a recomputed variant.
  const [assessments, setAssessments] = useState<AnyRec[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async (method: "GET" | "POST" = "GET") => {
    if (method === "POST") setRebuilding(true);
    try {
      const res = await fetch(`/api/cases/${data.id}/evidence`, { method });
      if (res.ok) setLinks((await res.json()).links ?? []);
      else setLoadError("Couldn't load the evidence graph — refresh the page or log in again.");
    } catch {
      setLoadError("Couldn't load the evidence graph — refresh the page or log in again.");
    } finally {
      setRebuilding(false);
    }
  }, [data.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Failures are surfaced, never silent — an empty Explorer must say WHY.
    fetch(`/api/cases/${data.id}/reasoning`)
      .then(async (r) => {
        if (r.ok) setAssessments((await r.json()).assessments ?? []);
        else setLoadError("Couldn't load the reasoning assessments — refresh the page or log in again.");
      })
      .catch(() => setLoadError("Couldn't load the reasoning assessments — refresh the page or log in again."));
  }, [data.id]);

  const conditions: AnyRec[] = useMemo(() => data.conditions ?? [], [data.conditions]);
  const items: AnyRec[] = useMemo(() => data.futureCareItems ?? [], [data.futureCareItems]);
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
        {loadError && <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800" role="alert">{loadError}</p>}
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
          {selType === "futureCareItem" && entity && (() => {
            // ── Evidence provenance chain (Phase 10) ─────────────────────────
            // A structured, accessible node-flow of how this recommendation is
            // grounded: source records → objective finding → diagnosis →
            // functional basis → prior treatment → medical necessity →
            // recommendation → cost → physician review. Every node shows ONLY
            // what the case actually contains; an undocumented step is shown
            // as an honest gap, never filled in. Purple marks AI-synthesized
            // analysis (the persisted assessment); everything else is
            // source-stated record content or workflow state.
            const craForChain = assessments.find((x) => x.recommendationId === selId && x.status !== "SUPERSEDED");
            const recordLinks = [...own, ...inherited].filter((l) => l.kind === "DIAGNOSIS_EVIDENCE");
            const objective = selType === "futureCareItem" ? mappedCond?.objectiveEvidence : null;
            // Prefer the PERSISTED immutable reasoning chain (per-edge rationale,
            // fact/inference/assumption basis); fall back to the computed strip.
            const persistedChain = (Array.isArray(craForChain?.reasoningChain) ? craForChain!.reasoningChain : null) as { stage: string; content: string | null; source: string | null; basis: string; rationale: string }[] | null;
            const chain: { label: string; value: string | null; kind: "source" | "derived" | "workflow" | "assumption"; tip?: string }[] = persistedChain
              ? persistedChain.map((n) => ({
                  label: n.stage,
                  value: n.content ? String(n.content).slice(0, 60) : null,
                  kind: n.basis === "documented_fact" ? "source" : n.basis === "inference" ? "derived" : n.basis === "assumption" ? "assumption" : "workflow",
                  tip: `${n.rationale}${n.source ? ` — Source: ${n.source}` : ""}`,
                }))
              : [
              { label: "Source records", value: recordLinks.length ? `${recordLinks.length} page-cited source${recordLinks.length === 1 ? "" : "s"}` : null, kind: "source" },
              { label: "Objective finding", value: objective ? String(objective).slice(0, 60) : null, kind: "source" },
              { label: "Diagnosis", value: mappedCond?.name ?? null, kind: "source" },
              { label: "Functional basis", value: craForChain?.functionalBasisSummary ? String(craForChain.functionalBasisSummary).slice(0, 60) : null, kind: "derived" },
              { label: "Prior treatment", value: craForChain?.priorTreatmentSummary ? String(craForChain.priorTreatmentSummary).slice(0, 60) : null, kind: "source" },
              { label: "Medical necessity", value: craForChain?.medicalNecessityRationale ? "assessed" : null, kind: "derived" },
              { label: "Recommendation", value: entity.service, kind: "derived" },
              { label: "Cost", value: `PV ${formatMoney(entity.presentValue)}`, kind: "workflow" },
              { label: "Physician review", value: entity.physicianStatus === "PENDING" ? null : String(entity.physicianStatus).toLowerCase(), kind: "workflow" },
            ];
            return (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Evidence provenance</h4>
                <ol className="mt-1.5 flex flex-wrap items-stretch gap-y-2" aria-label="Evidence provenance chain">
                  {chain.map((n, i) => (
                    <li key={n.label} className="flex items-center">
                      {i > 0 && <span aria-hidden className="mx-1 text-ink-300">→</span>}
                      <div
                        title={n.tip ?? n.value ?? "Not documented in the current record"}
                        className={cn(
                          "max-w-[11rem] rounded-md border px-2 py-1",
                          n.value === null
                            ? "border-dashed border-amber-300 bg-amber-50"
                            : n.kind === "derived"
                              ? "border-violet-200 bg-violet-50"
                              : n.kind === "assumption"
                                ? "border-dashed border-amber-300 bg-white"
                                : "border-ink-200 bg-white",
                        )}
                      >
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">{n.label}</p>
                        <p className={cn("truncate text-[11px]", n.value === null ? "italic text-amber-700" : "text-ink-700")}>
                          {n.value ?? "not documented"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-1 text-[10px] text-ink-400">
                  <span className="mr-2"><span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-sm border border-ink-200 bg-white align-middle" />source-stated</span>
                  <span className="mr-2"><span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-sm border border-violet-200 bg-violet-50 align-middle" />AI-synthesized analysis</span>
                  <span><span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-sm border border-dashed border-amber-300 bg-amber-50 align-middle" />not documented</span>
                </p>
              </div>
            );
          })()}
          {selType === "futureCareItem" && (() => {
            const cra = assessments.find((x) => x.recommendationId === selId && x.status !== "SUPERSEDED");
            if (!cra) return null;
            const STATUS_TONE: Record<string, "green" | "amber" | "red" | "neutral"> = { VALIDATED: "green", NEEDS_REVIEW: "amber", INVALID: "red", ERROR: "red", ASSESSED: "neutral" };
            const weakening = (Array.isArray(cra.weakeningEvidence) ? cra.weakeningEvidence : []) as AnyRec[];
            const unknowns = (Array.isArray(cra.unknowns) ? cra.unknowns : []) as AnyRec[];
            const lit = (Array.isArray(cra.supportingLiteratureAssessments) ? cra.supportingLiteratureAssessments : []) as AnyRec[];
            const rejected = (Array.isArray(cra.rejectedLiterature) ? cra.rejectedLiterature : []) as AnyRec[];
            return (
              <div className="rounded-lg border border-brand-100 bg-brand-50/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-700">Clinical reasoning assessment</h4>
                  <Badge tone={STATUS_TONE[cra.status] ?? "neutral"}>{String(cra.status).replace(/_/g, " ").toLowerCase()}</Badge>
                </div>
                <p className="mt-1.5 text-xs text-ink-600">
                  {cra.responsibleSpecialty} · {cra.clinicalPurpose} · {cra.bodyRegion}{cra.laterality && cra.laterality !== "n/a" ? ` (${cra.laterality})` : ""} · {cra.conditionChronicity} · {cra.causalRelationshipStatus}
                </p>
                <p className="mt-1 text-[11px] text-ink-500">
                  <span className="font-medium">Origin:</span> generated by the AI pipeline from the case diagnosis corpus
                  {entity.rationale ? <> — template rationale: “{entity.rationale}”</> : null}
                  {cra.generatedByModel ? <> · engine {String(cra.generatedByModel)}</> : null}
                </p>
                <p className="mt-1.5 text-sm text-ink-800">{cra.medicalNecessityRationale}</p>
                {/* Actionable next steps whenever support is thin — absence of
                    evidence must give the reviewer WORK, not dead ends. */}
                {(() => {
                  const suff = cra.evidenceSufficiency as AnyRec | null;
                  const unk = (Array.isArray(cra.unknowns) ? cra.unknowns : []) as AnyRec[];
                  const steps: string[] = [];
                  if (suff && suff.sufficient === false) for (const m of (suff.missing ?? []) as string[]) steps.push(m);
                  for (const u of unk) if (u.suggestedAction && !steps.includes(u.suggestedAction)) steps.push(u.suggestedAction);
                  if (steps.length === 0) return null;
                  return (
                    <div className="mt-2 rounded-md border border-brand-200 bg-white p-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">What to do next{suff && suff.sufficient === false ? ` — evidence score ${suff.score}/${suff.threshold} required` : ""}</p>
                      <ul className="mt-1 space-y-0.5">{steps.slice(0, 5).map((x, i) => <li key={i} className="text-xs text-ink-700">• {x}</li>)}</ul>
                      <p className="mt-1 text-[10px] text-ink-400">Or: reject the item on physician review if the need cannot be established for this patient.</p>
                    </div>
                  );
                })()}
                <div className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-700 sm:grid-cols-2">
                  <p><span className="font-medium text-ink-500">Probability:</span> {PROBABILITY_LABEL[cra.probabilityClassification as keyof typeof PROBABILITY_LABEL] ?? cra.probabilityClassification}</p>
                  <p><span className="font-medium text-ink-500">Inclusion:</span> {cra.inclusionInTotalsStatus} — {cra.inclusionRationale}</p>
                  <p><span className="font-medium text-ink-500">Frequency:</span> {cra.frequencyRationale}{cra.frequencySupported ? "" : " (unverified)"}</p>
                  <p><span className="font-medium text-ink-500">Duration:</span> {String(cra.durationClass ?? "").replace(/_/g, " ").toLowerCase()} — {cra.durationRationale}</p>
                  <p><span className="font-medium text-ink-500">Evidence strength:</span> {String(cra.evidenceStrength).replace(/_/g, " ").toLowerCase()} <span className="text-ink-400">(published evidence)</span></p>
                  <p><span className="font-medium text-ink-500">Recommendation confidence:</span> {String(cra.recommendationConfidence).toLowerCase()} <span className="text-ink-400">(this patient)</span></p>
                </div>
                {weakening.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Weakening evidence</p>
                    <ul className="mt-0.5 space-y-0.5">{weakening.slice(0, 5).map((w, i) => <li key={i} className="text-xs text-amber-800">{w.detail}{w.source ? ` (${w.source})` : ""} — {String(w.materiality).toLowerCase()} materiality</li>)}</ul>
                  </div>
                )}
                {unknowns.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Unknowns / evidence gaps</p>
                    <ul className="mt-0.5 space-y-0.5">{unknowns.slice(0, 4).map((u, i) => <li key={i} className="text-xs text-ink-700">{u.missing} <span className="text-ink-500">→ {u.suggestedAction}</span></li>)}</ul>
                  </div>
                )}
                {lit.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Accepted literature</p>
                    <ul className="mt-0.5 space-y-0.5">{lit.slice(0, 4).map((l, i) => <li key={i} className="text-xs text-ink-700">{l.title}{l.pmid ? ` · PMID ${l.pmid}` : ""} — supports {l.supports}</li>)}</ul>
                  </div>
                )}
                {rejected.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700">Rejected literature</p>
                    <ul className="mt-0.5 space-y-0.5">{rejected.slice(0, 4).map((r, i) => <li key={i} className="text-xs text-red-800">{r.title} — {r.reason}</li>)}</ul>
                  </div>
                )}
                {/* Multi-dimensional confidence — ten independent dimensions, never one number */}
                {cra.confidenceVector && (
                  <div className="mt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Confidence dimensions <span className="font-normal normal-case text-ink-400">(independent — deliberately not combined)</span></p>
                    <div className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                      {([
                        ["clinicalCertainty", "Clinical certainty"], ["evidenceQuality", "Evidence quality"],
                        ["objectiveEvidence", "Objective evidence"], ["literatureSupport", "Literature support"],
                        ["guidelineSupport", "Guideline support"], ["providerAgreement", "Provider agreement"],
                        ["chronologyConsistency", "Chronology consistency"], ["medicalNecessity", "Medical necessity"],
                        ["contradictoryEvidence", "Contradiction burden"], ["physicianReview", "Physician review"],
                      ] as [string, string][]).map(([k, label]) => {
                        const v = Number((cra.confidenceVector as AnyRec)[k] ?? 0);
                        const burden = k === "contradictoryEvidence";
                        return (
                          <div key={k} className="flex items-center gap-2 text-[11px]">
                            <span className="w-40 shrink-0 text-ink-600">{label}</span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                              <div className={cn("h-full rounded-full", burden ? "bg-amber-500" : v >= 70 ? "bg-emerald-500" : v >= 40 ? "bg-brand-500" : "bg-ink-300")} style={{ width: `${v}%` }} />
                            </div>
                            <span className="w-7 text-right tabular-nums text-ink-500">{v}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Self-critique — the engine argues against itself before the physician does */}
                {cra.selfCritique && (() => {
                  const sc = cra.selfCritique as AnyRec;
                  return (
                    <div className="mt-3 rounded-md border border-ink-200 bg-white p-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Self-critique</p>
                      {Array.isArray(sc.whyPossiblyWrong) && sc.whyPossiblyWrong.length > 0 && (
                        <div className="mt-1"><p className="text-[11px] font-medium text-amber-700">Why this could be wrong</p><ul className="mt-0.5 space-y-0.5">{sc.whyPossiblyWrong.map((x: string, i: number) => <li key={i} className="text-xs text-ink-700">{x}</li>)}</ul></div>
                      )}
                      {Array.isArray(sc.assumptions) && sc.assumptions.length > 0 && (
                        <div className="mt-1.5"><p className="text-[11px] font-medium text-ink-500">Assumptions required</p><ul className="mt-0.5 space-y-0.5">{sc.assumptions.map((x: string, i: number) => <li key={i} className="text-xs text-ink-700">{x}</li>)}</ul></div>
                      )}
                      {Array.isArray(sc.recordsThatWouldChangeConfidence) && sc.recordsThatWouldChangeConfidence.length > 0 && (
                        <div className="mt-1.5"><p className="text-[11px] font-medium text-ink-500">Records that would change confidence</p><ul className="mt-0.5 space-y-0.5">{sc.recordsThatWouldChangeConfidence.map((x: string, i: number) => <li key={i} className="text-xs text-ink-700">{x}</li>)}</ul></div>
                      )}
                      {Array.isArray(sc.inferredNotDocumented) && sc.inferredNotDocumented.length > 0 && (
                        <div className="mt-1.5"><p className="text-[11px] font-medium text-violet-700">Inferred rather than documented</p><ul className="mt-0.5 space-y-0.5">{sc.inferredNotDocumented.map((x: string, i: number) => <li key={i} className="text-xs text-ink-600">{x}</li>)}</ul></div>
                      )}
                      {sc.alternativeRecommendation && <p className="mt-1.5 text-xs text-ink-700"><span className="font-medium text-ink-500">Alternative considered:</span> {sc.alternativeRecommendation}</p>}
                    </div>
                  );
                })()}
                {/* Competing diagnoses from the case's own causation map */}
                {Array.isArray(cra.alternativeExplanations) && (cra.alternativeExplanations as AnyRec[]).length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Alternative explanations on the causation map</p>
                    <ul className="mt-0.5 space-y-0.5">{(cra.alternativeExplanations as AnyRec[]).map((x, i) => <li key={i} className="text-xs text-ink-700"><span className="font-medium">{x.name}</span> ({x.relation}) — {x.whyConsidered}</li>)}</ul>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-ink-500">{cra.residualUncertainty}</p>
              </div>
            );
          })()}
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
function VersionCompareCard({ caseId, embedded = false }: { caseId: string; embedded?: boolean }) {
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
    <div className={embedded ? "" : "card p-5"}>
      {!embedded && <h3 className="text-sm font-semibold text-ink-900">Compare Versions</h3>}
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
// Strip dollar amounts from finding text for pricing-restricted viewers.
function redactMoney(t: string | null | undefined): string {
  return String(t ?? "").replace(/\$\s?[\d,]+(?:\.\d+)?/g, "[amount withheld]");
}

function ValidationCard({ caseId, scope, redactPricing = false, onReview }: { caseId: string; scope?: ReportSelection | null; redactPricing?: boolean; onReview?: (finding: AnyRec) => void }) {
  const [state, setState] = useState<AnyRec | null>(null);
  const [running, setRunning] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [actBusy, setActBusy] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const load = useCallback(async (method: "GET" | "POST" = "GET") => {
    if (method === "POST") setRunning(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/validation`, { method });
      if (res.ok) setState(await res.json());
    } finally {
      setRunning(false);
    }
  }, [caseId]);
  // Disposition a finding: the server updates it, re-runs the validation
  // engine (and the cost pipeline when a correction changed items), and
  // returns the fresh state — so gates update in the same click.
  const act = useCallback(async (findingId: string, action: string) => {
    setActBusy(findingId + action); setActErr(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/validation/${findingId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setActErr(body.error ?? "Action failed.");
      else setState(body);
    } finally {
      setActBusy(null);
    }
  }, [caseId]);
  // Reload whenever the selected report changes so the card always reflects
  // the CURRENT findings for the document the user is looking at.
  useEffect(() => { void load(); }, [load, scope?.id]);
  // The Case Review agent re-runs the pipeline when it dispositions a finding;
  // refresh this card the moment that happens.
  useEffect(() => {
    const h = () => void load();
    window.addEventListener("lifeplanos:validation-updated", h);
    return () => window.removeEventListener("lifeplanos:validation-updated", h);
  }, [load]);
  const allFindings: AnyRec[] = state?.findings ?? [];
  // Scope the DISPLAY to findings relevant to the report selected in the
  // library dropdown. Export gating is unaffected — blocking is computed over
  // every finding regardless of the reader's current lens.
  const scoping = !showAll && scope && scope.findingRelevance !== ".*";
  let relevant: AnyRec[] = allFindings;
  if (scoping) {
    try {
      const re = new RegExp(scope.findingRelevance, "i");
      relevant = allFindings.filter((f) => re.test(`${f.result} ${f.issue}`));
    } catch { relevant = allFindings; }
  }
  const findings = relevant.filter((f) => (f.status ?? "OPEN") === "OPEN");
  const dispositioned = relevant.filter((f) => (f.status ?? "OPEN") !== "OPEN");
  const hiddenCount = allFindings.length - relevant.length;
  const SEV_TONE: Record<string, "red" | "amber" | "neutral"> = { Critical: "red", High: "amber", Moderate: "neutral", Low: "neutral" };
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-900">Report Integrity Check</h3>
          {state && (allFindings.length === 0
            ? <Badge tone="green">clean</Badge>
            : state.blocking
              ? scope?.gate === "disclose"
                ? <Badge tone="amber">{allFindings.filter((f) => f.exportBlocking).length} disclosed on export</Badge>
                : <Badge tone="red">{allFindings.filter((f) => f.exportBlocking).length} export-blocking</Badge>
              : <Badge tone="amber">{allFindings.length} to review</Badge>)}
        </div>
        <button className="btn-outline px-3 py-1.5 text-xs" disabled={running} onClick={() => load("POST")}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Re-run check
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Deterministic validation of every recommendation — diagnosis/region mapping, CPT &amp; pricing consistency, record support, and inclusion eligibility. Critical findings export the report as a DRAFT until resolved.
      </p>
      {scope && (
        <p className={`mt-2 rounded-md px-2 py-1.5 text-xs ${scope.status === "Blocked" ? "bg-red-50 text-red-700" : scope.status === "Ready" || scope.status === "Previously exported" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
          <span className="font-semibold">{scope.name}:</span> {scope.status}
          {scope.gate === "disclose" && state?.blocking ? " — open findings are disclosed on the face of this document; they do not block its export." : ""}
          {scope.gateReason ? ` — ${scope.gateReason}` : ""}
        </p>
      )}
      {scope && scope.findingRelevance !== ".*" && (
        <p className="mt-2 text-xs text-ink-600">
          Showing findings relevant to <span className="font-semibold">{scope.name}</span>
          {scoping && hiddenCount > 0 ? ` — ${hiddenCount} other finding${hiddenCount === 1 ? "" : "s"} hidden` : ""}.{" "}
          <button className="text-brand-700 hover:underline" onClick={() => setShowAll((v) => !v)}>{showAll ? "Scope to this report" : "Show all"}</button>
        </p>
      )}
      {state && state.counts && (
        <p className="mt-2 text-xs text-ink-600">
          {state.counts.included} of {state.counts.proposed} items eligible for the damages total · {state.counts.physicianApproved} physician-approved · {state.counts.awaitingReview} awaiting review
        </p>
      )}
      {/* Blocking findings stay on the face of the card; advisories collapse. */}
      {findings.filter((f) => f.exportBlocking).length > 0 && (
        <ul className="mt-3 space-y-2">
          {findings.filter((f) => f.exportBlocking).map((f) => (
            <li key={f.id} className="rounded-lg bg-ink-50/70 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEV_TONE[f.severity] ?? "neutral"}>{f.severity.toLowerCase()}</Badge>
                <span className="font-semibold text-ink-900">{f.service}</span>
                <span className="text-ink-500">— {redactPricing ? redactMoney(f.result) : f.result} (blocks final export)</span>
              </div>
              <p className="mt-1 text-ink-700">{redactPricing ? redactMoney(f.issue) : f.issue}</p>
              <p className="mt-0.5 text-ink-500"><span className="font-medium">Correction:</span> {redactPricing ? redactMoney(f.suggestion) : f.suggestion}</p>
              {actErr && <p className="mt-1 text-xs text-red-700">{actErr}</p>}
              {onReview && (
                <div className="mt-2 border-t border-ink-100 pt-2">
                  <button className="focusable rounded text-xs font-semibold text-brand-700 hover:underline" onClick={() => onReview(f)}>Review</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {findings.filter((f) => !f.exportBlocking).length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-ink-600">Show {findings.filter((f) => !f.exportBlocking).length} advisory finding{findings.filter((f) => !f.exportBlocking).length === 1 ? "" : "s"}</summary>
          <ul className="mt-2 space-y-2">
            {findings.filter((f) => !f.exportBlocking).map((f) => (
              <li key={f.id} className="rounded-lg bg-ink-50/70 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEV_TONE[f.severity] ?? "neutral"}>{f.severity.toLowerCase()}</Badge>
                  <span className="font-semibold text-ink-900">{f.service}</span>
                  <span className="text-ink-500">— {redactPricing ? redactMoney(f.result) : f.result}</span>
                </div>
                <p className="mt-1 text-ink-700">{redactPricing ? redactMoney(f.issue) : f.issue}</p>
                <p className="mt-0.5 text-ink-500"><span className="font-medium">Correction:</span> {redactPricing ? redactMoney(f.suggestion) : f.suggestion}</p>
              {actErr && <p className="mt-1 text-xs text-red-700">{actErr}</p>}
              {onReview && (
                <div className="mt-2 border-t border-ink-100 pt-2">
                  <button className="focusable rounded text-xs font-semibold text-brand-700 hover:underline" onClick={() => onReview(f)}>Review</button>
                </div>
              )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {dispositioned.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-ink-500">{dispositioned.length} resolved / ignored finding{dispositioned.length === 1 ? "" : "s"}</summary>
          <ul className="mt-2 space-y-2">
            {dispositioned.map((f) => (
              <li key={f.id} className="rounded-lg bg-ink-50/40 p-3 text-xs opacity-80">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{String(f.status).replace(/_/g, " ").toLowerCase()}</Badge>
                  <span className="font-semibold text-ink-900">{f.service}</span>
                  <span className="text-ink-500">— {redactPricing ? redactMoney(f.result) : f.result}</span>
                  <button className="focusable ml-auto rounded text-xs font-medium text-brand-700 hover:underline" disabled={actBusy !== null} onClick={() => void act(f.id, "reopen")}>Reopen</button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {state && findings.length === 0 && (
        <p className="mt-2 text-xs text-emerald-700">Every recommendation is region-matched, consistently coded and priced, and supported for inclusion.</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attorney Report tab — ordering surface, not a generation surface. The
// attorney picks a report, sees its integrity barriers (no pricing values),
// chooses anonymous preparer titles (specialty-level for physicians), and
// submits an Order (a CaseEngagement the firm authorizes and staffs). Final,
// released reports are listed newest-first with prior versions tucked away.
// ─────────────────────────────────────────────────────────────────────────────
// Specialty comparison: word-token subset match, singular/plural-insensitive.
// Never raw substring — "Urology" must not match "Neurology".
function specTokens(t: string): string[] {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
}
function specMatch(a: string, b: string): boolean {
  const at = specTokens(a);
  const bt = specTokens(b);
  if (!at.length || !bt.length) return false;
  return at.every((w) => bt.includes(w)) || bt.every((w) => at.includes(w));
}

const PREPARER_TITLES: Record<string, string> = {
  LIFE_CARE_PLANNER: "Life Care Planner",
  PHYSICIAN_REVIEWER: "Physician Reviewer",
  VOCATIONAL_EXPERT: "Vocational Expert",
  FORENSIC_ECONOMIST: "Forensic Economist",
  QUALITY_ASSURANCE_REVIEWER: "Quality Assurance Reviewer",
};

function attorneyPreparerOptions(def: AnyRec | null): { key: string; label: string; required?: boolean }[] {
  if (!def) return [];
  const opts: { key: string; label: string; required?: boolean }[] = [];
  // A credentialed planner authors every prepared report.
  opts.push({ key: "LIFE_CARE_PLANNER", label: PREPARER_TITLES.LIFE_CARE_PLANNER, required: def.serviceTier === "core" });
  // Physician review is offered wherever the report carries clinical opinions.
  if (def.requiredExpert === "physician" || def.approval === "physician_required" || def.serviceTier === "core" || def.category === "Clinical analysis") {
    opts.push({ key: "PHYSICIAN_REVIEWER", label: PREPARER_TITLES.PHYSICIAN_REVIEWER, required: def.requiredExpert === "physician" || def.approval === "physician_required" });
  }
  if (def.requiredExpert === "vocational") opts.push({ key: "VOCATIONAL_EXPERT", label: PREPARER_TITLES.VOCATIONAL_EXPERT, required: true });
  if (def.requiredExpert === "economist") opts.push({ key: "FORENSIC_ECONOMIST", label: PREPARER_TITLES.FORENSIC_ECONOMIST, required: true });
  opts.push({ key: "QUALITY_ASSURANCE_REVIEWER", label: PREPARER_TITLES.QUALITY_ASSURANCE_REVIEWER });
  return opts;
}

// Request-side readiness: the barriers an ATTORNEY can act on. Clinical
// integrity items (physician review, citations, duplicates) are the clinical
// team's work and are deliberately not surfaced as "blocked" here.
function requestBlockingItems(data: AnyRec): { label: string; tab: string; action: string }[] {
  return attorneyItemsNeeded({
    dateOfBirth: data.dateOfBirth,
    dateOfInjury: data.dateOfInjury,
    diagnosis: data.diagnosis,
    jurisdiction: data.jurisdiction,
    specialty: data.specialty,
    documentCount: (data.documents ?? []).length,
  });
}

function AttorneyReportPanel({ caseId, caseData, exports, physicians = [], onNavigate }: { caseId: string; caseData: AnyRec; exports: AnyRec[]; physicians?: AnyRec[]; onNavigate?: (tab: string) => void }) {
  const [reports, setReports] = useState<AnyRec[]>([]);
  const [selectedId, setSelectedId] = useState<string>("LIFE_CARE_PLAN");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // One entry per requested physician reviewer; specialty options mirror the
  // Intake page's "Specialty for Review" list exactly.
  const [physSpecialties, setPhysSpecialties] = useState<string[]>([""]);
  const [orders, setOrders] = useState<AnyRec[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/reports`);
    if (res.ok) setReports((await res.json()).reports ?? []);
    const eng = await fetch(`/api/cases/${caseId}/engagements`);
    if (eng.ok) setOrders((await eng.json()).engagements ?? []);
  }, [caseId]);
  useEffect(() => { void load(); }, [load]);

  const selected = reports.find((r) => r.id === selectedId) ?? null;
  const options = attorneyPreparerOptions(selected);
  const blockers = requestBlockingItems(caseData);

  // Required titles are always part of the order.
  const effectivePicked = new Set(picked);
  for (const o of options) if (o.required) effectivePicked.add(o.key);

  async function order() {
    if (!selected) return;
    setBusy(true); setMsg(null);
    const requestedPreparers: { title: string; specialty?: string }[] = options
      .filter((o) => effectivePicked.has(o.key))
      .flatMap((o): { title: string; specialty?: string }[] => {
        if (o.key !== "PHYSICIAN_REVIEWER") return [{ title: o.label }];
        const chosen = Array.from(new Set(physSpecialties.map((sp) => sp.trim()).filter(Boolean)));
        return chosen.length ? chosen.map((sp) => ({ title: o.label, specialty: sp })) : [{ title: o.label }];
      });
    const scopeText = `Attorney order: ${selected.name} — preparers: ${requestedPreparers.map((r) => r.specialty ? `${r.title} (${r.specialty})` : r.title).join(", ")}`;
    const res = await fetch(`/api/cases/${caseId}/engagements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportType: selected.id, scope: scopeText, configuration: { requestedPreparers, orderedVia: "attorney_report_tab" } }),
    });
    setBusy(false);
    if (res.ok) { setMsg("Order submitted. The firm will confirm, staff, and prepare this report."); void load(); }
    else { const body = await res.json().catch(() => ({})); setMsg(body.error ?? "Order could not be submitted."); }
  }

  // Final, released deliverables grouped by report, newest first.
  const finals = exports.filter((r: AnyRec) => r.draft === false);
  const groupsMap = new Map<string, AnyRec[]>();
  for (const r of finals) {
    const key = r.reportType ?? (r.format === "MEMO" ? "TESTIMONY_PREP_PACK" : "LIFE_CARE_PLAN");
    const list = groupsMap.get(key) ?? [];
    list.push(r);
    groupsMap.set(key, list);
  }
  const finalGroups = Array.from(groupsMap.entries()).map(([key, list]) => {
    const sorted = [...list].sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
    return { key, label: key.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase()), newest: sorted[0], prior: sorted.slice(1) };
  }).sort((a, b) => String(b.newest.createdAt).localeCompare(String(a.newest.createdAt)));

  const openOrders = orders.filter((o: AnyRec) => !["COMPLETED", "CANCELLED"].includes(o.status));

  return (
    <div className="space-y-4">
      {/* Report selection */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Request Report</h3>
        <p className="text-xs text-ink-500">Choose the report you want prepared. Anything still needed from your side appears under Request-Blocking Items below.</p>
        {/* The exact same report library as the clinical view, grouped by the
            same categories — only the action differs (order, not generate). */}
        {ATTORNEY_CATEGORY_ORDER.filter((cat) => reports.some((r: AnyRec) => r.category === cat)).map((cat) => (
          <div key={cat} className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{cat}</p>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {reports.filter((r: AnyRec) => r.category === cat).map((r: AnyRec) => (
                <button
                  key={r.id}
                  onClick={() => { setSelectedId(r.id); setPicked(new Set()); setPhysSpecialties([""]); setMsg(null); }}
                  className={cn(
                    "focusable rounded-lg border p-3 text-left transition-colors",
                    selectedId === r.id ? "border-brand-400 bg-brand-50/60" : "border-ink-200 hover:border-ink-300 hover:bg-ink-50",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", blockers.length === 0 ? "bg-emerald-500" : "bg-amber-500")} />
                    <span className="text-sm font-semibold text-ink-900">{r.name}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-500">{r.description}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Request-side readiness — only barriers the attorney controls. The
          clinical team's internal integrity items are resolved after ordering
          and are never presented to the attorney as "blocked". */}
      <div className="card p-5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-900">Request-Blocking Items</h3>
          {blockers.length === 0
            ? <Badge tone="green">ready to order</Badge>
            : <Badge tone="amber">{blockers.length} to complete</Badge>}
        </div>
        {blockers.length === 0 ? (
          <p className="mt-2 text-sm text-ink-600">
            Everything needed from your side is on file. Any remaining internal items are handled by the clinical team as part of preparing the report.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {blockers.map((bk) => (
              <li key={bk.label} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50/70 p-3 text-sm">
                <span className="text-ink-800">{bk.label}</span>
                {onNavigate && (
                  <button className="focusable rounded text-xs font-semibold text-brand-700 hover:underline" onClick={() => onNavigate(bk.tab)}>
                    {bk.action}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Preparer titles (anonymous) */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Report Preparers</h3>
        <p className="text-xs text-ink-500">Choose who should prepare and review this report by title. The firm assigns the individual professionals; required titles for the selected report are always included.</p>
        <div className="mt-3 space-y-2">
          {options.map((o) => (
            <div key={o.key}>
              <label className="flex items-center gap-2 text-sm text-ink-800">
                <input
                  type="checkbox"
                  checked={effectivePicked.has(o.key)}
                  disabled={o.required}
                  onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(o.key); else n.delete(o.key); return n; })}
                />
                {o.label}
                {o.required && <Badge tone="neutral">required for this report</Badge>}
              </label>
              {o.key === "PHYSICIAN_REVIEWER" && effectivePicked.has(o.key) && (
                <div className="ml-6 mt-1 space-y-1.5">
                  {physSpecialties.map((sp, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        className="input w-80 py-1.5 text-sm"
                        aria-label={`Reviewer specialty ${idx + 1}`}
                        value={sp}
                        onChange={(e) => setPhysSpecialties((prev) => prev.map((x, i) => (i === idx ? e.target.value : x)))}
                      >
                        <option value="">Any available specialty</option>
                        {MEDICAL_SPECIALTIES.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      {physSpecialties.length > 1 && (
                        <button
                          type="button"
                          className="focusable rounded text-xs text-ink-400 hover:text-red-600"
                          aria-label={`Remove physician reviewer ${idx + 1}`}
                          onClick={() => setPhysSpecialties((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="focusable rounded text-xs font-medium text-brand-700 hover:underline"
                    onClick={() => setPhysSpecialties((prev) => [...prev, ""])}
                  >
                    + Add another physician reviewer
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary px-4 py-2 text-sm" disabled={busy || !selected} onClick={() => void order()}>
            {busy ? "Submitting…" : "Order"}
          </button>
          {msg && <span className="text-xs text-ink-600">{msg}</span>}
        </div>
        {openOrders.length > 0 && (
          <div className="mt-4 border-t border-ink-100 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Open Orders</p>
            <ul className="mt-1 space-y-1">
              {openOrders.map((o: AnyRec) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
                  <span className="font-medium">{String(o.reportType).replace(/_/g, " ").toLowerCase()}</span>
                  <Badge tone="info">{String(o.status).replace(/_/g, " ").toLowerCase()}</Badge>
                  <span className="text-xs text-ink-400">ordered {formatDate(o.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Final, released reports — newest per report, priors tucked underneath. */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Final Reports</h3>
        {finalGroups.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No final reports have been released on this matter yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {finalGroups.map((g) => (
              <div key={g.key} className="rounded-lg ring-1 ring-ink-100 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium text-ink-900">{g.label}</span>
                    <span className="ml-2 text-xs text-ink-500">v{g.newest.version} · {String(g.newest.format).toLowerCase()} · {formatDate(g.newest.createdAt)}</span>
                  </span>
                  <a className="text-sm font-medium text-brand-700 hover:underline" href={`/api/cases/${caseId}/export/${g.newest.id}/download`} target="_blank">Download</a>
                </div>
                {g.prior.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-ink-400">Prior versions ({g.prior.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {g.prior.map((r: AnyRec) => (
                        <li key={r.id} className="flex items-center justify-between text-xs text-ink-500">
                          <span>v{r.version} · {String(r.format).toLowerCase()} · {formatDate(r.createdAt)}</span>
                          <a className="text-brand-700 hover:underline" href={`/api/cases/${caseId}/export/${r.id}/download`} target="_blank">Download</a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const ATTORNEY_CATEGORY_ORDER = ["Core", "Record review", "Damages", "Clinical analysis", "Governance", "Custom"];

const STATUS_DOT_ATTORNEY: Record<string, string> = {
  Ready: "bg-emerald-500",
  "Previously exported": "bg-emerald-500",
  "Physician review required": "bg-amber-500",
  Blocked: "bg-red-500",
  "Not enough information": "bg-slate-300",
  "Expert input required": "bg-amber-500",
  "Not enabled": "bg-slate-300",
};

function ReportPanel({ data, canExport, canEdit, call, busy, totals, physicians = [], onReview }: { data: AnyRec; canExport: boolean; canEdit: boolean; call: any; busy: string | null; totals: AnyRec; physicians?: AnyRec[]; onReview?: (finding: AnyRec) => void }) {
  const [preparing, setPreparing] = useState<string>(data.preparingPhysicianId ?? "");
  const [reportSel, setReportSel] = useState<ReportSelection | null>(null);
  const chosen = physicians.find((p: AnyRec) => p.id === preparing);
  return (
    <div className="space-y-4">
      <ReportLibrary caseId={data.id} canExport={canExport} onSelect={setReportSel} />
      <ValidationCard caseId={data.id} scope={reportSel} onReview={onReview} />
      {/* Preparing physician — only this seat's name & credentials appear in the report. */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Preparing Physician</h3>
        <p className="text-xs text-ink-500">Their name, credentials, and signature appear in the report — and only theirs. Leave unset for a planner-prepared plan.</p>
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
      {/* The selected report's generation controls render here (portal from ReportLibrary). */}
      <div id="report-generate-slot" className="space-y-4" />
      <details className="card p-5">
        <summary className="cursor-pointer text-sm font-semibold text-ink-900">Compare Versions</summary>
        <div className="mt-3"><VersionCompareCard caseId={data.id} embedded /></div>
      </details>

      <details className="card p-5">
        <summary className="cursor-pointer text-sm font-semibold text-ink-900">Export History (Version Control){data.reports.length > 0 ? ` — ${data.reports.length}` : ""}</summary>
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
      </details>
    </div>
  );
}


// ── Source-grounded extraction display (Records page) ────────────────────────
// Per-document: extraction status, validated cited encounters with claim
// excerpts and page citations, warnings, and human review controls. All
// verification is server-enforced (canonical records.verify); the button is
// shown only when the server said the caller may verify.
/**
 * Record kinds a reviewer may assign. Ordered so the clinical kinds — the ones
 * that reach the medical chronology — come first.
 */
const RECORD_KIND_OPTIONS: [string, string][] = [
  ["CLINICAL_ENCOUNTER", "Clinical encounter"],
  ["THERAPY_COURSE", "Therapy"],
  ["OPERATIVE", "Operative"],
  ["ANESTHESIA", "Anesthesia"],
  ["PATHOLOGY_DIAGNOSTIC", "Pathology"],
  ["DIAGNOSTIC_STUDY", "Diagnostic study"],
  ["INCIDENT", "Incident / prehospital"],
  ["DEVICE_OR_IMPLANT", "Device / implant"],
  ["FINANCIAL", "Billing"],
  ["INSURANCE_ADMINISTRATIVE", "Insurance / administrative"],
  ["EMPLOYMENT_ECONOMIC", "Employment / economic"],
  ["TESTIMONY", "Sworn testimony"],
  ["EXPERT_OPINION", "Expert opinion"],
  ["LEGAL", "Legal"],
  ["CORRESPONDENCE_OR_GENERIC_EVIDENCE", "Correspondence"],
  ["SUPPORTING_FILE", "Supporting file — no date needed"],
  ["UNKNOWN", "Unclassified — needs review"],
];

/**
 * Why a record carries the date it carries.
 *
 * A reviewer signing a life care plan has to be able to tell a date read off
 * the page from one the program worked out, and to see the text it came from.
 * Shown quietly — this is provenance, not content.
 */
function DateProvenance({ seg }: { seg: AnyRec }) {
  const basis = typeof seg.dateBasis === "string" ? seg.dateBasis : null;
  if (!basis || basis === "NONE") return null;
  const documented = seg.dateDocumented === true;
  const evidence = typeof seg.dateEvidence === "string" ? seg.dateEvidence : null;
  return (
    <p className="mt-0.5 text-[11px] text-ink-400">
      <span className={documented ? "text-ink-500" : "text-amber-700"}>
        {documented ? "Documented" : "Inferred"}
      </span>
      {" · "}
      {DATE_BASIS_LABEL[basis] ?? basis}
      {evidence ? <span className="text-ink-300"> · “{evidence.slice(0, 90)}”</span> : null}
    </p>
  );
}

const DATE_BASIS_LABEL: Record<string, string> = {
  DOCUMENTED: "date in the record header",
  NOTE_SERVICE_LABEL: "service-date field of this note",
  NOTE_HEADER: "this note's own header",
  RETIMED_FROM_PAGE: "year corrected from the page",
  STATED_IN_CLAIMS: "service date stated in the record",
  NEIGHBOURS_AGREE: "records either side carry this date",
  BRACKETED_BY_NEIGHBOURS: "bracketed by the records either side",
};

/** Why a record is still undated, for the reviewer who has to resolve it. */
function undatedReason(reason: unknown): string {
  switch (reason) {
    case "NO_SERVICE_DATE":
      return "No service date present in the source.";
    case "CONFLICTING_DATES":
      return "Surrounding records give conflicting dates; the packet is out of order here.";
    case "ONLY_ARTIFACT_DATES":
      return "Only print, signature or birth dates were found — none is a service date.";
    case "NOTE_BOUNDARY_UNCERTAIN":
      return "The note this belongs to could not be identified in the document.";
    case "SOURCE_TEXT_INSUFFICIENT":
      return "Too little text was extracted to establish a date.";
    default:
      return "No supported date was found. Assign one to place this on the chronology.";
  }
}

// ── Undated / date requires review ──────────────────────────────────────────
// Encounters whose date the record did not support. They are extracted and
// cited like any other, but they carry no date the source can back, so they
// stay OFF the dated chronology until a human supplies one. Listing them here
// is what keeps "we could not date this" from becoming "this did not happen".
function ExtractionBlock({ caseId, doc, canVerify, onChanged }: { caseId: string; doc: AnyRec | null; canVerify: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editingEnc, setEditingEnc] = useState<string | null>(null);
  const [draftSummary, setDraftSummary] = useState("");
  const [regenNotice, setRegenNotice] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  /** Rows whose full claim list the reviewer has opened. */
  if (!doc) return null;
  const ex = doc.extraction ?? {};
  const encounters: AnyRec[] = doc.encounters ?? [];
  // The REVIEW UNIT is the canonical note the records builder persisted. Rows
  // are the fragments it was assembled from — kept as evidence beneath each
  // note, and still individually correctable, but no longer one decision
  // each. A document with no projection (legacy data) falls back to rows, so
  // nothing becomes unreviewable.
  const notes: AnyRec[] = (doc.notes as AnyRec[] | undefined)?.length
    ? (doc.notes as AnyRec[])
    : encounters.map((e) => ({
        id: `row:${e.id}`,
        rowIds: [e.id],
        rows: [e],
        encounterDate: e.encounterDate,
        dateStatus: e.dateStatus,
        provider: e.provider,
        providerCredentials: e.providerCredentials,
        facility: e.facility,
        encounterType: e.encounterType,
        claims: e.claims ?? [],
        claimCount: (e.claims ?? []).length,
        contentHashes: [{ rowId: e.id, contentHash: e.contentHash }],
        status: e.status,
        auditResult: e.auditResult ?? null,
        findings: e.findings ?? [],
        copies: e.copies ?? [],
        reviewedWith: e.reviewedWith ?? null,
        corroboration: e.corroboration ?? null,
        needsAttention: false,
        awaitingAttestation: true,
        substanceClass: e.substanceClass,
        substanceReason: e.substanceReason,
        analysisClass: e.analysisClass,
      }));
  const statusChip = (st: string) =>
    st === "COMPLETE" ? ["AI extraction complete", "bg-emerald-50 text-emerald-700"]
    : st === "EXTRACTION_FAILED" ? ["Extraction failed — human review required", "bg-red-50 text-red-700"]
    : st === "BLOCKED_OCR" ? ["Waiting on OCR — not yet extracted", "bg-amber-50 text-amber-800"]
    : st === "PENDING" ? ["OCR in progress", "bg-amber-50 text-amber-800"]
    : ["Not yet extracted", "bg-slate-100 text-slate-600"];
  const [chipLabel, chipCls] = statusChip(ex.status ?? "NOT_RUN");

  async function act(encId: string, method: "POST" | "PATCH", body: AnyRec) {
    setBusy(encId);
    const res = await fetch(`/api/cases/${caseId}/records/encounters/${encId}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as { regenerationTriggered?: boolean; regenerationReason?: string };
    setBusy(null);
    setEditingEnc(null);
    // The server rebuilds the case when a correction changes what the record
    // says. Say so plainly — a plan that moves without explanation is worse
    // than the stale one it replaced.
    setRegenNotice(out.regenerationTriggered ? (out.regenerationReason ?? "The chronology and care plan are being rebuilt.") : null);
    onChanged();
  }

  // A review decision on a primary card covers its cross-document copies —
  // the card lists them (file, page, their own summary) BEFORE the click, so
  // the reviewer knows exactly what one decision signs.
  //
  // ONE request, decided server-side, all-or-none. Fanning out from here —
  // verify the primary, then fire a request per copy — meant a copy could
  // fail silently while the card claimed the decision covered it. Each row is
  // sent with the hash of the content displayed, so a row that changed since
  // it was shown blocks the whole decision instead of being signed unseen.
  // Corrections never group: a correction is about one row's exact content.
  /**
   * A structural correction (record type, classification, date) describes the
   * NOTE, so it is applied to every row the note consolidates — otherwise a
   * three-fragment note would end up half corrected. Each row keeps its own
   * audited PATCH; corrections remain entry-specific by construction.
   */
  async function patchNote(note: AnyRec, body: AnyRec) {
    const hashes: { rowId: string; contentHash: string }[] = note.contentHashes ?? [];
    if (!hashes.length) return;
    setBusy(note.id);
    const res = await fetch(`/api/cases/${caseId}/records/encounters/group/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        canonicalNoteId: note.id,
        rows: hashes.map((h) => ({ id: h.rowId, expectedContentHash: h.contentHash })),
      }),
    }).catch(() => null);
    const out = (await res?.json().catch(() => ({}))) as { error?: string; regenerationReason?: string };
    setBusy(null);
    // A refused correction changed nothing. Saying so is the whole point: the
    // previous loop discarded every response, so a half-applied correction
    // looked identical to a successful one.
    setGroupError(res && res.ok ? null : (out?.error ?? "The correction could not be applied; nothing was changed."));
    if (res?.ok) setRegenNotice(out.regenerationReason ?? "The chronology and care plan are being rebuilt.");
    onChanged();
  }

  /**
   * One attestation for one canonical note: every underlying row, decided
   * together by the server, with the hash each was displayed as.
   *
   * `contentHashes` covers cross-document copies too, because the note's
   * membership does. The previous cross-document path lived in a function
   * nothing called, so the card's promise that "one review covers every copy"
   * was true of code that never ran.
   */
  async function reviewNote(note: AnyRec, action: "verify" | "review" | "reject") {
    const hashes: { rowId: string; contentHash: string }[] = note.contentHashes ?? [];
    if (!hashes.length) return;
    setBusy(note.id);
    const res = await fetch(`/api/cases/${caseId}/records/encounters/group`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        canonicalNoteId: note.id,
        rows: hashes.map((h) => ({ id: h.rowId, expectedContentHash: h.contentHash })),
      }),
    }).catch(() => null);
    const out = (await res?.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    setGroupError(res && res.ok ? null : (out?.error ?? "The decision could not be applied; nothing was changed."));
    onChanged();
  }

  const encStatus = (st: string, edited: boolean) =>
    st === "VERIFIED" ? ["Human-verified", "bg-emerald-100 text-emerald-800"]
    : st === "REVIEWED" ? ["Human-reviewed", "bg-sky-100 text-sky-800"]
    : st === "HUMAN_EDITED" || edited ? ["Human-edited", "bg-amber-100 text-amber-800"]
    : st === "STALE" ? ["Stale — source changed", "bg-red-100 text-red-700"]
    : st === "GENERATION_LOSS" ? ["Not reproduced by current extraction — confirm or reject", "bg-orange-100 text-orange-800"]
    : st === "AI_AUDIT_PASSED" ? ["AI draft — audit passed, pending review", "bg-teal-50 text-teal-700"]
    : ["AI draft — pending review", "bg-slate-100 text-slate-600"];

  // Substance chip: whether this encounter is an episode of CARE (on the
  // chronology) or record-keeping around it (visible here, off the timeline).
  const substanceChip = (cls: string | null) =>
    cls === "ADMINISTRATIVE" ? ["Administrative — not on chronology", "bg-zinc-100 text-zinc-600"]
    : cls === "ANCILLARY" ? ["Ancillary — not on chronology", "bg-indigo-50 text-indigo-700"]
    : ["Clinical", "bg-emerald-50 text-emerald-700"];

  return (
    <div className="mt-2 rounded-md border border-ink-100 bg-ink-50/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", chipCls)}>{chipLabel}</span>
        {ex.truncated && <span className="text-[11px] text-amber-700">Partially processed — document exceeds the processing bound</span>}
      </div>
      {ex.error && <p className="mt-1 text-[11px] text-red-700">{ex.error}</p>}
      {/* This document's own findings, and its pages' — once, folded, where a
          reviewer can answer them. Not copied onto its notes: a document's
          incompleteness is not a defect in any entry it did produce. */}
      <FoldedFindings
        caseId={caseId}
        title="Findings about this document"
        findings={(ex.findings ?? []) as never}
        canDisposition={canVerify}
        onChanged={onChanged}
      />
      <FoldedFindings
        caseId={caseId}
        title="Findings about individual pages"
        findings={(ex.pageFindings ?? []) as never}
        canDisposition={canVerify}
        onChanged={onChanged}
      />
      {groupError && (
        <div className="mt-2 flex items-start gap-2 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-800">
          <span className="font-medium">Nothing was changed.</span>
          <span>{groupError}</span>
          <button type="button" className="ml-auto underline" onClick={() => setGroupError(null)}>Dismiss</button>
        </div>
      )}
      {regenNotice && (
        <div className="mt-2 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
          <span className="font-medium">Re-running the pipeline.</span>
          <span>{regenNotice} Physician-added and authored items are preserved.</span>
          <button type="button" className="ml-auto underline" onClick={() => setRegenNotice(null)}>Dismiss</button>
        </div>
      )}
      {(() => {
        // ── Triage, so the review area holds only what needs a human NOW ─────
        // A flat list put consent forms, audit-passed drafts and already-
        // reviewed rows shoulder to shoulder with the few rows that genuinely
        // need attention, and a 16-row ER packet read as 16 obligations.
        // Grouping is presentation only: every row stays reachable and
        // reviewable, and nothing about their storage or gating changes.
        const bucketOf = (e: AnyRec): "attention" | "caution" | "corroborated" | "ready" | "copies" | "paperwork" | "resolved" => {
          // An EXCEPTION cannot be attested as it stands: something about this
          // record must change or be disposed of. Consolidation may never hide
          // one.
          if (e.needsAttention) return "attention";
          if (["VERIFIED", "REVIEWED", "HUMAN_EDITED"].includes(e.status)) return "resolved";
          // A copy of a record whose primary card lives in another document:
          // the decision there covers it, so it does not queue here.
          if (e.reviewedWith) return "copies";
          // Paperwork never feeds the chronology or the plan; it should not
          // crowd the clinical queue. It reviews on its own time.
          if ((e.substanceClass ?? "CLINICAL") !== "CLINICAL") return "paperwork";
          // A CAUTION is a sound record with something to read first — a
          // document that is incomplete around it, text carried forward from
          // an earlier note, an old grade whose reason was never recorded.
          // Attestable, so it waits in its own pile rather than blocking one.
          if (e.attention === "CAUTION") return "caution";
          // The strongest machine evidence: audit passed AND an independent
          // blind re-read reproduced every fact. Still pending a human — the
          // machine cannot attest — but it waits in the quietest queue.
          if (e.status === "AI_AUDIT_PASSED" && e.corroboration?.result === "CORROBORATED") return "corroborated";
          // The adversarial audit passed and nothing is flagged: reviewable
          // with one click, but not shouting.
          if (e.status === "AI_AUDIT_PASSED") return "ready";
          return "ready";
        };
        const groups = { attention: [] as AnyRec[], caution: [] as AnyRec[], corroborated: [] as AnyRec[], ready: [] as AnyRec[], copies: [] as AnyRec[], paperwork: [] as AnyRec[], resolved: [] as AnyRec[] };
        for (const n of notes) groups[bucketOf(n)].push(n);

        const renderEncounter = (e: AnyRec) => {
        // Corroboration refines the chip, never the status: attestation is
        // still a human's to give.
        const [lbl, cls] =
          e.status === "AI_AUDIT_PASSED" && e.corroboration?.result === "CORROBORATED"
            ? ["Machine-corroborated — blind second reading agrees; pending human review", "bg-violet-50 text-violet-700"]
            : encStatus(e.status, false);
        const [subLbl, subCls] = substanceChip(e.substanceClass ?? null);
        return (
          <div key={e.id} className="mt-2 rounded border border-ink-100 bg-white p-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className={cn("font-semibold", e.dateStatus === "UNKNOWN" ? "text-amber-800" : "text-ink-900")}>
                {e.dateStatus === "UNKNOWN" ? "Undated — date requires review" : `${e.encounterDate}${e.dateStatus === "INFERRED" ? " (inferred)" : ""}`}
              </span>
              {/* Dating happens HERE, beside the entry and inside its own
                  document, where the neighbouring dated entries are visible.
                  Pulling undated rows into a separate list stripped them of
                  exactly the context needed to date them. */}
              {canVerify && e.dateStatus === "UNKNOWN" && (
                <input
                  type="date"
                  className="input w-auto py-0 text-[11px]"
                  aria-label="Assign a date from the source record"
                  onChange={(ev) => ev.target.value && patchNote(e, { encounterDate: ev.target.value })}
                />
              )}
              {/* The document's KIND, so a reviewer can see at a glance that a
                  row is testimony or a billing line rather than a visit. */}
              {e.analysisClass && e.analysisClass !== "CLINICAL_ENCOUNTER" && (
                <span className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700">{KIND_LABEL[e.analysisClass] ?? e.analysisClass}</span>
              )}
              {e.provider ? (
                // Every provider the record names. A therapy course or a
                // multi-visit packet genuinely has several, and showing the
                // first one made the note assert something narrower than the
                // record supports.
                <span className="text-ink-600">
                  {((e.providers as string[] | undefined)?.length ?? 0) > 1
                    ? `${(e.providers as string[]).slice(0, 3).join(" · ")}${(e.providers as string[]).length > 3 ? ` · +${(e.providers as string[]).length - 3} more` : ""}`
                    : `${e.provider}${e.providerCredentials ? `, ${e.providerCredentials}` : ""}`}
                </span>
              ) : (
                /* A deponent, surgeon, radiologist, expert or officer is an
                   AUTHOR, not the patient's provider, and is labelled by role. */
                e.attributionName && (
                  <span className="text-ink-600">
                    {e.attributionName}
                    {e.attributionRole ? <span className="text-ink-400"> — {e.attributionRole}</span> : null}
                  </span>
                )
              )}
              {e.facility && <span className="text-ink-500">{e.facility}</span>}
              <span className={cn("ml-auto rounded-full px-2 py-0.5 font-medium", subCls)}>{subLbl}</span>
              <span className={cn("rounded-full px-2 py-0.5 font-medium", cls)}>{lbl}</span>
            </div>
            {e.substanceClass && e.substanceClass !== "CLINICAL" && e.substanceReason && (
              <p className="mt-0.5 text-[11px] text-ink-500">{e.substanceReason}</p>
            )}
            {/* Why this record is here and what to do about it. A card that
                says only "needs review" makes the reviewer guess, and the
                guess is usually to click a button the server will refuse. */}
            {/* Shown for an exception AND for a caution: a caution is the
                thing the reviewer must read before signing, so hiding it
                would leave them signing blind. */}
            {e.guidance && (
              <div
                className={cn(
                  "mt-1.5 rounded border px-2 py-1.5 text-[11px]",
                  e.attention === "CLEAN"
                    ? "border-ink-100 bg-ink-50/60 text-ink-700"
                    : e.guidance.canAttest
                      ? "border-amber-200 bg-amber-50 text-amber-900"
                      : "border-red-200 bg-red-50 text-red-900",
                )}
              >
                {/* THE ASK, first and in one sentence. Everything else on this
                    card is evidence for it — and evidence was what the card
                    used to open with. */}
                <p>
                  <span className="font-semibold">What this needs: </span>
                  {e.guidance.requirement}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {e.pageStart && (
                    <a
                      href={`/api/cases/${caseId}/documents/${e.sourceDocumentId}/view`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline"
                    >
                      Open the source at p. {e.pageStart}{e.pageEnd && e.pageEnd !== e.pageStart ? `–${e.pageEnd}` : ""}
                    </a>
                  )}
                  {/* The long explanation is one click away, not in the way. */}
                  {e.attention !== "CLEAN" && (
                    <details className="w-full">
                      <summary className="cursor-pointer select-none font-medium underline">Why is this flagged?</summary>
                      <p className="mt-1">{e.guidance.why}</p>
                      {(e.guidance.steps ?? []).length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          {(e.guidance.steps as string[]).map((step: string, i: number) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ul>
                      )}
                    </details>
                  )}
                </div>
              </div>
            )}
            {/* WHAT THE RECORD SAYS — the assertion being attested. It sat
                below the reclassification controls, so the reviewer met two
                dropdowns before the sentence they were signing. */}
            {editingEnc === e.id ? (
              <div className="mt-1.5 flex gap-2">
                <textarea className="input w-full py-1 text-xs" rows={2} value={draftSummary} onChange={(ev) => setDraftSummary(ev.target.value)} />
                <button className="btn-primary px-2 py-0.5 text-[11px]" disabled={busy === e.id} onClick={() => act(e.id, "PATCH", { factualSummary: draftSummary })}>Save</button>
                <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => setEditingEnc(null)}>Cancel</button>
              </div>
            ) : (
              <p className="mt-1 text-xs text-ink-800">{e.factualSummary}</p>
            )}
            {e.synthesis && <p className="mt-1 text-[11px] italic text-ink-500">System-generated synthesis (from validated facts only): {e.synthesis}</p>}
            {canVerify && (
              /* Reclassifying is a CORRECTION, not part of reading the record,
                 so it no longer sits between the reviewer and the summary.
                 Open when the record type is still unknown — that IS the ask. */
              <details className="mt-1" open={(e.analysisClass ?? "UNKNOWN") === "UNKNOWN"}>
                <summary className="cursor-pointer select-none text-[11px] font-medium text-ink-600">
                  Change record type or classification
                </summary>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                {/* The KIND governs everything downstream — what the row may
                    assert, whether it needs a date, and whether it reaches the
                    medical chronology. A misfiled document is corrected here. */}
                <span className="text-ink-400">Record type:</span>
                <select
                  className="input w-auto py-0 text-[11px]"
                  value={e.analysisClass ?? "UNKNOWN"}
                  onChange={(ev) => patchNote(e, { analysisClass: ev.target.value })}
                  title="Changing the record type re-runs the pipeline for this case."
                >
                  {RECORD_KIND_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                {/* Stated before the change, not after: a reviewer should know
                    a rebuild follows rather than discover their plan moved. */}
                <span className="text-[10px] text-amber-700">Changing the type or date re-runs the chronology and care plan.</span>
                <span className="text-ink-400">Classification:</span>
                <select
                  className="input w-auto py-0 text-[11px]"
                  value={e.substanceClass ?? "CLINICAL"}
                  onChange={(ev) => patchNote(e, { substanceClass: ev.target.value })}
                >
                  <option value="CLINICAL">Clinical — on chronology</option>
                  <option value="ANCILLARY">Ancillary — records only</option>
                  <option value="ADMINISTRATIVE">Administrative — records only</option>
                </select>
                </div>
              </details>
            )}
            {/* The extraction fragments this record was assembled from —
                evidence and citations, not separate decisions. A reviewer can
                open them to see exactly what one signature covers, and can
                still correct any single fragment. */}
            {(e.rows?.length ?? 0) > 1 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer select-none text-[11px] font-medium text-ink-600">
                  Assembled from {e.rows.length} extracted fragments — show sources
                </summary>
                <div className="mt-1 space-y-1 border-l-2 border-ink-100 pl-2">
                  {(e.rows as AnyRec[]).map((r: AnyRec) => (
                    <div key={r.id} className="text-[11px] text-ink-600">
                      <span className="font-medium">
                        {r.page ? `p. ${r.page}${r.pageEnd && r.pageEnd !== r.page ? `–${r.pageEnd}` : ""}` : "page unknown"}
                      </span>
                      <span className="text-ink-400"> · {r.claims?.length ?? 0} claim{(r.claims?.length ?? 0) === 1 ? "" : "s"} · {r.status}</span>
                      <p className="text-ink-700">{r.factualSummary}</p>
                      {canVerify && (
                        <button
                          className="mt-0.5 text-[11px] font-medium text-brand-700 hover:underline"
                          onClick={() => { setEditingEnc(r.id); setDraftSummary(r.factualSummary); }}
                        >
                          Correct this fragment
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {/* Everything a signature covers must be inspectable before it is
                given — so nothing is hidden. But a record is not READ by
                scrolling 318 raw quotes, and the first four used to be an
                account number and some garbled OCR. Ordered clinically, folded
                by default, with untyped page text kept separately. */}
            {(() => {
              const { clinical, raw } = presentClaims((e.claims ?? []) as AnyRec[]);
              const total = clinical.length + raw.length;
              if (!total) return null;
              const quote = (c: AnyRec, i: number) => (
                <p key={i} className="mt-1 text-[11px] text-ink-500">
                  <span className="font-medium text-ink-600">{labelForField(c.field as string)}: </span>
                  &ldquo;{c.excerpt}&rdquo;{c.page != null ? ` (p. ${c.page})` : " (page unknown)"}
                  {c.warning ? <span className="text-amber-700"> — {c.warning}</span> : null}
                </p>
              );
              return (
                <details className="mt-1.5">
                  <summary className="cursor-pointer select-none text-[11px] font-medium text-ink-600">
                    Supporting quotes from the source ({total})
                    {raw.length > 0 && <span className="font-normal text-ink-400"> · {clinical.length} clinical, {raw.length} page text</span>}
                  </summary>
                  <div className="border-l-2 border-ink-100 pl-2">
                    {clinical.map(quote)}
                    {raw.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer select-none text-[11px] text-ink-400">
                          {raw.length} quote{raw.length === 1 ? "" : "s"} of untyped page text — headers, identifiers, OCR fragments
                        </summary>
                        {raw.map(quote)}
                      </details>
                    )}
                  </div>
                  {/* Said plainly: the signature covers all of it, including
                      what is folded away. */}
                  <p className="mt-1 text-[11px] text-ink-400">Verifying this record attests to all {total} of these.</p>
                </details>
              );
            })()}
            {(e.warnings ?? []).map((w: string, i: number) => (
              <p key={`w${i}`} className="mt-0.5 text-[11px] text-amber-700">{w}</p>
            ))}
            {e.staleReason && <p className="mt-0.5 text-[11px] text-red-700">{e.staleReason}</p>}
            {/* Why this entry is in Attention Required — named, scoped and
                sourced, so a reviewer never has to rediscover it. Only this
                entry's own findings appear; a neighbour's problem is not
                shown here. */}
            {(e.findings ?? []).length > 0 && (
              <ul className="mt-1 space-y-1">
                {(e.findings as AnyRec[]).map((f: AnyRec) => (
                  <li key={f.id} className={cn("rounded border px-2 py-1 text-[11px]", f.blocking ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900")}>
                    <span className="font-semibold">{FINDING_LABEL[f.type] ?? f.type.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="text-ink-500"> · {FINDING_SOURCE_LABEL[f.source] ?? f.source.replace(/_/g, " ").toLowerCase()}</span>
                    {f.field ? <span className="text-ink-500"> · {f.field}</span> : null}
                    {f.pageStart ? <span className="text-ink-500"> · p. {f.pageStart}{f.pageEnd && f.pageEnd !== f.pageStart ? `–${f.pageEnd}` : ""}</span> : null}
                    <p className="mt-0.5">{f.detail}</p>
                    {f.excerpt ? <p className="mt-0.5 italic text-ink-600">“{f.excerpt}”</p> : null}
                    {f.status !== "OPEN" && <p className="mt-0.5 text-ink-500">Status: {String(f.status).toLowerCase()}</p>}
                  </li>
                ))}
              </ul>
            )}
            {/* An independent re-read that could NOT reproduce some facts is a
                finding for the reviewer, named by field. */}
            {e.corroboration?.result === "NOT_CORROBORATED" && (
              <p className="mt-0.5 text-[11px] text-amber-800">
                A blind second reading of the source reproduced {e.corroboration.reproduced} of {e.corroboration.total} extracted facts.
                Not reproduced: {(e.corroboration.unreproducedFields ?? []).join(", ") || "(fields unavailable)"} — check these against the source before verifying.
              </p>
            )}
            {/* What one decision on this card signs, stated before the click.
                The claim is made ONLY about members whose hashes this card
                actually submits — `crossDocumentMembers` is derived from the
                note's own membership, so the sentence and the request cannot
                drift apart. */}
            {(() => {
              const signed = new Set(((e.crossDocumentMembers ?? []) as AnyRec[]).map((m: AnyRec) => m.id as string));
              const covered = ((e.copies ?? []) as AnyRec[]).filter((c: AnyRec) => signed.has(c.id as string));
              const notCovered = ((e.copies ?? []) as AnyRec[]).filter((c: AnyRec) => !signed.has(c.id as string));
              return (
                <>
                  {covered.length > 0 && (
                    <div className="mt-1 rounded border border-sky-100 bg-sky-50/60 p-1.5 text-[11px] text-sky-900">
                      <p className="font-medium">
                        This record also appears in {covered.length === 1 ? "another production" : `${covered.length} other productions`}. One decision here
                        covers {covered.length === 1 ? "that copy" : "those copies"} — all of them, or none:
                      </p>
                      {covered.map((c: AnyRec) => (
                        <p key={c.id as string} className="mt-0.5 text-sky-800">
                          {c.filename as string}{c.page != null ? `, p. ${c.page}` : ""} — &ldquo;{c.summary as string}&rdquo;
                        </p>
                      ))}
                    </div>
                  )}
                  {/* A copy this decision does NOT sign is said so plainly,
                      rather than being folded into a coverage claim. */}
                  {notCovered.length > 0 && (
                    <div className="mt-1 rounded border border-ink-100 bg-ink-50 p-1.5 text-[11px] text-ink-700">
                      <p className="font-medium">
                        {notCovered.length === 1 ? "A similar record appears" : `${notCovered.length} similar records appear`} in another production and
                        {notCovered.length === 1 ? " is" : " are"} reviewed separately:
                      </p>
                      {notCovered.map((c: AnyRec) => (
                        <p key={c.id as string} className="mt-0.5">
                          {c.filename as string}{c.page != null ? `, p. ${c.page}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
            {e.reviewedWith && !["VERIFIED", "REVIEWED", "HUMAN_EDITED"].includes(e.status) && (
              <p className="mt-1 text-[11px] text-sky-700">Copy of a record reviewed under {e.reviewedWith.filename}; the decision there covers this row. It remains individually reviewable below.</p>
            )}
            {canVerify && (
              <div className="mt-1.5 flex gap-1.5">
                {e.status !== "VERIFIED" && (
                  <button
                    className="btn-outline px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy === e.id || e.guidance?.canAttest === false}
                    title={e.guidance?.canAttest === false ? "Correct or reject the exception above first — verification would be refused." : undefined}
                    onClick={() => reviewNote(e, "verify")}
                  >
                    Verify{(e.rowIds?.length ?? 1) > 1 ? ` record (${e.rowIds.length} extracts)` : ""}
                  </button>
                )}
                <button
                  className="btn-outline px-2 py-0.5 text-[11px]"
                  onClick={() => { setEditingEnc(e.rows?.[0]?.id ?? e.id); setDraftSummary(e.rows?.[0]?.factualSummary ?? e.factualSummary ?? ""); }}
                >
                  Correct
                </button>
                <button className="btn-outline px-2 py-0.5 text-[11px] text-red-700" disabled={busy === e.id} onClick={() => reviewNote(e, "reject")}>Reject</button>
              </div>
            )}
          </div>
        );
        };

        const foldedGroup = (key: string, label: string, rows: AnyRec[], toneCls: string) =>
          rows.length === 0 ? null : (
            <details key={key} className="mt-2">
              <summary className={cn("cursor-pointer select-none rounded px-2 py-1 text-[11px] font-medium", toneCls)}>
                {label} ({rows.length})
              </summary>
              {rows.map(renderEncounter)}
            </details>
          );

        return (
          <>
            {groups.attention.length > 0 && (encounters.length > groups.attention.length) && (
              <p className="mt-2 text-[11px] font-medium text-ink-600">
                Needs review ({groups.attention.length} of {notes.length} record{notes.length === 1 ? "" : "s"})
                {notes.length !== encounters.length && (
                  <span className="ml-1 font-normal text-ink-400">· assembled from {encounters.length} extracted fragments</span>
                )}
              </p>
            )}
            {groups.attention.map(renderEncounter)}
            {groups.attention.length === 0 && notes.length > 0 && (
              <p className="mt-2 text-[11px] text-emerald-700">Nothing here needs attention right now.</p>
            )}
            {foldedGroup("caution", "Ready to confirm — read the note on each before signing", groups.caution, "bg-amber-50 text-amber-800")}
            {foldedGroup("corroborated", "Machine-corroborated — a blind second reading reproduced every fact; pending human review", groups.corroborated, "bg-violet-50 text-violet-700")}
            {foldedGroup("ready", "Audit passed — ready to confirm", groups.ready, "bg-teal-50 text-teal-700")}
            {foldedGroup("copies", "Copies — reviewed with their primary record in another document", groups.copies, "bg-sky-50 text-sky-700")}
            {foldedGroup("paperwork", "Paperwork — administrative & ancillary, not on the chronology", groups.paperwork, "bg-zinc-100 text-zinc-600")}
            {foldedGroup("resolved", "Resolved — human-reviewed", groups.resolved, "bg-emerald-50 text-emerald-700")}
          </>
        );
      })()}
    </div>
  );
}
