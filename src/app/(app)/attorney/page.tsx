import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { accessibleCaseIds } from "@/lib/authz/caseScope";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import AttorneyWorkspace from "@/components/attorney/AttorneyWorkspace";

// Attorney workspace (MDIP — docs/28). Read-only surface for the retaining
// attorney: damages-evaluation posture, evidence gaps, report options with
// firm pricing, engagement status, and released final deliverables.
// Guard (case-scoped, assignment-based — docs/28 MDIP hardening): legacy
// ADMIN/ATTORNEY_REVIEWER are firm staff and see firm cases; ATTORNEY_CLIENT
// assignment holders see ONLY the cases their case-scoped assignments grant
// (org-wide external sharing is deliberately not honored — sharing is per
// case). Platform-admin assignments may view read-only (no evaluation or
// engagement-request controls). Everyone else lands back on the dashboard.

export default async function AttorneyPage() {
  const ctx = await requireContext();
  const access = await accessibleCaseIds(ctx, {
    firmWideRoles: ["ADMIN", "ATTORNEY_REVIEWER"],
    assignmentTemplates: ["ATTORNEY_CLIENT"],
    orgWideAssignmentGrantsAll: false,
    engagementSlots: [],
  });
  if (!access.allowed) redirect("/dashboard");
  // null = firm-wide; otherwise the explicit accessible case-id list.
  const scoped = access.cases === "all" ? null : access.cases;

  const cases = await prisma.case.findMany({
    where: { firmId: ctx.firm.id, ...(scoped ? { id: { in: scoped } } : {}), status: { notIn: ["ARCHIVED"] } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      clientName: true,
      caseNumber: true,
      status: true,
      dateOfInjury: true,
      updatedAt: true,
      _count: { select: { documents: true, chronologyEvents: true } },
    },
  });

  // Platform-admin view is strictly read-only: a plain matter list without the
  // evaluation / engagement-request controls the full workspace carries.
  if (access.platformAdminReadOnly) {
    return (
      <div>
        <h1 className="h-page">Attorney Workspace</h1>
        <p className="mt-1 text-sm text-ink-600">Read-only platform view — no evaluation or engagement controls.</p>
        <div className="card mt-5 overflow-hidden">
          {cases.length === 0 ? (
            <div className="p-5 text-sm text-ink-500">No matters to show.</div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {cases.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate">
                    <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                    <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-ink-500">
                    <Badge tone="neutral">{c.status.toLowerCase().replace(/_/g, " ")}</Badge>
                    <span>updated {formatDate(c.updatedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // Per-firm pricing placeholders: Firm.features["pricing.<REPORT_TYPE>"].
  const features = (ctx.firm.features ?? {}) as Record<string, unknown>;
  const pricing: Record<string, string> = {};
  for (const [key, value] of Object.entries(features)) {
    if (key.startsWith("pricing.") && typeof value === "string") pricing[key.slice("pricing.".length)] = value;
  }

  return (
    <AttorneyWorkspace
      firmName={ctx.firm.name}
      userName={ctx.user.name}
      pricing={pricing}
      cases={cases.map((c) => ({
        id: c.id,
        clientName: c.clientName,
        caseNumber: c.caseNumber,
        status: c.status,
        dateOfInjury: c.dateOfInjury ? c.dateOfInjury.toISOString() : null,
        updatedAt: c.updatedAt.toISOString(),
        documentCount: c._count.documents,
        chronologyCount: c._count.chronologyEvents,
      }))}
    />
  );
}
