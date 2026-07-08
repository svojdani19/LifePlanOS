import { redirect } from "next/navigation";
import { requireContext } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { FirmSettingsForm } from "@/components/FirmSettingsForm";
import { Badge } from "@/components/ui/Badge";

export default async function SettingsPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "firm.settings")) redirect("/dashboard");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Firm settings</h1>
        <p className="mt-1 text-sm text-ink-600">Branding and report identity for {ctx.firm.name}.</p>
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
        <h2 className="text-sm font-semibold text-ink-900">Compliance & data handling</h2>
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
