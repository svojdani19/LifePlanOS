import { redirect } from "next/navigation";
import { requireContext, activeCaseCount, caseAccessFor } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { effectiveLimits } from "@/lib/subscription/plans";
import { PageHeader } from "@/components/ui/PageHeader";
import { NewCaseForm } from "@/components/NewCaseForm";
import { CasesTable } from "@/components/CasesTable";
import { can } from "@/lib/rbac";

export default async function CasesPage() {
  const ctx = await requireContext();
  const access = await caseAccessFor(ctx);
  if (!access.allowed) redirect("/dashboard");
  const scoped = access.cases === "all" ? null : access.cases;
  const [cases, active] = await Promise.all([
    prisma.case.findMany({
      where: { firmId: ctx.firm.id, ...(scoped ? { id: { in: scoped } } : {}) },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, caseNumber: true, clientName: true, caseType: true, side: true, status: true, updatedAt: true,
        _count: {
          select: {
            documents: true,
            futureCareItems: { where: { physicianStatus: "PENDING", supersededAt: null } },
            validationFindings: { where: { exportBlocking: true } },
          },
        },
      },
    }),
    scoped
      ? prisma.case.count({ where: { firmId: ctx.firm.id, id: { in: scoped }, status: { notIn: ["CLOSED", "ARCHIVED"] } } })
      : activeCaseCount(ctx.firm.id),
  ]);
  const attorneyView = ctx.user.role === "ATTORNEY_REVIEWER";
  const pvSums = await prisma.futureCareItem.groupBy({
    by: ["caseId"],
    where: { caseId: { in: cases.map((c) => c.id) }, supersededAt: null },
    _sum: { presentValue: true, lifetimeCost: true },
  });
  const pvByCase = new Map(pvSums.map((p) => [p.caseId, p._sum.presentValue ?? 0]));
  const lifetimeByCase = new Map(pvSums.map((p) => [p.caseId, p._sum.lifetimeCost ?? 0]));
  // Attorney rows show the estimated life value as a range (-30% / +10%,
  // rounded to the nearest $1k) instead of exact present value.
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const lifeRange = (v: number) => {
    if (!v) return null;
    const k = (x: number) => Math.round(x / 1000) * 1000;
    return `${fmt(k(v * 0.7))} – ${fmt(k(v * 1.1))}`;
  };
  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const atLimit = limits.caseLimit !== null && active >= limits.caseLimit;

  return (
    <div>
      <PageHeader
        title="Cases"
        subtitle={`${active} active${limits.caseLimit === null ? "" : ` of ${limits.caseLimit}`} · ${cases.length} total`}
        actions={can(ctx.user.role, "case.create") && scoped === null && !access.platformAdminReadOnly ? <NewCaseForm /> : undefined}
      />

      {atLimit && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          You&apos;ve reached your plan&apos;s active-case limit. Close a case or{" "}
          <a href="/billing" className="font-semibold underline">upgrade your plan</a> to add more.
        </div>
      )}

      <CasesTable
        rows={cases.map((c) => ({
          id: c.id, caseNumber: c.caseNumber, clientName: c.clientName, caseType: c.caseType, side: c.side, status: c.status,
          updatedAt: c.updatedAt.toISOString(),
          presentValue: attorneyView ? 0 : (pvByCase.get(c.id) ?? 0),
          estimatedLifeValue: attorneyView ? lifeRange(lifetimeByCase.get(c.id) ?? 0) : null,
          mdPending: c._count.futureCareItems,
          blockingFindings: c._count.validationFindings,
          documentCount: c._count.documents,
        }))}
      />
    </div>
  );
}
