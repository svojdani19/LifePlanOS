import { redirect } from "next/navigation";
import { AdminNav } from "@/components/ui/AdminNav";
import { requireContext } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { REPORT_FLAGS, flagEnabled, type ReportFlagKey } from "@/lib/flags";
import { RolesAccess } from "@/components/roles/RolesAccess";

// Roles & Access admin console (docs/26 P5): built-in templates, custom role
// builder, scoped assignments, permission matrix, access review, and history.

export default async function RolesPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "team.manage")) redirect("/dashboard");

  // Resolve the firm's feature-flag posture server-side so the role editor can
  // warn about keys gated behind flags this firm has not enabled.
  const enabledFlags = Object.fromEntries(
    (Object.keys(REPORT_FLAGS) as ReportFlagKey[]).map((k) => [k, flagEnabled(ctx.firm.features, k)]),
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Roles & Access</h1>
        <p className="mt-1 text-sm text-ink-600">
          Built-in templates, custom roles, scoped assignments, and access review — every change is audited.
        </p>
        <AdminNav current="/roles" />
      </div>
      <RolesAccess enabledFlags={enabledFlags} />
    </div>
  );
}
