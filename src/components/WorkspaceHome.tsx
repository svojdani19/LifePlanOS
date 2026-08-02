import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { LEGACY_ROLE_MAP } from "@/lib/authz/roles";
import { WORKSPACES } from "@/lib/workspaces";

export async function WorkspaceHome({ workspaceKey }: { workspaceKey: string }) {
  const ctx = await requireContext();
  const assignments = await prisma.userRoleAssignment.findMany({
    where: { userId: ctx.user.id, firmId: ctx.firm.id, status: "ACTIVE" },
    select: { builtInRole: true },
  });
  const allowed = new Set(assignments.map((a) => a.builtInRole).filter(Boolean));
  allowed.add(LEGACY_ROLE_MAP[ctx.user.role]);
  if (!allowed.has(workspaceKey)) redirect("/dashboard");

  const workspace = WORKSPACES[workspaceKey];
  if (!workspace) redirect("/dashboard");
  const [cases, records, reviews, findings, reports, users] = await Promise.all([
    prisma.case.count({ where: { firmId: ctx.firm.id, status: { notIn: ["CLOSED", "ARCHIVED"] } } }),
    prisma.document.count({ where: { firmId: ctx.firm.id } }),
    prisma.futureCareItem.count({ where: { case: { firmId: ctx.firm.id }, physicianStatus: "PENDING", supersededAt: null } }),
    prisma.validationFinding.count({ where: { firmId: ctx.firm.id, exportBlocking: true } }),
    prisma.reportExport.count({ where: { firmId: ctx.firm.id } }),
    prisma.user.count({ where: { firmId: ctx.firm.id, status: { in: ["ACTIVE", "INVITED"] } } }),
  ]);
  const values = { cases, records, reviews, findings, reports, users };

  return (
    <div>
      <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{ctx.firm.name}</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink-950">{workspace.label} Workspace</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-600">{workspace.objective}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {workspace.actions.map((action) => <Link key={action.label} href={action.href} className="btn-primary">{action.label}</Link>)}
        </div>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {workspace.metrics.map((metric) => (
          <div key={metric.label} className="card p-5"><p className="text-meta">{metric.label}</p><p className="num-metric mt-2 text-3xl">{values[metric.field]}</p></div>
        ))}
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {workspace.sections.map((section) => (
          <section key={section.title} className="card p-5">
            <h2 className="h-section">{section.title}</h2>
            <ul className="mt-3 space-y-2 text-sm text-ink-650">
              {section.items.map((item) => <li key={item} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-5 text-xs text-ink-500">All counts are live and tenant-scoped. Professional approvals remain credential-gated and auditable.</p>
    </div>
  );
}
