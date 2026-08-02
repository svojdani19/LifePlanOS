import { redirect } from "next/navigation";
import { AdminNav } from "@/components/ui/AdminNav";
import { requireContext } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { REPORT_FLAGS, flagEnabled, type ReportFlagKey } from "@/lib/flags";
import { RolesAccess } from "@/components/roles/RolesAccess";
import { prisma } from "@/lib/db";

// Roles & Access admin console (docs/26 P5): built-in templates, custom role
// builder, scoped assignments, permission matrix, access review, and history.

export default async function RolesPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "team.manage") && !ctx.supportMode) redirect("/dashboard");

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
      {ctx.supportMode ? <ReadOnlyRoles firmId={ctx.firm.id} /> : <RolesAccess enabledFlags={enabledFlags} />}
    </div>
  );
}

async function ReadOnlyRoles({ firmId }: { firmId: string }) {
  const [assignments, customRoles] = await Promise.all([
    prisma.userRoleAssignment.findMany({
      where: { firmId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      select: { id: true, builtInRole: true, responsibility: true, caseId: true, effectiveUntil: true },
    }),
    prisma.customRole.findMany({
      where: { firmId },
      orderBy: { name: "asc" },
      include: { _count: { select: { permissions: true } } },
    }),
  ]);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">READ-ONLY PLATFORM SUPPORT VIEW</div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4"><h2 className="font-semibold text-ink-900">Active assignments</h2><ul className="mt-2 space-y-2 text-sm">{assignments.map((a) => <li key={a.id} className="border-b border-ink-100 pb-2"><span className="font-medium">{a.builtInRole ?? "Custom role"}</span><span className="block text-xs text-ink-500">{a.caseId ? `Case-scoped · ${a.caseId}` : "Organization-scoped"}{a.responsibility ? ` · ${a.responsibility}` : ""}</span></li>)}</ul></div>
        <div className="card p-4"><h2 className="font-semibold text-ink-900">Custom roles</h2><ul className="mt-2 space-y-2 text-sm">{customRoles.map((role) => <li key={role.id} className="flex justify-between border-b border-ink-100 pb-2"><span>{role.name}</span><span className="text-ink-500">{role._count.permissions} permissions · {role.status.toLowerCase()}</span></li>)}{customRoles.length === 0 && <li className="text-ink-500">No custom roles.</li>}</ul></div>
      </div>
    </div>
  );
}
