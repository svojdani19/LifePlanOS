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
  FUTURE_CARE: "Future care",
  PRICING: "Pricing",
  DRAFTING: "Drafting",
  PHYSICIAN_REVIEW: "Physician review",
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

  const kpis = [
    { label: "Active cases", value: active, sub: limits.caseLimit === null ? "unlimited" : `of ${limits.caseLimit}`, icon: FolderKanban },
    { label: "Awaiting physician sign-off", value: physicianReview, sub: "cases", icon: Sparkles },
    { label: "Seats in use", value: seats, sub: `of ${limits.seatLimit}`, icon: Users },
    { label: "AI generations", value: aiUsed, sub: limits.aiGenerationLimit === null ? "this month" : `of ${limits.aiGenerationLimit} this month`, icon: Layers },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">Firm dashboard</h1>
          <p className="mt-1 text-sm text-ink-600">
            {ctx.firm.name} · {PLANS[tier].name} plan
            {ctx.subscription?.status === "TRIALING" && ctx.subscription.trialEndsAt && (
              <>
                {" "}
                · <span className="font-medium text-brand-700">trial ends {formatDate(ctx.subscription.trialEndsAt)}</span>
              </>
            )}
          </p>
        </div>
        <Link href="/cases" className="btn-primary">
          <FolderKanban className="h-4 w-4" /> Go to cases
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

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Cases by stage */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-900">Cases by stage</h2>
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
          <h2 className="text-sm font-semibold text-ink-900">Recent activity</h2>
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
