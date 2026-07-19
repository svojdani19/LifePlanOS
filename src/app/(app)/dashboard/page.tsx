import Link from "next/link";
import { FolderKanban, Users, Layers, Sparkles } from "lucide-react";
import { requireContext, activeCaseCount, seatCount } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { effectiveLimits, PLANS, currentPeriod } from "@/lib/subscription/plans";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

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
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

// Segmented view switch — the firm-wide dashboard and the signed-in user's
// personal dashboard (their cases can be a subset of the firm's).
function DashboardTabs({ view }: { view: "firm" | "me" }) {
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-brand-800 shadow-sm"
          : "rounded-lg px-3 py-1.5 text-sm font-medium text-ink-500 hover:text-ink-800"
      }
    >
      {label}
    </Link>
  );
  return (
    <div className="mt-4 inline-flex items-center gap-1 rounded-xl bg-ink-100 p-1" role="tablist" aria-label="Dashboard view">
      {tab("/dashboard", "Firm Dashboard", view === "firm")}
      {tab("/dashboard?view=me", "My Dashboard", view === "me")}
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams?: { view?: string } }) {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;
  const tier = ctx.subscription?.tier ?? "SOLO";
  const limits = effectiveLimits(tier, ctx.subscription ?? undefined);
  const view: "firm" | "me" = searchParams?.view === "me" ? "me" : "firm";

  // ── My Dashboard — scoped to the signed-in user's real assignments:
  //    cases they created or are the preparing physician for, plus review
  //    findings explicitly assigned to them. Nothing is invented.
  if (view === "me") {
    const uid = ctx.user.id;
    const myCases = await prisma.case.findMany({
      where: { firmId, OR: [{ createdById: uid }, { preparingPhysicianId: uid }], status: { notIn: ["CLOSED", "ARCHIVED"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, clientName: true, caseNumber: true, status: true, updatedAt: true, preparingPhysicianId: true },
    });
    const myCaseIds = myCases.map((c) => c.id);
    const [pendingMd, blocking, assignedToMe, myActivity] = await Promise.all([
      myCaseIds.length
        ? prisma.futureCareItem.groupBy({ by: ["caseId"], where: { caseId: { in: myCaseIds }, physicianStatus: "PENDING", supersededAt: null }, _count: true })
        : Promise.resolve([] as { caseId: string; _count: number }[]),
      myCaseIds.length
        ? prisma.validationFinding.groupBy({ by: ["caseId"], where: { caseId: { in: myCaseIds }, exportBlocking: true }, _count: true })
        : Promise.resolve([] as { caseId: string; _count: number }[]),
      prisma.attentionItem.findMany({
        where: { firmId, assignedUserId: uid, status: { in: ["OPEN", "IN_REVIEW"] } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, caseId: true, title: true, severity: true },
      }),
      prisma.auditLog.findMany({ where: { firmId, userId: uid }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, action: true, createdAt: true } }),
    ]);
    const mdByCase = new Map(pendingMd.map((p) => [p.caseId, p._count]));
    const blockingByCase = new Map(blocking.map((b) => [b.caseId, b._count]));
    const caseNameById = new Map(myCases.map((c) => [c.id, c.clientName]));
    const totalMd = pendingMd.reduce((s, p) => s + p._count, 0);
    const totalBlocking = blocking.reduce((s, b) => s + b._count, 0);

    return (
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="h-page">My Dashboard</h1>
            <p className="mt-1 text-sm text-ink-600">{ctx.user.name} · {ctx.firm.name}</p>
          </div>
          <Link href="/cases" className="btn-primary"><FolderKanban className="h-4 w-4" /> Go to Cases</Link>
        </div>
        <DashboardTabs view="me" />

        {/* My metrics */}
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "My Active Cases", value: myCases.length, sub: "created or preparing" },
            { label: "Awaiting My Physician Review", value: totalMd, sub: "items on my cases" },
            { label: "Blocking Findings", value: totalBlocking, sub: "on my cases" },
            { label: "Findings Assigned to Me", value: assignedToMe.length, sub: "open / in review" },
          ].map((k) => (
            <div key={k.label} className="card p-4">
              <span className="text-meta">{k.label}</span>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="num-metric text-2xl">{k.value}</span>
                <span className="text-xs text-ink-500">{k.sub}</span>
              </div>
            </div>
          ))}
        </div>

        {/* My cases */}
        <h2 className="text-label mt-6">My Cases</h2>
        {myCases.length === 0 ? (
          <div className="card mt-2 p-5 text-sm text-ink-500">No cases are assigned to you yet — cases you create, or where you are the preparing physician, appear here.</div>
        ) : (
          <div className="card mt-2 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr><th className="px-4 py-2.5 font-medium">Case</th><th className="px-4 py-2.5 font-medium">Stage</th><th className="px-4 py-2.5 font-medium">MD pending</th><th className="px-4 py-2.5 font-medium">Blocking</th><th className="px-4 py-2.5 font-medium">Updated</th></tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {myCases.map((c) => (
                  <tr key={c.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                      <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                      {c.preparingPhysicianId === uid && <Badge tone="info" className="ml-2">preparing physician</Badge>}
                    </td>
                    <td className="px-4 py-2.5"><Badge tone="neutral">{c.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                    <td className="px-4 py-2.5 tabular-nums">{mdByCase.get(c.id) ?? 0}</td>
                    <td className="px-4 py-2.5 tabular-nums">{blockingByCase.get(c.id) ? <span className="font-medium text-red-700">{blockingByCase.get(c.id)}</span> : 0}</td>
                    <td className="px-4 py-2.5 text-ink-500">{formatDate(c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {/* Findings assigned to me */}
          <div className="card p-5">
            <h3 className="h-section">Findings Assigned to Me</h3>
            <ul className="mt-3 space-y-2">
              {assignedToMe.length === 0 && <li className="text-sm text-ink-500">No review findings are assigned to you.</li>}
              {assignedToMe.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/cases/${f.caseId}`} className="min-w-0 truncate font-medium text-brand-700 hover:underline">{f.title}</Link>
                  <span className="shrink-0 text-xs text-ink-500">{caseNameById.get(f.caseId) ?? "case"} · {f.severity.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* My recent activity */}
          <div className="card p-5">
            <h3 className="h-section">My Recent Activity</h3>
            <ul className="mt-3 space-y-2">
              {myActivity.length === 0 && <li className="text-sm text-ink-500">No activity yet.</li>}
              {myActivity.map((log) => (
                <li key={log.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink-600">{log.action}</span>
                  <span className="shrink-0 text-xs text-ink-400">{formatDate(log.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const [active, seats, byStage, aiThisPeriod, recent] = await Promise.all([
    activeCaseCount(firmId),
    seatCount(firmId),
    prisma.case.groupBy({ by: ["status"], where: { firmId }, _count: true }),
    prisma.usageRecord.aggregate({
      where: { firmId, metric: "AI_GENERATION", period: currentPeriod() },
      _sum: { quantity: true },
    }),
    prisma.auditLog.findMany({ where: { firmId }, orderBy: { createdAt: "desc" }, take: 8, include: { user: { select: { name: true } } } }),
  ]);

  const stageMap = new Map(byStage.map((s) => [s.status, s._count]));
  const physicianReview = stageMap.get("PHYSICIAN_REVIEW") ?? 0;
  const aiUsed = aiThisPeriod._sum.quantity ?? 0;

  // ── Role-specific work queue (P3) ──────────────────────────────────────────
  // Each role sees the queue that matters to it, scoped to the firm; nothing
  // beyond the role's permissions is exposed.
  const role = ctx.user.role;
  const caseName = async (ids: string[]) => {
    const rows = await prisma.case.findMany({ where: { id: { in: ids }, firmId }, select: { id: true, clientName: true, caseNumber: true } });
    return new Map(rows.map((r) => [r.id, r]));
  };
  const roleCards: { title: string; empty: string; rows: { href: string; label: string; meta: string }[] }[] = [];

  if (role === "PHYSICIAN_REVIEWER" || role === "ADMIN") {
    // Recommendations awaiting physician review, grouped by case.
    const pendingByCase = await prisma.futureCareItem.groupBy({
      by: ["caseId"],
      where: { physicianStatus: "PENDING", supersededAt: null, case: { firmId, status: { notIn: ["CLOSED", "ARCHIVED"] } } },
      _count: true,
      orderBy: { _count: { caseId: "desc" } },
      take: 6,
    });
    const names = await caseName(pendingByCase.map((p) => p.caseId));
    roleCards.push({
      title: "Awaiting Physician Review",
      empty: "No recommendations are awaiting physician review.",
      rows: pendingByCase.map((p) => ({
        href: `/cases/${p.caseId}`,
        label: names.get(p.caseId)?.clientName ?? "Case",
        meta: `${p._count} item${p._count === 1 ? "" : "s"} pending`,
      })),
    });
  }
  if (role === "PLANNER" || role === "PARALEGAL" || role === "ADMIN") {
    // Unresolved integrity findings (export-blocking first), grouped by case.
    const findingsByCase = await prisma.validationFinding.groupBy({
      by: ["caseId"],
      where: { firmId },
      _count: true,
      orderBy: { _count: { caseId: "desc" } },
      take: 6,
    });
    const blockingByCase = await prisma.validationFinding.groupBy({
      by: ["caseId"],
      where: { firmId, exportBlocking: true },
      _count: true,
    });
    const blocking = new Map(blockingByCase.map((b) => [b.caseId, b._count]));
    const names = await caseName(findingsByCase.map((f) => f.caseId));
    roleCards.push({
      title: "Plan Integrity — Open Findings",
      empty: "No open integrity findings across your cases.",
      rows: findingsByCase.map((f) => ({
        href: `/cases/${f.caseId}`,
        label: names.get(f.caseId)?.clientName ?? "Case",
        meta: `${f._count} finding${f._count === 1 ? "" : "s"}${blocking.get(f.caseId) ? ` · ${blocking.get(f.caseId)} blocks export` : ""}`,
      })),
    });
  }
  if (role === "ATTORNEY_REVIEWER" || role === "ADMIN") {
    // Damages posture: latest export totals per case + approved vs pending.
    const latestExports = await prisma.reportExport.findMany({
      where: { firmId, format: "DOCX" },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { caseId: true, totalPresentValue: true, version: true },
    });
    const seen = new Set<string>();
    const latest = latestExports.filter((e) => (seen.has(e.caseId) ? false : (seen.add(e.caseId), true))).slice(0, 6);
    const approvedByCase = await prisma.futureCareItem.groupBy({
      by: ["caseId", "physicianStatus"],
      where: { supersededAt: null, caseId: { in: latest.map((l) => l.caseId) } },
      _count: true,
    });
    const names = await caseName(latest.map((l) => l.caseId));
    const statusCount = (caseId: string, statuses: string[]) => approvedByCase.filter((a) => a.caseId === caseId && statuses.includes(a.physicianStatus)).reduce((s, a) => s + a._count, 0);
    roleCards.push({
      title: "Damages Posture (latest exports)",
      empty: "No reports have been exported yet.",
      rows: latest.map((l) => ({
        href: `/cases/${l.caseId}`,
        label: names.get(l.caseId)?.clientName ?? "Case",
        meta: `PV $${Math.round(l.totalPresentValue).toLocaleString()} (v${l.version}) · ${statusCount(l.caseId, ["APPROVED", "MODIFIED"])} approved / ${statusCount(l.caseId, ["PENDING"])} pending`,
      })),
    });
  }

  // "Today's Work" (Phase 5) — the first question the dashboard answers is
  // what needs attention now: blocked exports lead, then the role queues,
  // then recently completed AI generations. All real data; nothing invented.
  const blockedExportCases = await prisma.validationFinding.groupBy({
    by: ["caseId"],
    where: { firmId, exportBlocking: true },
    _count: true,
    orderBy: { _count: { caseId: "desc" } },
    take: 6,
  });
  if (blockedExportCases.length) {
    const names = await caseName(blockedExportCases.map((b) => b.caseId));
    roleCards.unshift({
      title: "Final Export Blocked",
      empty: "",
      rows: blockedExportCases.map((b) => ({
        href: `/cases/${b.caseId}`,
        label: names.get(b.caseId)?.clientName ?? "Case",
        meta: `${b._count} blocking finding${b._count === 1 ? "" : "s"}`,
      })),
    });
  }
  const recentGenerations = await prisma.auditLog.findMany({
    where: { firmId, action: "plan.generate" },
    orderBy: { createdAt: "desc" },
    take: 4,
    select: { caseId: true, createdAt: true },
  });
  if (recentGenerations.some((g) => g.caseId)) {
    const names = await caseName(recentGenerations.map((g) => g.caseId).filter((x): x is string => !!x));
    roleCards.push({
      title: "Recent AI Generations",
      empty: "",
      rows: recentGenerations
        .filter((g): g is typeof g & { caseId: string } => !!g.caseId)
        .map((g) => ({
          href: `/cases/${g.caseId}`,
          label: names.get(g.caseId)?.clientName ?? "Case",
          meta: formatDate(g.createdAt),
        })),
    });
  }
  const workCards = roleCards.filter((c) => c.rows.length > 0);

  const kpis = [
    { label: "Active Cases", value: active, sub: limits.caseLimit === null ? "unlimited" : `of ${limits.caseLimit}`, icon: FolderKanban },
    { label: "Awaiting Physician Sign-off", value: physicianReview, sub: "cases", icon: Sparkles },
    { label: "Seats in Use", value: seats, sub: `of ${limits.seatLimit}`, icon: Users },
    { label: "AI Generations", value: aiUsed, sub: limits.aiGenerationLimit === null ? "this month" : `of ${limits.aiGenerationLimit} this month`, icon: Layers },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h-page">Firm Dashboard</h1>
          <p className="mt-1 text-sm text-ink-600">
            {ctx.firm.name} · {PLANS[tier].name} plan
          </p>
        </div>
        <Link href="/cases" className="btn-primary">
          <FolderKanban className="h-4 w-4" /> Go to Cases
        </Link>
      </div>
      <DashboardTabs view="firm" />

      {/* ── Today's Work — actionable queues first ─────────────────────────── */}
      <h2 className="text-label mt-6">Today&apos;s Work</h2>
      {workCards.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">
          Nothing needs your attention right now — no blocked exports, pending sign-offs, or open findings.
        </div>
      ) : (
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          {workCards.map((card) => (
            <div key={card.title} className="card p-5">
              <h3 className="h-section">{card.title}</h3>
              <ul className="mt-3 space-y-2">
                {card.rows.map((r) => (
                  <li key={r.href + r.label} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={r.href} className="focusable min-w-0 truncate rounded font-medium text-brand-700 hover:underline">{r.label}</Link>
                    <span className="shrink-0 text-xs text-ink-500">{r.meta}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ── Operational metrics ────────────────────────────────────────────── */}
      <h2 className="text-label mt-6">Operations</h2>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Cases by stage */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-900">Cases by Stage</h2>
          <div className="mt-4 space-y-2">
            {Object.entries(STAGE_LABELS)
              .filter(([k]) => k !== "ARCHIVED")
              .map(([key, label]) => {
                const count = stageMap.get(key as never) ?? 0;
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 text-sm text-ink-600">{label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${active > 0 ? Math.min(100, (count / Math.max(active, 1)) * 100) : 0}%` }}
                      />
                    </div>
                    <span className="w-6 text-right text-sm font-medium text-ink-800">{count}</span>
                  </div>
                );
              })}
          </div>
        </div>

        {/* Recent activity (audit trail) */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-900">Recent Activity</h2>
          <ul className="mt-4 space-y-3">
            {recent.length === 0 && <li className="text-sm text-ink-500">No activity yet.</li>}
            {recent.map((log) => (
              <li key={log.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-ink-800">{log.user?.name ?? "System"}</span>{" "}
                  <span className="text-ink-500">{log.action}</span>
                </div>
                <span className="shrink-0 text-xs text-ink-400">{formatDate(log.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 text-xs text-ink-500">
        <Badge tone="neutral">Audit trail active</Badge>
        <span>Every action is scoped to your firm and logged.</span>
      </div>
    </div>
  );
}
