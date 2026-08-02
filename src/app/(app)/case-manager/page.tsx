import Link from "next/link";
import { redirect } from "next/navigation";
import { FolderKanban, Inbox, FileText, CalendarClock } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { WORKSPACES } from "@/lib/workspaces";

// ─────────────────────────────────────────────────────────────────────────────
// Case Manager workspace — moves matters through intake, record collection,
// assignments, and deadlines. Coordination surface only: every control is a
// link into existing case tools; no clinical approval controls exist here.
// Access: legacy ADMIN / PLANNER / PARALEGAL, or an ACTIVE CASE_MANAGER
// role assignment (enterprise authz path).
// ─────────────────────────────────────────────────────────────────────────────

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

const stageBadge = (status: string) => (
  <Badge tone="neutral">{status.toLowerCase().replace(/_/g, " ")}</Badge>
);

export default async function CaseManagerPage() {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;

  // Server-side workspace guard (deny → dashboard).
  if (!(["ADMIN", "PLANNER", "PARALEGAL"] as string[]).includes(ctx.user.role)) {
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId: ctx.user.id, firmId, status: "ACTIVE", builtInRole: "CASE_MANAGER" },
      select: { id: true },
    });
    if (!assignment) redirect("/dashboard");
  }

  const [activeCases, docsByCase, byStage] = await Promise.all([
    prisma.case.findMany({
      where: { firmId, status: { notIn: ["CLOSED", "ARCHIVED"] } },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        clientName: true,
        caseNumber: true,
        status: true,
        dateOfBirth: true,
        diagnosis: true,
        updatedAt: true,
        createdById: true,
        preparingPhysicianId: true,
        _count: { select: { documents: true } },
      },
    }),
    prisma.document.groupBy({
      by: ["caseId"],
      where: { firmId },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.case.groupBy({ by: ["status"], where: { firmId }, _count: true }),
  ]);

  // Deadlines derive from engagements' estimated completion dates — there is no
  // dedicated deadline model. The table may be empty (or not yet migrated on
  // this database), in which case we render an honest empty state.
  let deadlines: {
    id: string;
    caseId: string;
    reportType: string;
    status: string;
    estimatedCompletionDate: Date | null;
  }[] = [];
  try {
    deadlines = await prisma.caseEngagement.findMany({
      where: {
        firmId,
        estimatedCompletionDate: { not: null },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      orderBy: { estimatedCompletionDate: "asc" },
      take: 10,
      select: { id: true, caseId: true, reportType: true, status: true, estimatedCompletionDate: true },
    });
  } catch {
    deadlines = []; // engagement table unavailable — degrade to the empty state
  }

  const lastUpload = new Map(docsByCase.map((d) => [d.caseId, d._max.createdAt]));
  const caseById = new Map(activeCases.map((c) => [c.id, c]));

  // Engagements can reference closed cases missing from the active list.
  const missingNames = deadlines.map((d) => d.caseId).filter((id) => !caseById.has(id));
  const extraNames = missingNames.length
    ? await prisma.case.findMany({
        where: { id: { in: missingNames }, firmId },
        select: { id: true, clientName: true, caseNumber: true },
      })
    : [];
  const nameFor = (caseId: string) => {
    const c = caseById.get(caseId);
    if (c) return { clientName: c.clientName, caseNumber: c.caseNumber };
    const e = extraNames.find((x) => x.id === caseId);
    return e ?? { clientName: "Case", caseNumber: "" };
  };

  // Intake queue: early-stage cases with concrete missing-intake signals.
  const intakeSignals = (c: (typeof activeCases)[number]): string[] => {
    const s: string[] = [];
    if (!c.dateOfBirth) s.push("No date of birth");
    if (!c.diagnosis) s.push("No primary diagnosis");
    if (c._count.documents === 0) s.push("No records uploaded");
    return s;
  };
  const intakeQueue = activeCases
    .filter((c) => (c.status === "INTAKE" || c.status === "RECORDS") && intakeSignals(c).length > 0)
    .slice(0, 12);

  const myCases = activeCases.filter(
    (c) => c.createdById === ctx.user.id || c.preparingPhysicianId === ctx.user.id,
  );

  const stageMap = new Map(byStage.map((s) => [s.status as string, s._count]));
  const casesWithoutRecords = activeCases.filter((c) => c._count.documents === 0).length;
  const today = new Date();
  const overdue = deadlines.filter((d) => d.estimatedCompletionDate && d.estimatedCompletionDate < today).length;

  const ws = WORKSPACES.CASE_MANAGER;
  const kpis = [
    { label: "Open Cases", value: activeCases.length, sub: "not closed or archived", icon: FolderKanban },
    { label: "Intake Queue", value: intakeQueue.length, sub: "missing intake data", icon: Inbox },
    { label: "Cases Without Records", value: casesWithoutRecords, sub: "0 documents uploaded", icon: FileText },
    { label: "Engagement Deadlines", value: deadlines.length, sub: overdue > 0 ? `${overdue} overdue` : "upcoming", icon: CalendarClock },
  ];

  return (
    <div>
      {/* Intro band */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{ctx.firm.name}</p>
          <h1 className="h-page mt-1">Case Manager Workspace</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-600">{ws.objective}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/cases" className="btn-primary"><FolderKanban className="h-4 w-4" /> Case Queue &amp; New Case</Link>
        </div>
      </div>

      {/* KPIs */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-meta">{k.label}</span>
              <k.icon className="h-4 w-4 text-ink-400" aria-hidden />
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="num-metric text-2xl">{k.value}</span>
              <span className="text-xs text-ink-500">{k.sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Intake queue */}
      <h2 className="text-label mt-6">Intake Queue</h2>
      {intakeQueue.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">
          No early-stage cases are missing intake data. Cases in Intake or Records with a missing date of birth,
          primary diagnosis, or record set appear here.
        </div>
      ) : (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">Missing</th>
                <th className="px-4 py-2.5 font-medium">Updated</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {intakeQueue.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                    <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                  </td>
                  <td className="px-4 py-2.5">{stageBadge(c.status)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {intakeSignals(c).map((s) => <Badge key={s} tone="warning">{s}</Badge>)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-ink-500">{formatDate(c.updatedAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/cases/${c.id}?tab=overview`} className="text-xs font-medium text-brand-700 hover:underline">Open intake</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* My assigned cases */}
      <h2 className="text-label mt-6">My Assigned Cases</h2>
      {myCases.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">
          No open cases are assigned to you — cases you created, or where you are the preparing physician, appear here.
        </div>
      ) : (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">Records</th>
                <th className="px-4 py-2.5 font-medium">Updated</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {myCases.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                    <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                    {c.preparingPhysicianId === ctx.user.id && <Badge tone="info" className="ml-2">preparing physician</Badge>}
                  </td>
                  <td className="px-4 py-2.5">{stageBadge(c.status)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{c._count.documents}</td>
                  <td className="px-4 py-2.5 text-ink-500">{formatDate(c.updatedAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/cases/${c.id}?tab=records`} className="text-xs font-medium text-brand-700 hover:underline">Open records</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Records status per case */}
      <h2 className="text-label mt-6">Records Status</h2>
      {activeCases.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">No open cases yet. <Link href="/cases" className="text-brand-700 hover:underline">Create the first case</Link>.</div>
      ) : (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">Documents</th>
                <th className="px-4 py-2.5 font-medium">Last Upload</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {activeCases.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                    <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                  </td>
                  <td className="px-4 py-2.5">{stageBadge(c.status)}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {c._count.documents === 0 ? <span className="font-medium text-amber-700">0</span> : c._count.documents}
                  </td>
                  <td className="px-4 py-2.5 text-ink-500">
                    {lastUpload.get(c.id) ? formatDate(lastUpload.get(c.id)) : <span className="text-ink-400">never</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/cases/${c.id}?tab=records`} className="text-xs font-medium text-brand-700 hover:underline">Open records</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Deadlines from engagements */}
        <div className="card p-5">
          <h3 className="h-section">Engagement Deadlines</h3>
          <p className="mt-1 text-xs text-ink-500">Derived from engagement estimated-completion dates — the platform has no separate deadline model.</p>
          {deadlines.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">No engagements with an estimated completion date. Deadlines appear here once engagements are authorized with target dates.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {deadlines.map((d) => {
                const name = nameFor(d.caseId);
                const isOverdue = d.estimatedCompletionDate ? d.estimatedCompletionDate < today : false;
                return (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      <Link href={`/cases/${d.caseId}`} className="font-medium text-brand-700 hover:underline">{name.clientName}</Link>
                      <span className="ml-2 text-xs text-ink-500">{d.reportType.replace(/_/g, " ").toLowerCase()} · {d.status.toLowerCase()}</span>
                    </span>
                    <span className={`shrink-0 text-xs ${isOverdue ? "font-semibold text-red-700" : "text-ink-500"}`}>
                      {formatDate(d.estimatedCompletionDate)}{isOverdue ? " · overdue" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Workflow stages */}
        <div className="card p-5">
          <h3 className="h-section">Cases by Workflow Stage</h3>
          <div className="mt-3 space-y-2">
            {Object.entries(STAGE_LABELS).map(([key, label]) => {
              const count = stageMap.get(key) ?? 0;
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 text-sm text-ink-600">{label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${activeCases.length > 0 ? Math.min(100, (count / Math.max(activeCases.length, 1)) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="w-6 text-right text-sm font-medium text-ink-800">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="mt-5 text-xs text-ink-500">
        Coordination surface only — clinical approvals and attestations remain credential-gated in the case workspace.
      </p>
    </div>
  );
}
