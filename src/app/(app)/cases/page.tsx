import { requireContext, activeCaseCount } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { effectiveLimits } from "@/lib/subscription/plans";
import { PageHeader } from "@/components/ui/PageHeader";
import { NewCaseForm } from "@/components/NewCaseForm";
import { CasesTable } from "@/components/CasesTable";
import { can } from "@/lib/rbac";

export default async function CasesPage() {
  const ctx = await requireContext();
  const [cases, active] = await Promise.all([
    prisma.case.findMany({
      where: { firmId: ctx.firm.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true, caseNumber: true, clientName: true, caseType: true, side: true, status: true, updatedAt: true },
    }),
    activeCaseCount(ctx.firm.id),
  ]);
  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const atLimit = limits.caseLimit !== null && active >= limits.caseLimit;

  return (
    <div>
      <PageHeader
        title="Cases"
        subtitle={`${active} active${limits.caseLimit === null ? "" : ` of ${limits.caseLimit}`} · ${cases.length} total`}
        actions={can(ctx.user.role, "case.create") ? <NewCaseForm /> : undefined}
      />

      {atLimit && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          You&apos;ve reached your plan&apos;s active-case limit. Close a case or{" "}
          <a href="/billing" className="font-semibold underline">upgrade your plan</a> to add more.
        </div>
      )}

      <CasesTable rows={cases.map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() }))} />
    </div>
  );
}
