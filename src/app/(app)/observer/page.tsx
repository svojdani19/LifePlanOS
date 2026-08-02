import { redirect } from "next/navigation";
import { Eye, FileDown } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

// ─────────────────────────────────────────────────────────────────────────────
// Observer workspace — STRICTLY read-only. Shows only cases explicitly shared
// with the signed-in user via a caseId-scoped ACTIVE role assignment, and only
// RELEASED deliverables (never drafts, never internal findings). There are no
// edit controls and no deep links into internal case tooling. Download links
// render only for roles holding report.export; the download API independently
// re-enforces permissions server-side.
// Access: legacy ATTORNEY_REVIEWER, or an ACTIVE assignment with an
// observer-class built-in role.
// ─────────────────────────────────────────────────────────────────────────────

const OBSERVER_TEMPLATES = ["READ_ONLY_OBSERVER", "EXTERNAL_EXPERT", "ATTORNEY_CLIENT", "INSURANCE_CLIENT"];

const TEMPLATE_LABEL: Record<string, string> = {
  READ_ONLY_OBSERVER: "Read-only observer",
  EXTERNAL_EXPERT: "External expert",
  ATTORNEY_CLIENT: "Attorney client",
  INSURANCE_CLIENT: "Insurance client",
};

function deliverableLabel(reportType: string | null, format: string): string {
  if (reportType) return reportType.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  return format === "MEMO" ? "Testimony prep pack" : "Life care plan";
}

export default async function ObserverPage() {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;
  const now = new Date();

  // Active, unexpired observer-class assignments for this user.
  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId: ctx.user.id,
      firmId,
      status: "ACTIVE",
      builtInRole: { in: OBSERVER_TEMPLATES },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }],
    },
    select: { caseId: true, builtInRole: true, responsibility: true },
  });

  // Server-side workspace guard (deny → dashboard).
  if (ctx.user.role !== "ATTORNEY_REVIEWER" && assignments.length === 0) redirect("/dashboard");

  // Visibility is assignment-scoped: ONLY cases explicitly shared via a
  // caseId-scoped assignment. Org-wide observer assignments do not broaden
  // this surface — sharing is deliberate, per case.
  const sharedCaseIds = Array.from(
    new Set(assignments.map((a) => a.caseId).filter((id): id is string => !!id)),
  );
  const roleByCase = new Map<string, string>();
  for (const a of assignments) {
    if (a.caseId && a.builtInRole && !roleByCase.has(a.caseId)) roleByCase.set(a.caseId, a.builtInRole);
  }

  const canDownload = can(ctx.user.role, "report.export");

  const [cases, releases] = sharedCaseIds.length
    ? await Promise.all([
        prisma.case.findMany({
          where: { id: { in: sharedCaseIds }, firmId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, clientName: true, caseNumber: true, status: true, updatedAt: true },
        }),
        // Released deliverables only: finalized (non-draft) exports in a
        // released lifecycle, or legacy finals (no lifecycle, no reportType).
        // Superseded and amended exports never appear.
        prisma.reportExport.findMany({
          where: {
            firmId,
            caseId: { in: sharedCaseIds },
            draft: false,
            supersededById: null,
            OR: [
              { lifecycle: { in: ["final_expert", "supporting"] } },
              { lifecycle: null, reportType: null },
            ],
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            caseId: true,
            reportType: true,
            format: true,
            version: true,
            lifecycle: true,
            createdAt: true,
            storageKey: true,
          },
        }),
      ])
    : [[], []];

  const releasesByCase = new Map<string, typeof releases>();
  for (const r of releases) {
    const list = releasesByCase.get(r.caseId) ?? [];
    list.push(r);
    releasesByCase.set(r.caseId, list);
  }

  return (
    <div>
      {/* Intro band */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{ctx.firm.name}</p>
          <h1 className="h-page mt-1">Shared Cases</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-600">
            Read-only view of the matters shared with you and their released deliverables. Drafts and internal work product are never shown here.
          </p>
        </div>
        <Badge tone="neutral" className="mb-1"><Eye className="mr-1 h-3 w-3" aria-hidden /> read-only access</Badge>
      </div>

      {cases.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-sm text-ink-500">
          No cases have been shared with you.
          <p className="mt-1 text-xs text-ink-400">A firm administrator can share a case by granting you a case-scoped role assignment.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {cases.map((c) => {
            const caseReleases = releasesByCase.get(c.id) ?? [];
            const accessRole = roleByCase.get(c.id);
            return (
              <section key={c.id} className="card p-5" aria-label={`Shared case ${c.caseNumber}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h2 className="truncate text-base font-semibold text-ink-900">{c.clientName}</h2>
                    <span className="font-mono text-xs text-ink-400">{c.caseNumber}</span>
                    <Badge tone="neutral">{c.status.toLowerCase().replace(/_/g, " ")}</Badge>
                    {accessRole && <Badge tone="info">{TEMPLATE_LABEL[accessRole] ?? accessRole.toLowerCase()}</Badge>}
                  </div>
                  <span className="text-xs text-ink-500">Updated {formatDate(c.updatedAt)}</span>
                </div>

                <h3 className="text-label mt-4">Released Deliverables</h3>
                {caseReleases.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-500">No deliverables have been released on this matter yet.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-ink-100">
                    {caseReleases.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-ink-800">{deliverableLabel(r.reportType, r.format)}</span>
                          <span className="ml-2 text-xs text-ink-500">
                            v{r.version} · {r.format.toLowerCase()} · {formatDate(r.createdAt)}
                            {r.lifecycle === "supporting" ? " · supporting document" : ""}
                          </span>
                        </span>
                        <span className="shrink-0">
                          {canDownload && r.storageKey ? (
                            <a
                              href={`/api/cases/${r.caseId}/export/${r.id}/download`}
                              className="focusable inline-flex items-center gap-1 rounded text-xs font-medium text-brand-700 hover:underline"
                            >
                              <FileDown className="h-3.5 w-3.5" aria-hidden /> Download
                            </a>
                          ) : (
                            <Badge tone="success">Released</Badge>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-ink-500">
        Access to this page and every download is authorized and audited server-side. Contact the firm if a deliverable you expect is not listed.
      </p>
    </div>
  );
}
