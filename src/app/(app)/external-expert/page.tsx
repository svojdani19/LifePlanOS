import { redirect } from "next/navigation";
import { BriefcaseBusiness, FileDown, ShieldCheck } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { isPlatformAdminAssignment } from "@/lib/authz/caseScope";
import { can } from "@/lib/rbac";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

// ─────────────────────────────────────────────────────────────────────────────
// External Expert workspace — case-scoped access for outside experts engaged
// on specific matters. Visibility = cases where this user holds a case-scoped
// ACTIVE EXTERNAL_EXPERT assignment, or is a named assignee on an engagement.
// Shows the engagement scope, the expert's own credential status, and released
// deliverables. No firm-wide browsing, no drafts, no clinical edit controls —
// the expert does scoped work inside the case tools they are granted, not here.
// ─────────────────────────────────────────────────────────────────────────────

const ENGAGEMENT_TONE: Record<string, "success" | "info" | "warning" | "neutral"> = {
  IN_PROGRESS: "info",
  QA_REVIEW: "warning",
  DELIVERED: "success",
  COMPLETED: "success",
};

const CREDENTIAL_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ORG_VERIFIED: "success",
  EXTERNALLY_VERIFIED: "success",
  SELF_REPORTED: "warning",
  PENDING: "warning",
  EXPIRED: "danger",
  SUSPENDED: "danger",
};

export default async function ExternalExpertPage() {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;
  const now = new Date();

  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId: ctx.user.id,
      firmId,
      status: "ACTIVE",
      builtInRole: "EXTERNAL_EXPERT",
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }],
    },
    select: { caseId: true, responsibility: true },
  });

  // Engagements naming this user as an assigned expert also grant visibility.
  const assignedEngagements = await prisma.caseEngagement.findMany({
    where: {
      firmId,
      status: { notIn: ["CANCELLED"] },
      OR: [
        { assignedVocationalExpertId: ctx.user.id },
        { assignedEconomistId: ctx.user.id },
        { assignedPhysicianId: ctx.user.id },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      caseId: true,
      reportType: true,
      status: true,
      scope: true,
      estimatedCompletionDate: true,
    },
  });

  // Server-side workspace guard (deny → dashboard). A platform-admin
  // assignment may VIEW the page (read-only; it renders only their own —
  // typically empty — engagement list, never firm-wide data).
  if (assignments.length === 0 && assignedEngagements.length === 0 && !(await isPlatformAdminAssignment(ctx.user.id))) {
    redirect("/dashboard");
  }

  const engagedCaseIds = Array.from(
    new Set([
      ...assignments.map((a) => a.caseId).filter((id): id is string => !!id),
      ...assignedEngagements.map((e) => e.caseId),
    ]),
  );

  const canDownload = can(ctx.user.role, "report.export");

  const [cases, releases, credentials] = await Promise.all([
    engagedCaseIds.length
      ? prisma.case.findMany({
          where: { id: { in: engagedCaseIds }, firmId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, clientName: true, caseNumber: true, status: true, updatedAt: true },
        })
      : Promise.resolve([]),
    engagedCaseIds.length
      ? prisma.reportExport.findMany({
          where: {
            firmId,
            caseId: { in: engagedCaseIds },
            draft: false,
            supersededById: null,
            OR: [{ lifecycle: { in: ["final_expert", "supporting"] } }, { lifecycle: null, reportType: null }],
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, caseId: true, reportType: true, format: true, version: true, createdAt: true, storageKey: true },
        })
      : Promise.resolve([]),
    prisma.userCredential.findMany({
      where: { userId: ctx.user.id, firmId },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, label: true, category: true, status: true, expiresAt: true },
    }),
  ]);

  const engagementsByCase = new Map<string, typeof assignedEngagements>();
  for (const e of assignedEngagements) {
    const list = engagementsByCase.get(e.caseId) ?? [];
    list.push(e);
    engagementsByCase.set(e.caseId, list);
  }
  const releasesByCase = new Map<string, typeof releases>();
  for (const r of releases) {
    const list = releasesByCase.get(r.caseId) ?? [];
    list.push(r);
    releasesByCase.set(r.caseId, list);
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{ctx.firm.name}</p>
          <h1 className="h-page mt-1">Expert Engagements</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-600">
            The matters you are engaged on, your assignment scope, and released work product. Access is limited to
            specifically engaged cases.
          </p>
        </div>
        <Badge tone="neutral" className="mb-1">
          <BriefcaseBusiness className="mr-1 h-3 w-3" aria-hidden /> case-scoped access
        </Badge>
      </div>

      {/* Credential status — attestation gating depends on verification. */}
      <section className="card mt-6 p-5" aria-label="Credential status">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-brand-700" aria-hidden />
          <h2 className="text-base font-semibold text-ink-900">Your Credentials</h2>
        </div>
        {credentials.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">
            No credentials on file. Upload credentials from your account page — expert attestations require a verified
            credential.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {credentials.map((cr) => (
              <li key={cr.id} className="flex items-center gap-2 rounded-lg border border-ink-100 px-3 py-1.5 text-sm">
                <span className="font-medium text-ink-800">{cr.label ?? cr.type.replace(/_/g, " ")}</span>
                {cr.category && <span className="text-xs text-ink-400">{cr.category.toLowerCase()}</span>}
                <Badge tone={CREDENTIAL_TONE[cr.status] ?? "neutral"}>{cr.status.toLowerCase().replace(/_/g, " ")}</Badge>
                {cr.expiresAt && <span className="text-xs text-ink-400">expires {formatDate(cr.expiresAt)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {cases.length === 0 ? (
        <div className="card mt-4 p-8 text-center text-sm text-ink-500">
          No engagements are active for you right now.
          <p className="mt-1 text-xs text-ink-400">You will see matters here once the firm engages you on a case.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {cases.map((c) => {
            const caseEngs = engagementsByCase.get(c.id) ?? [];
            const caseReleases = releasesByCase.get(c.id) ?? [];
            return (
              <section key={c.id} className="card p-5" aria-label={`Engaged case ${c.caseNumber}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h2 className="truncate text-base font-semibold text-ink-900">{c.clientName}</h2>
                    <span className="font-mono text-xs text-ink-400">{c.caseNumber}</span>
                    <Badge tone="neutral">{c.status.toLowerCase().replace(/_/g, " ")}</Badge>
                  </div>
                  <span className="text-xs text-ink-500">Updated {formatDate(c.updatedAt)}</span>
                </div>

                {caseEngs.length > 0 && (
                  <>
                    <h3 className="text-label mt-4">Your Assignments</h3>
                    <ul className="mt-2 divide-y divide-ink-100">
                      {caseEngs.map((e) => (
                        <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                          <span className="min-w-0">
                            <span className="font-medium text-ink-800">{e.reportType.replace(/_/g, " ").toLowerCase()}</span>
                            {e.scope && <span className="ml-2 text-xs text-ink-500">{e.scope}</span>}
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-ink-500">
                            {e.estimatedCompletionDate && <span>due {formatDate(e.estimatedCompletionDate)}</span>}
                            <Badge tone={ENGAGEMENT_TONE[e.status] ?? "neutral"}>
                              {e.status.toLowerCase().replace(/_/g, " ")}
                            </Badge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <h3 className="text-label mt-4">Released Deliverables</h3>
                {caseReleases.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-500">No deliverables have been released on this matter yet.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-ink-100">
                    {caseReleases.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-ink-800">
                            {(r.reportType ?? "LIFE_CARE_PLAN").replace(/_/g, " ").toLowerCase()}
                          </span>
                          <span className="ml-2 text-xs text-ink-500">
                            v{r.version} · {r.format.toLowerCase()} · {formatDate(r.createdAt)}
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
        Access is engagement-scoped and audited. Scoped work product is prepared inside the case tools you are granted;
        attestations require a verified credential.
      </p>
    </div>
  );
}
