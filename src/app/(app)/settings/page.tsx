import { redirect } from "next/navigation";
import Link from "next/link";
import { Library, ChevronRight } from "lucide-react";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { can } from "@/lib/rbac";
import { FirmSettingsForm } from "@/components/FirmSettingsForm";
import { Badge } from "@/components/ui/Badge";

export default async function SettingsPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "firm.settings")) redirect("/dashboard");
  const precedentCount = await prisma.precedentPlan.count({ where: { firmId: ctx.firm.id } });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Firm Management</h1>
        <p className="mt-1 text-sm text-ink-600">Branding, report identity, and firm resources for {ctx.firm.name}.</p>
      </div>

      {/* Firm resources — links to firm-wide tools. */}
      <div className="mb-8">
        <h2 className="text-sm font-semibold text-ink-900">Firm Resources</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {can(ctx.user.role, "precedents.manage") && (
            <Link href="/settings/library" className="card flex items-center gap-3 p-4 transition-colors hover:border-brand-300 hover:bg-brand-50/40">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700"><Library className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink-900">LCP Precedent Library</p>
                <p className="text-xs text-ink-500">Search {precedentCount} finalized life care plan{precedentCount === 1 ? "" : "s"} the firm has uploaded or synced.</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-400" />
            </Link>
          )}
        </div>
      </div>

      <FirmSettingsForm
        initial={{
          name: ctx.firm.name,
          state: ctx.firm.state ?? "",
          primaryColor: ctx.firm.primaryColor ?? "#0891b2",
          letterhead: ctx.firm.letterhead ?? "",
          logoUrl: ctx.firm.logoUrl ?? "",
        }}
      />

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-ink-900">Compliance & Data Handling</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="green">Encryption in transit</Badge>
          <Badge tone="green">Encryption at rest</Badge>
          <Badge tone="green">Role-based access</Badge>
          <Badge tone="green">Audit logging</Badge>
          <Badge tone="brand">BAA-ready</Badge>
          <Badge tone="brand">Tenant isolation</Badge>
        </div>
        <p className="mt-3 max-w-2xl text-xs text-ink-500">
          All PHI is scoped to your firm and accessed only through the audited tenant guard. Data retention and export
          logging controls are configurable per firm on Enterprise plans.
        </p>
      </div>
    </div>
  );
}
