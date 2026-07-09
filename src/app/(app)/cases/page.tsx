import { requireContext, activeCaseCount } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { effectiveLimits } from "@/lib/subscription/plans";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { NewCaseForm } from "@/components/NewCaseForm";
import { can } from "@/lib/rbac";

const CASE_TYPE_LABELS: Record<string, string> = {
  PERSONAL_INJURY: "Personal Injury",
  MED_MAL: "Med Mal",
  WORKERS_COMP: "Workers' Comp",
  PRODUCT_LIABILITY: "Product Liability",
  CATASTROPHIC: "Catastrophic",
};

const SIDE_TONE: Record<string, "brand" | "amber" | "slate"> = {
  PLAINTIFF: "brand",
  DEFENSE: "amber",
  NEUTRAL: "slate",
};

export default async function CasesPage() {
  const ctx = await requireContext();
  const [cases, active] = await Promise.all([
    prisma.case.findMany({
      where: { firmId: ctx.firm.id },
      orderBy: { updatedAt: "desc" },
      include: { createdBy: { select: { name: true } } },
    }),
    activeCaseCount(ctx.firm.id),
  ]);
  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const atLimit = limits.caseLimit !== null && active >= limits.caseLimit;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">Cases</h1>
          <p className="mt-1 text-sm text-ink-600">
            {active} active {limits.caseLimit === null ? "" : `of ${limits.caseLimit}`} · {cases.length} total
          </p>
        </div>
        {can(ctx.user.role, "case.create") && <NewCaseForm />}
      </div>

      {atLimit && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You've reached your plan's active-case limit. Close a case or{" "}
          <a href="/billing" className="font-semibold underline">
            upgrade your plan
          </a>{" "}
          to add more.
        </div>
      )}

      <div className="card mt-6 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-3 font-medium">Case #</th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Side</th>
              <th className="px-4 py-3 font-medium">Stage</th>
              <th className="px-4 py-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {cases.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-500">
                  No cases yet. Create your first case to begin an intake.
                </td>
              </tr>
            )}
            {cases.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-ink-50">
                <td className="px-4 py-3 font-mono text-xs text-ink-500">
                  <a href={`/cases/${c.id}`} className="hover:text-brand-700">{c.caseNumber}</a>
                </td>
                <td className="px-4 py-3 font-medium text-ink-900">
                  <a href={`/cases/${c.id}`} className="hover:text-brand-700">{c.clientName}</a>
                </td>
                <td className="px-4 py-3 text-ink-600">{CASE_TYPE_LABELS[c.caseType]}</td>
                <td className="px-4 py-3">
                  <Badge tone={SIDE_TONE[c.side]}>{c.side.toLowerCase()}</Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge tone="neutral">{c.status.toLowerCase().replace("_", " ")}</Badge>
                </td>
                <td className="px-4 py-3 text-ink-500">{formatDate(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
