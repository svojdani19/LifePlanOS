import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

// ─────────────────────────────────────────────────────────────────────────────
// Planner Workspace (MDIP docs/28). The planner's production queue: every open
// case grouped by workflow stage with, per case, the physician-status mix of
// its live future-care items, blocking integrity findings, the latest report
// export, and any stale (revision-requested) expert approvals. Everything is
// a real query; nothing is invented. Guard: legacy PLANNER/ADMIN or an ACTIVE
// LIFE_CARE_PLANNER assignment; anyone else is redirected to /dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_ORDER = ["INTAKE", "RECORDS", "CHRONOLOGY", "CAUSATION", "FUTURE_CARE", "PRICING", "DRAFTING", "PHYSICIAN_REVIEW", "FINAL"] as const;
const STAGE_LABELS: Record<string, string> = {
  INTAKE: "Intake",
  RECORDS: "Records",
  CHRONOLOGY: "Chronology",
  CAUSATION: "Causation",
  FUTURE_CARE: "Future Care",
  PRICING: "Pricing",
  DRAFTING: "Drafting",
  PHYSICIAN_REVIEW: "Physician Review",
  FINAL: "Final",
};

const LIFECYCLE_TONE: Record<string, BadgeTone> = {
  supporting: "neutral",
  draft_expert: "info",
  final_expert: "success",
  superseded: "neutral",
  amended: "warning",
};

export default async function PlannerWorkspacePage() {
  const ctx = await requireContext();
  const legacyAllowed = ctx.user.role === "PLANNER" || ctx.user.role === "ADMIN";
  if (!legacyAllowed) {
    const assignment = await prisma.userRoleAssignment.count({
      where: { userId: ctx.user.id, firmId: ctx.firm.id, status: "ACTIVE", builtInRole: "LIFE_CARE_PLANNER" },
    });
    if (assignment === 0) redirect("/dashboard");
  }
  const firmId = ctx.firm.id;

  const cases = await prisma.case.findMany({
    where: { firmId, status: { notIn: ["CLOSED", "ARCHIVED"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, clientName: true, caseNumber: true, status: true, updatedAt: true },
  });
  const caseIds = cases.map((c) => c.id);

  // `in: []` matches nothing, so the queries are safe when the firm has no
  // open cases — every list simply comes back empty.
  const [itemMix, blocking, exports, staleApprovals] = await Promise.all([
    prisma.futureCareItem.groupBy({
      by: ["caseId", "physicianStatus"],
      where: { caseId: { in: caseIds }, supersededAt: null },
      _count: true,
    }),
    prisma.validationFinding.groupBy({
      by: ["caseId"],
      where: { firmId, caseId: { in: caseIds }, exportBlocking: true },
      _count: true,
    }),
    // Recent exports; reduced below to the latest per case.
    prisma.reportExport.findMany({
      where: { firmId, caseId: { in: caseIds } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { caseId: true, reportType: true, format: true, version: true, lifecycle: true, draft: true, createdAt: true },
    }),
    // Revision requests: report-level approvals marked STALE on open cases.
    prisma.reportApproval.findMany({
      where: { firmId, caseId: { in: caseIds }, status: "STALE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, caseId: true, expertRole: true, kind: true, updatedAt: true },
    }),
  ]);

  const mixByCase = new Map<string, Record<string, number>>();
  for (const m of itemMix) {
    const rec = mixByCase.get(m.caseId) ?? {};
    rec[m.physicianStatus] = m._count;
    mixByCase.set(m.caseId, rec);
  }
  const blockingByCase = new Map(blocking.map((b) => [b.caseId, b._count]));
  const latestExportByCase = new Map<string, (typeof exports)[number]>();
  for (const e of exports) if (!latestExportByCase.has(e.caseId)) latestExportByCase.set(e.caseId, e);
  const staleByCase = new Map<string, typeof staleApprovals>();
  for (const s of staleApprovals) staleByCase.set(s.caseId, [...(staleByCase.get(s.caseId) ?? []), s]);

  const totalPending = itemMix.filter((m) => m.physicianStatus === "PENDING").reduce((s, m) => s + m._count, 0);
  const totalBlocking = blocking.reduce((s, b) => s + b._count, 0);

  const byStage = new Map<string, typeof cases>();
  for (const c of cases) byStage.set(c.status, [...(byStage.get(c.status) ?? []), c]);
  const stages = STAGE_ORDER.filter((s) => (byStage.get(s) ?? []).length > 0);

  const mixLabel = (caseId: string) => {
    const mix = mixByCase.get(caseId) ?? {};
    const parts: string[] = [];
    for (const [status, label] of [["PENDING", "pending"], ["APPROVED", "approved"], ["MODIFIED", "modified"], ["REJECTED", "rejected"]] as const) {
      if (mix[status]) parts.push(`${mix[status]} ${label}`);
    }
    return parts.length ? parts.join(" · ") : "no items yet";
  };

  return (
    <div>
      <PageHeader
        title="Planner Workspace"
        subtitle={`${cases.length} open case${cases.length === 1 ? "" : "s"} across ${stages.length} stage${stages.length === 1 ? "" : "s"}`}
        metrics={[
          { label: "Awaiting MD Review", value: String(totalPending) },
          { label: "Blocking Findings", value: String(totalBlocking) },
          { label: "Revision Requests", value: String(staleApprovals.length) },
        ]}
      />

      {/* ── Revision requests: stale expert approvals need a planner response ── */}
      {staleApprovals.length > 0 && (
        <div className="card mt-5 border-amber-200 bg-amber-50/60 p-4">
          <h2 className="text-sm font-semibold text-ink-900">Revision Requested — stale expert approvals</h2>
          <p className="mt-1 text-xs text-ink-600">The signed content changed after signing; the report needs re-export and re-approval from the case&apos;s Report tab.</p>
          <ul className="mt-2 space-y-1">
            {staleApprovals.map((s) => {
              const c = cases.find((x) => x.id === s.caseId);
              return (
                <li key={s.id} className="text-sm">
                  <Link href={`/cases/${s.caseId}?tab=report`} className="font-medium text-brand-700 hover:underline">{c ? `${c.clientName} · ${c.caseNumber}` : "Case"}</Link>
                  <span className="text-ink-500"> — {s.expertRole} {s.kind.toLowerCase()} stale since {formatDate(s.updatedAt)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── Queue by stage ────────────────────────────────────────────────────── */}
      {cases.length === 0 ? (
        <div className="card mt-5 p-6 text-sm text-ink-500">No open cases. Cases you or your firm create appear here, grouped by workflow stage.</div>
      ) : (
        stages.map((stage) => (
          <section key={stage} className="mt-6">
            <h2 className="text-label">{STAGE_LABELS[stage]} ({(byStage.get(stage) ?? []).length})</h2>
            <div className="card mt-2 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Case</th>
                    <th className="px-4 py-2.5 font-medium">Item Review Mix</th>
                    <th className="px-4 py-2.5 font-medium">Blocking</th>
                    <th className="px-4 py-2.5 font-medium">Latest Export</th>
                    <th className="px-4 py-2.5 font-medium">Updated</th>
                    <th className="px-4 py-2.5 font-medium">Go to</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {(byStage.get(stage) ?? []).map((c) => {
                    const exp = latestExportByCase.get(c.id);
                    const nBlocking = blockingByCase.get(c.id) ?? 0;
                    const nStale = (staleByCase.get(c.id) ?? []).length;
                    return (
                      <tr key={c.id} className="hover:bg-ink-50">
                        <td className="px-4 py-2.5">
                          <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                          <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                          {nStale > 0 && <Badge tone="warning" className="ml-2">{nStale} revision{nStale === 1 ? "" : "s"} requested</Badge>}
                        </td>
                        <td className="px-4 py-2.5 text-ink-600">{mixLabel(c.id)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{nBlocking > 0 ? <span className="font-medium text-red-700">{nBlocking}</span> : 0}</td>
                        <td className="px-4 py-2.5">
                          {exp ? (
                            <span className="text-ink-600">
                              {(exp.reportType ?? exp.format).toString().replace(/_/g, " ")} v{exp.version}
                              {exp.lifecycle && <Badge tone={LIFECYCLE_TONE[exp.lifecycle] ?? "neutral"} className="ml-1.5">{exp.lifecycle.replace(/_/g, " ")}</Badge>}
                              {!exp.lifecycle && exp.draft && <Badge tone="neutral" className="ml-1.5">draft</Badge>}
                            </span>
                          ) : (
                            <span className="text-ink-400">none yet</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-ink-500">{formatDate(c.updatedAt)}</td>
                        <td className="px-4 py-2.5">
                          {/* Case tabs are client-side; the links land on the case, labeled by destination. */}
                          <Link href={`/cases/${c.id}?tab=futurecare`} className="text-xs text-brand-700 hover:underline">Future Care</Link>
                          <span className="mx-1 text-ink-300">·</span>
                          <Link href={`/cases/${c.id}?tab=report`} className="text-xs text-brand-700 hover:underline">Report</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
