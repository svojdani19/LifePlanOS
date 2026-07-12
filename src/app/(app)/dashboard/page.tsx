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

export default async function DashboardPage() {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;
  const tier = ctx.subscription?.tier ?? "SOLO";
  const limits = effectiveLimits(tier, ctx.subscription ?? undefined);

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
          <h1 className="text-2xl font-bold text-ink-900">Firm Dashboard</h1>
          <p className="mt-1 text-sm text-ink-600">
            {ctx.firm.name} · {PLANS[tier].name} plan
          </p>
        </div>
        <Link href="/cases" className="btn-primary">
          <FolderKanban className="h-4 w-4" /> Go to Cases
        </Link>
      </div>

      {/* KPIs */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="card p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-500">{k.label}</span>
              <k.icon className="h-5 w-5 text-brand-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-ink-900">{k.value}</span>
              <span className="text-xs text-ink-500">{k.sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Role-specific work queues (P3) */}
      {roleCards.length > 0 && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {roleCards.map((card) => (
            <div key={card.title} className="card p-6">
              <h2 className="text-sm font-semibold text-ink-900">{card.title}</h2>
              <ul className="mt-4 space-y-2">
                {card.rows.length === 0 && <li className="text-sm text-ink-500">{card.empty}</li>}
                {card.rows.map((r) => (
                  <li key={r.href + r.label} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={r.href} className="min-w-0 truncate font-medium text-brand-700 hover:underline">{r.label}</Link>
                    <span className="shrink-0 text-xs text-ink-500">{r.meta}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

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
        <Badge tone="green">HIPAA-ready</Badge>
        <Badge tone="brand">Audit trail active</Badge>
        <span>Every action on this dashboard is scoped to your firm and logged.</span>
      </div>
    </div>
  );
}
