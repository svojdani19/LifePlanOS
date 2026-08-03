"use client";

// Attorney workspace (MDIP — docs/28). READ-ONLY for clinical data: the
// attorney sees posture, factors, options, engagements, and released
// deliverables — there is deliberately no control here that edits conditions,
// items, or findings. The only write is "Evaluate for Future Damages", which
// runs the deterministic fde-1 engine over the case's existing data.

import { useCallback, useEffect, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { formatDate, formatMoney } from "@/lib/utils";
import { explainLowerCostOption, type FdeOutcome, type FdeFactor } from "@/lib/engine/damagesEvaluation";
import { attorneyItemsNeeded } from "@/lib/attorneyItems";

// ── Props from the server page ───────────────────────────────────────────────

export interface AttorneyCase {
  id: string;
  clientName: string;
  caseNumber: string;
  status: string;
  dateOfInjury: string | null;
  dateOfBirth?: string | null;
  diagnosis?: string | null;
  jurisdiction?: string | null;
  specialty?: string | null;
  updatedAt: string;
  documentCount: number;
  chronologyCount: number;
}

interface Props {
  firmName: string;
  userName: string;
  cases: AttorneyCase[];
  /** Firm.features["pricing.<REPORT_TYPE>"] placeholders, keyed by report type. */
  pricing: Record<string, string>;
}

// ── API row shapes (loose — rendered, never edited) ──────────────────────────

interface Evaluation {
  id: string;
  evaluatedAt: string;
  logicVersion: string;
  overallOutcome: FdeOutcome;
  recommendedPrimaryProduct: string | null;
  recommendedAdditionalProducts: string[];
  readinessState: string;
  supportingFactors: FdeFactor[];
  weakeningFactors: FdeFactor[];
  missingInformation: FdeFactor[];
  unresolvedValidationIssues: number;
  estimatedMedicalRange: { lowPV: number; basePV: number; highPV: number; label: string } | null;
  confidenceDimensions: { recordCompleteness: number; physicianReviewCoverage: number; evidenceSupport: number } | null;
  nextActions: string[];
}

interface LibraryReport {
  id: string;
  name: string;
  description: string;
  category: string;
  status: string;
  formats: string[];
  requiredExpert: string | null;
}

interface EngagementRow {
  id: string;
  reportType: string;
  status: string;
  feeEstimate: number | null;
  feeCurrency?: string;
  estimatedCompletionDate: string | null;
  createdAt: string;
}

interface ExportRow {
  id: string;
  reportType: string | null;
  format: string;
  version: number;
  draft: boolean;
  lifecycle: string | null;
  createdAt: string;
  totalPresentValue: number;
  itemCount: number;
}

// ── Presentation maps ────────────────────────────────────────────────────────

const OUTCOME_LABEL: Record<FdeOutcome, string> = {
  NO_REPORT_INDICATED: "No Report Indicated",
  ADDITIONAL_INFO_REQUIRED: "Additional Information Required",
  MCP_RECOMMENDED: "Medical Cost Projection Recommended",
  LCP_RECOMMENDED: "Life Care Plan Recommended",
  LCP_PLUS_VOCATIONAL: "Life Care Plan + Vocational Recommended",
  LCP_PLUS_VOC_ECON: "Life Care Plan + Vocational + Economic Recommended",
  EXPERT_CONSULTATION: "Expert Consultation Recommended",
};

const OUTCOME_TONE: Record<FdeOutcome, BadgeTone> = {
  NO_REPORT_INDICATED: "neutral",
  ADDITIONAL_INFO_REQUIRED: "warning",
  MCP_RECOMMENDED: "info",
  LCP_RECOMMENDED: "success",
  LCP_PLUS_VOCATIONAL: "success",
  LCP_PLUS_VOC_ECON: "success",
  EXPERT_CONSULTATION: "ai",
};

const READINESS_LABEL: Record<string, string> = {
  NO_ACTION_INDICATED: "No action indicated",
  RECORDS_INCOMPLETE: "Records incomplete",
  READY_FOR_ENGAGEMENT: "Ready for engagement",
  NEEDS_EXPERT_TRIAGE: "Needs expert triage",
};

const PRODUCT_LABEL: Record<string, string> = {
  LIFE_CARE_PLAN: "Life Care Plan",
  MEDICAL_COST_PROJECTION: "Medical Cost Projection",
  VOCATIONAL_ASSESSMENT: "Vocational Assessment",
  FORENSIC_ECONOMIST_REPORT: "Forensic Economist Report",
  EXPERT_CONSULTATION: "Expert Consultation",
};

const productLabel = (id: string | null) => (id ? PRODUCT_LABEL[id] ?? id.replace(/_/g, " ") : "—");

const TABS = ["Overview", "Items Needed", "Report Options", "Active Engagements", "Final Deliverables"] as const;
type Tab = (typeof TABS)[number];

// ── Small pieces ─────────────────────────────────────────────────────────────

function FactorList({ title, factors, empty, tone }: { title: string; factors: FdeFactor[]; empty: string; tone: BadgeTone }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <h3 className="h-section">{title}</h3>
        <Badge tone={tone}>{factors.length}</Badge>
      </div>
      {factors.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {factors.map((f, i) => (
            <li key={`${f.factor}-${i}`} className="text-sm">
              <span className="font-medium text-ink-900">{f.factor}</span>
              <p className="mt-0.5 text-ink-600">{f.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfidenceBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-ink-600">{label}</span>
        <span className="font-medium tabular-nums text-ink-800">{value}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100">
        <div className={`h-full rounded-full ${value >= 70 ? "bg-emerald-500" : value >= 40 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function AttorneyWorkspace({ firmName, userName, cases, pricing }: Props) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [caseId, setCaseId] = useState<string | null>(cases[0]?.id ?? null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [reports, setReports] = useState<LibraryReport[] | null>(null);
  const [engagements, setEngagements] = useState<EngagementRow[] | null | "unavailable">(null);
  const [exportsRows, setExportsRows] = useState<ExportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = cases.find((c) => c.id === caseId) ?? null;

  const loadEvaluation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cases/${id}/damages-evaluation`);
      if (!res.ok) return;
      const body = await res.json();
      setEvaluation(body.evaluation ?? null);
      setIsStale(!!body.isStale);
    } catch {
      /* network hiccup — the empty state stands */
    }
  }, []);

  const loadReports = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cases/${id}/reports`);
      if (res.ok) setReports((await res.json()).reports ?? []);
    } catch {
      setReports([]);
    }
  }, []);

  const loadEngagements = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cases/${id}/engagements`);
      // The engagement API ships with another workstream — a 404 means the
      // surface is not live yet, which we disclose rather than error on.
      if (res.status === 404) setEngagements("unavailable");
      else if (res.ok) setEngagements((await res.json()).engagements ?? []);
      else setEngagements("unavailable");
    } catch {
      setEngagements("unavailable");
    }
  }, []);

  const loadExports = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cases/${id}/export`);
      if (res.ok) setExportsRows((await res.json()).exports ?? []);
    } catch {
      setExportsRows([]);
    }
  }, []);

  useEffect(() => {
    setEvaluation(null);
    setIsStale(false);
    setReports(null);
    setEngagements(null);
    setExportsRows(null);
    setError(null);
    if (!caseId) return;
    void loadEvaluation(caseId);
    void loadReports(caseId);
    void loadEngagements(caseId);
    void loadExports(caseId);
  }, [caseId, loadEvaluation, loadReports, loadEngagements, loadExports]);

  async function evaluate() {
    if (!caseId) return;
    setEvaluating(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/damages-evaluation`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Evaluation failed");
      else {
        setEvaluation(body.evaluation ?? null);
        setIsStale(false);
      }
    } catch {
      setError("Evaluation failed — please try again.");
    } finally {
      setEvaluating(false);
    }
  }

  // Released deliverables only: final (non-draft) exports. Legacy rows carry a
  // null lifecycle — a non-draft legacy export IS a released final.
  const deliverables = (exportsRows ?? []).filter((e) => !e.draft && (e.lifecycle === null || e.lifecycle === "final_expert"));

  return (
    <div>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{firmName}</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink-950">Attorney Workspace</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-600">
          {userName} — case posture, evidence gaps, report options, and released deliverables. This view is read-only:
          clinical data is authored and reviewed by the clinical team.
        </p>
      </div>

      {/* ── Case selector ─────────────────────────────────────────────────── */}
      <div className="mt-5 card p-4">
        <label htmlFor="attorney-case" className="text-meta">Case</label>
        {cases.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No cases yet — cases created by your firm appear here.</p>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <select
              id="attorney-case"
              value={caseId ?? ""}
              onChange={(e) => setCaseId(e.target.value)}
              className="w-full max-w-md rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none sm:w-auto"
            >
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientName} — {c.caseNumber}
                </option>
              ))}
            </select>
            {selected && (
              <span className="text-xs text-ink-500">
                <Badge tone="neutral">{selected.status.toLowerCase().replace(/_/g, " ")}</Badge>
                <span className="ml-2">{selected.documentCount} record{selected.documentCount === 1 ? "" : "s"} on file</span>
                {selected.dateOfInjury && <span className="ml-2">· injury {formatDate(selected.dateOfInjury)}</span>}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="mt-5 inline-flex flex-wrap items-center gap-1 rounded-xl bg-ink-100 p-1" role="tablist" aria-label="Attorney workspace sections">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-brand-800 shadow-sm"
                : "rounded-lg px-3 py-1.5 text-sm font-medium text-ink-500 hover:text-ink-800"
            }
          >
            {t}
          </button>
        ))}
      </div>

      {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      {!selected ? (
        <div className="card mt-4 p-6 text-sm text-ink-500">Select a case to see its damages posture.</div>
      ) : (
        <>
          {/* Stale banner — shown on every tab so the disclosure travels. */}
          {evaluation && isStale && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <span>
                The case record changed after this evaluation was run ({formatDate(evaluation.evaluatedAt)}) — the verdict below may be outdated.
              </span>
              <button onClick={evaluate} disabled={evaluating} className="btn-primary">
                {evaluating ? "Re-evaluating…" : "Re-run Evaluation"}
              </button>
            </div>
          )}

          {/* ── Overview ───────────────────────────────────────────────────── */}
          {tab === "Overview" && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="card p-4">
                  <span className="text-meta">Records Status</span>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="num-metric text-2xl">{selected.documentCount}</span>
                    <span className="text-xs text-ink-500">documents · {selected.chronologyCount} chronology events</span>
                  </div>
                </div>
                <div className="card p-4">
                  <span className="text-meta">Readiness</span>
                  <div className="mt-2 text-sm font-medium text-ink-900">
                    {evaluation ? READINESS_LABEL[evaluation.readinessState] ?? evaluation.readinessState : "Not yet evaluated"}
                  </div>
                </div>
                <div className="card p-4">
                  <span className="text-meta">Open Validation Issues</span>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="num-metric text-2xl">{evaluation ? evaluation.unresolvedValidationIssues : "—"}</span>
                    <span className="text-xs text-ink-500">at last evaluation</span>
                  </div>
                </div>
              </div>

              {!evaluation ? (
                <div className="card p-6 text-center">
                  <h3 className="text-base font-semibold text-ink-900">No damages evaluation yet</h3>
                  <p className="mx-auto mt-1 max-w-xl text-sm text-ink-600">
                    Run the deterministic evaluation to see which report — if any — the current case record supports. It reads only
                    the structured case data; nothing is estimated or invented.
                  </p>
                  <button onClick={evaluate} disabled={evaluating} className="btn-primary mt-4">
                    {evaluating ? "Evaluating…" : "Evaluate for Future Damages"}
                  </button>
                </div>
              ) : (
                <div className="card p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={OUTCOME_TONE[evaluation.overallOutcome] ?? "neutral"}>
                        {OUTCOME_LABEL[evaluation.overallOutcome] ?? evaluation.overallOutcome}
                      </Badge>
                      <span className="text-xs text-ink-500">
                        evaluated {formatDate(evaluation.evaluatedAt)} · logic {evaluation.logicVersion}
                      </span>
                    </div>
                    <button onClick={evaluate} disabled={evaluating} className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:border-ink-300">
                      {evaluating ? "Re-evaluating…" : "Re-run"}
                    </button>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <div>
                      <span className="text-meta">Recommended Report</span>
                      <p className="mt-1 text-sm font-semibold text-ink-900">{productLabel(evaluation.recommendedPrimaryProduct)}</p>
                      {evaluation.recommendedAdditionalProducts.length > 0 && (
                        <p className="mt-0.5 text-sm text-ink-600">plus {evaluation.recommendedAdditionalProducts.map(productLabel).join(" and ")}</p>
                      )}
                      <p className="mt-2 text-sm leading-6 text-ink-600">{explainLowerCostOption(evaluation.overallOutcome)}</p>
                    </div>
                    <div>
                      <span className="text-meta">Estimated Medical Range</span>
                      {evaluation.estimatedMedicalRange ? (
                        <>
                          <p className="mt-1 text-sm font-semibold tabular-nums text-ink-900">
                            {formatMoney(evaluation.estimatedMedicalRange.lowPV)} – {formatMoney(evaluation.estimatedMedicalRange.highPV)}
                            <span className="ml-1.5 text-xs font-normal text-ink-500">(base {formatMoney(evaluation.estimatedMedicalRange.basePV)})</span>
                          </p>
                          <p className="mt-1 text-xs leading-5 text-ink-500">
                            Range of physician-reviewed projected medical costs currently in the case record — not a case valuation.
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-ink-500">
                          No range yet — a range appears once at least one recommendation has been physician-reviewed.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-4">
                    <span className="text-meta">Next Actions</span>
                    <ul className="mt-1.5 list-inside list-disc space-y-1 text-sm text-ink-700">
                      {evaluation.nextActions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Items Needed — the attorney's own inputs required before any
                 report can be prepared, each with a jump into the case. ────── */}
          {tab === "Items Needed" && (
            <div className="mt-4 space-y-4">
              {(() => {
                const items = selected
                  ? attorneyItemsNeeded({
                      dateOfBirth: selected.dateOfBirth,
                      dateOfInjury: selected.dateOfInjury,
                      diagnosis: selected.diagnosis,
                      jurisdiction: selected.jurisdiction,
                      specialty: selected.specialty,
                      documentCount: selected.documentCount,
                    })
                  : [];
                return (
                  <div className="card p-5">
                    <div className="flex items-center gap-2">
                      <h3 className="h-section">Items Needed From You</h3>
                      {selected && (items.length === 0
                        ? <Badge tone="success">nothing outstanding</Badge>
                        : <Badge tone="warning">{items.length} item{items.length === 1 ? "" : "s"}</Badge>)}
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      What the firm needs from your side before any report can be prepared on this matter. Clinical work is handled by the clinical team after you order.
                    </p>
                    {!selected ? (
                      <p className="mt-3 text-sm text-ink-500">Select a matter above.</p>
                    ) : items.length === 0 ? (
                      <p className="mt-3 text-sm text-ink-600">Everything needed from your side is on file for this matter.</p>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {items.map((it) => (
                          <li key={it.label} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50/70 p-3 text-sm">
                            <span className="text-ink-800">{it.label}</span>
                            <a
                              className="focusable rounded text-xs font-semibold text-brand-700 hover:underline"
                              href={`/cases/${selected.id}?tab=${it.tab}`}
                            >
                              Go To — {it.action}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── Report Options ─────────────────────────────────────────────── */}
          {tab === "Report Options" && (
            <div className="mt-4 card overflow-hidden">
              {reports === null ? (
                <div className="p-6 text-sm text-ink-500">Loading report options…</div>
              ) : reports.length === 0 ? (
                <div className="p-6 text-sm text-ink-500">No report types are enabled for this firm yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Report</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Fee</th>
                      <th className="px-4 py-2.5 font-medium">Turnaround</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {reports.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2.5">
                          <span className="font-medium text-ink-900">{r.name}</span>
                          <p className="mt-0.5 max-w-md text-xs text-ink-500">{r.description}</p>
                        </td>
                        <td className="px-4 py-2.5"><Badge tone={r.status === "Ready" || r.status === "Previously exported" ? "success" : "neutral"}>{r.status}</Badge></td>
                        <td className="px-4 py-2.5 text-ink-700">{pricing[r.id] ?? "Contact for pricing"}</td>
                        <td className="px-4 py-2.5 text-ink-700">{pricing[`${r.id}.turnaround`] ?? "Contact for timing"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="border-t border-ink-100 px-4 py-3 text-xs text-ink-500">
                Report generation is handled by the clinical team — this listing is informational for engagement planning.
              </div>
            </div>
          )}

          {/* ── Active Engagements ─────────────────────────────────────────── */}
          {tab === "Active Engagements" && (
            <div className="mt-4 card p-5">
              {engagements === "unavailable" ? (
                <div className="py-6 text-center">
                  <h3 className="text-base font-semibold text-ink-900">Engagement tracking activating</h3>
                  <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">
                    Engagement status for this firm is being switched on — authorized report engagements will appear here.
                  </p>
                </div>
              ) : engagements === null ? (
                <p className="text-sm text-ink-500">Loading engagements…</p>
              ) : engagements.length === 0 ? (
                <p className="text-sm text-ink-500">No active engagements on this case yet.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {engagements.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                      <div>
                        <span className="font-medium text-ink-900">{productLabel(e.reportType)}</span>
                        <span className="ml-2 text-xs text-ink-500">requested {formatDate(e.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {e.feeEstimate != null && <span className="text-xs tabular-nums text-ink-600">{formatMoney(e.feeEstimate)}</span>}
                        {e.estimatedCompletionDate && <span className="text-xs text-ink-500">est. {formatDate(e.estimatedCompletionDate)}</span>}
                        <Badge tone={e.status === "COMPLETED" ? "success" : e.status === "CANCELLED" ? "neutral" : "info"}>
                          {e.status.toLowerCase().replace(/_/g, " ")}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ── Final Deliverables ─────────────────────────────────────────── */}
          {tab === "Final Deliverables" && (
            <div className="mt-4 card overflow-hidden">
              {exportsRows === null ? (
                <div className="p-6 text-sm text-ink-500">Loading deliverables…</div>
              ) : deliverables.length === 0 ? (
                <div className="p-6 text-sm text-ink-500">
                  No released final reports yet — finalized deliverables appear here once the clinical team completes and releases them.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Deliverable</th>
                      <th className="px-4 py-2.5 font-medium">Version</th>
                      <th className="px-4 py-2.5 font-medium">Released</th>
                      <th className="px-4 py-2.5 font-medium">Download</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {deliverables.map((e) => (
                      <tr key={e.id}>
                        <td className="px-4 py-2.5">
                          <span className="font-medium text-ink-900">{productLabel(e.reportType ?? "LIFE_CARE_PLAN")}</span>
                          <span className="ml-2 text-xs uppercase text-ink-400">{e.format}</span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-ink-700">v{e.version}</td>
                        <td className="px-4 py-2.5 text-ink-500">{formatDate(e.createdAt)}</td>
                        <td className="px-4 py-2.5">
                          <a
                            href={`/api/cases/${selected.id}/export/${e.id}/download`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-brand-700 hover:underline"
                          >
                            Download
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
