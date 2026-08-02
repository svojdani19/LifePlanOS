import { redirect } from "next/navigation";
import { FileDown, Scale } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { isPlatformAdminAssignment } from "@/lib/authz/caseScope";
import { can } from "@/lib/rbac";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

// ─────────────────────────────────────────────────────────────────────────────
// Insurance Client workspace — read-only damages posture for specifically
// engaged matters. Visibility = cases where this user holds a case-scoped
// ACTIVE INSURANCE_CLIENT assignment. Shows the latest future-damages
// evaluation outcome (deterministic engine output — never a case valuation),
// material uncertainty, and released deliverables only. No drafts, no internal
// findings, no clinical detail, no edit controls.
// ─────────────────────────────────────────────────────────────────────────────

const OUTCOME_LABEL: Record<string, string> = {
  NO_REPORT_INDICATED: "No expert report indicated",
  ADDITIONAL_INFO_REQUIRED: "Additional information required",
  MCP_RECOMMENDED: "Medical cost projection recommended",
  LCP_RECOMMENDED: "Life care plan recommended",
  LCP_PLUS_VOCATIONAL: "Life care plan + vocational recommended",
  LCP_PLUS_VOC_ECON: "Life care plan + vocational + economic recommended",
  EXPERT_CONSULTATION: "Expert consultation recommended",
};

const OUTCOME_TONE: Record<string, "success" | "info" | "warning" | "neutral"> = {
  NO_REPORT_INDICATED: "neutral",
  ADDITIONAL_INFO_REQUIRED: "warning",
  MCP_RECOMMENDED: "info",
  LCP_RECOMMENDED: "info",
  LCP_PLUS_VOCATIONAL: "info",
  LCP_PLUS_VOC_ECON: "info",
  EXPERT_CONSULTATION: "warning",
};

function rangeText(range: unknown): string | null {
  if (!range || typeof range !== "object") return null;
  const r = range as { low?: unknown; high?: unknown; label?: unknown };
  if (typeof r.low !== "number" || typeof r.high !== "number") return null;
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return `${fmt(r.low)} – ${fmt(r.high)}`;
}

export default async function InsuranceClientPage() {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;
  const now = new Date();

  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId: ctx.user.id,
      firmId,
      status: "ACTIVE",
      builtInRole: "INSURANCE_CLIENT",
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }],
    },
    select: { caseId: true },
  });

  // Server-side workspace guard (deny → dashboard). A platform-admin
  // assignment may VIEW the page (read-only; it renders only their own —
  // typically empty — matter list, never firm-wide data).
  if (assignments.length === 0 && !(await isPlatformAdminAssignment(ctx.user.id))) redirect("/dashboard");

  // Visibility is deliberate and per-case: only caseId-scoped assignments count.
  const engagedCaseIds = Array.from(
    new Set(assignments.map((a) => a.caseId).filter((id): id is string => !!id)),
  );

  const canDownload = can(ctx.user.role, "report.export");

  const [cases, releases, evaluations] = engagedCaseIds.length
    ? await Promise.all([
        prisma.case.findMany({
          where: { id: { in: engagedCaseIds }, firmId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, clientName: true, caseNumber: true, status: true, updatedAt: true },
        }),
        prisma.reportExport.findMany({
          where: {
            firmId,
            caseId: { in: engagedCaseIds },
            draft: false,
            supersededById: null,
            OR: [{ lifecycle: { in: ["final_expert", "supporting"] } }, { lifecycle: null, reportType: null }],
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, caseId: true, reportType: true, format: true, version: true, createdAt: true, storageKey: true },
        }),
        prisma.futureDamagesEvaluation.findMany({
          where: { firmId, caseId: { in: engagedCaseIds } },
          orderBy: { evaluatedAt: "desc" },
          select: {
            id: true,
            caseId: true,
            overallOutcome: true,
            estimatedMedicalRange: true,
            missingInformation: true,
            evaluatedAt: true,
            isStale: true,
          },
        }),
      ])
    : [[], [], []];

  const latestEvalByCase = new Map<string, (typeof evaluations)[number]>();
  for (const ev of evaluations) {
    if (!latestEvalByCase.has(ev.caseId)) latestEvalByCase.set(ev.caseId, ev);
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
          <h1 className="h-page mt-1">Engaged Matters</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-600">
            Authorized medical-cost posture and released deliverables for the matters shared with you. Drafts and
            internal work product are never shown here.
          </p>
        </div>
        <Badge tone="neutral" className="mb-1">
          <Scale className="mr-1 h-3 w-3" aria-hidden /> case-scoped access
        </Badge>
      </div>

      {cases.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-sm text-ink-500">
          No matters have been shared with you.
          <p className="mt-1 text-xs text-ink-400">A firm administrator can share a matter by granting you case-scoped access.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {cases.map((c) => {
            const ev = latestEvalByCase.get(c.id);
            const caseReleases = releasesByCase.get(c.id) ?? [];
            const range = ev ? rangeText(ev.estimatedMedicalRange) : null;
            const missing = ev && Array.isArray(ev.missingInformation) ? (ev.missingInformation as unknown[]).length : 0;
            return (
              <section key={c.id} className="card p-5" aria-label={`Engaged matter ${c.caseNumber}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h2 className="truncate text-base font-semibold text-ink-900">{c.clientName}</h2>
                    <span className="font-mono text-xs text-ink-400">{c.caseNumber}</span>
                    <Badge tone="neutral">{c.status.toLowerCase().replace(/_/g, " ")}</Badge>
                  </div>
                  <span className="text-xs text-ink-500">Updated {formatDate(c.updatedAt)}</span>
                </div>

                <h3 className="text-label mt-4">Medical-Cost Posture</h3>
                {!ev ? (
                  <p className="mt-2 text-sm text-ink-500">A future-damages evaluation has not been run on this matter yet.</p>
                ) : (
                  <div className="mt-2 space-y-1.5 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge tone={OUTCOME_TONE[ev.overallOutcome] ?? "neutral"}>
                        {OUTCOME_LABEL[ev.overallOutcome] ?? ev.overallOutcome.toLowerCase().replace(/_/g, " ")}
                      </Badge>
                      {ev.isStale && <Badge tone="warning">may be outdated — re-evaluation pending</Badge>}
                      <span className="text-xs text-ink-500">evaluated {formatDate(ev.evaluatedAt)}</span>
                    </p>
                    {range && (
                      <p className="text-ink-800">
                        Estimated future medical cost range: <span className="font-semibold">{range}</span>
                        <span className="ml-2 text-xs text-ink-500">
                          Preliminary, physician-reviewed items only — not a case valuation.
                        </span>
                      </p>
                    )}
                    {missing > 0 && (
                      <p className="text-xs text-ink-500">
                        {missing} item{missing === 1 ? "" : "s"} of additional information would materially improve confidence.
                      </p>
                    )}
                  </div>
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
        Access to this page and every download is authorized and audited server-side. Estimates are deterministic engine
        outputs over physician-reviewed items and are not a valuation of the case.
      </p>
    </div>
  );
}
