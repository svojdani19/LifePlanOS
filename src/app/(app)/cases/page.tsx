import { requireContext, activeCaseCount } from "@/lib/tenant";
import { externalOnlyCaseIds } from "@/lib/authz/caseScope";
import { prisma } from "@/lib/db";
import { effectiveLimits } from "@/lib/subscription/plans";
import { PageHeader } from "@/components/ui/PageHeader";
import { NewCaseForm } from "@/components/NewCaseForm";
import { CasesTable } from "@/components/CasesTable";
import { can } from "@/lib/rbac";

export default async function CasesPage() {
  const ctx = await requireContext();
  // Guests (case-scoped external-class assignments only) see ONLY the cases
  // explicitly shared with them — never the firm-wide list (docs/28 MDIP).
  const externalOnly = await externalOnlyCaseIds(ctx);
  const [cases, active] = await Promise.all([
    prisma.case.findMany({
      where: { firmId: ctx.firm.id, ...(externalOnly ? { id: { in: externalOnly } } : {}) },
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
    activeCaseCount(ctx.firm.id),
  ]);
  const pvSums = await prisma.futureCareItem.groupBy({
    by: ["caseId"],
    where: { caseId: { in: cases.map((c) => c.id) }, supersededAt: null },
    _sum: { presentValue: true },
  });
  const pvByCase = new Map(pvSums.map((p) => [p.caseId, p._sum.presentValue ?? 0]));
  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const atLimit = limits.caseLimit !== null && active >= limits.caseLimit;

  return (
    <div>
      <PageHeader
        title="Cases"
        subtitle={`${active} active${limits.caseLimit === null ? "" : ` of ${limits.caseLimit}`} · ${cases.length} total`}
        actions={can(ctx.user.role, "case.create") && externalOnly === null ? <NewCaseForm /> : undefined}
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
          presentValue: pvByCase.get(c.id) ?? 0,
          mdPending: c._count.futureCareItems,
          blockingFindings: c._count.validationFindings,
          documentCount: c._count.documents,
        }))}
      />
    </div>
  );
}
