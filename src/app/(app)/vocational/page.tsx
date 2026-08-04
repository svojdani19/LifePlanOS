import Link from "next/link";
import { redirect } from "next/navigation";
import { canCanonicalPermission, requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { accessibleCaseIds, rolesWithPermission, templatesWithPermission } from "@/lib/authz/caseScope";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import VocationalWorkspace from "@/components/case/VocationalWorkspace";
import { vocationalReadiness, type VocEntry } from "@/lib/reports/vocational";

// ─────────────────────────────────────────────────────────────────────────────
// Vocational Expert Workspace (MDIP docs/28). Cross-case surface for the
// vocational service line: a queue of every case carrying vocational intake
// (plus cases where an engagement assigns this expert), each with its live
// readiness ladder, and the existing per-case VocationalWorkspace mounted for
// the selected case. Guard (case-scoped, assignment-based — docs/28 MDIP
// hardening): an ACTIVE VOCATIONAL_EXPERT (or other vocational.view-holding
// template) assignment — case-scoped holders see ONLY their granted/engaged
// cases — or a legacy role whose template holds vocational.view (ADMIN,
// PLANNER). The legacy PHYSICIAN_REVIEWER fallback is gone: a reviewer seat
// confers no vocational authority. Platform-admin assignments may view
// read-only.
// ─────────────────────────────────────────────────────────────────────────────

const READINESS_TONE: Record<string, BadgeTone> = {
  "Intake incomplete": "neutral",
  "Expert input required": "warning",
  "Draft support package available": "info",
  "Expert review required": "warning",
  "Ready for final export": "success",
};

export default async function VocationalWorkspacePage({ searchParams: searchParamsPromise }: { searchParams?: Promise<{ caseId?: string }> }) {
  const searchParams = await searchParamsPromise;
  const ctx = await requireContext();
  const access = await accessibleCaseIds(ctx, {
    firmWideRoles: rolesWithPermission("vocational.view"),
    assignmentTemplates: templatesWithPermission("vocational.view"),
    orgWideAssignmentGrantsAll: false,
    engagementSlots: ["assignedVocationalExpertId"],
  });
  if (!access.allowed) redirect("/dashboard");
  // null = firm-wide; otherwise the explicit accessible case-id list.
  const scoped = access.cases === "all" ? null : access.cases;

  // ── Queue: cases with vocational intake, plus engagement-assigned cases ────
  const [entryGroups, engagements] = await Promise.all([
    prisma.vocationalEntry.groupBy({
      by: ["caseId"],
      where: { firmId: ctx.firm.id, supersededById: null, ...(scoped ? { caseId: { in: scoped } } : {}) },
      _count: true,
    }),
    prisma.caseEngagement.findMany({
      where: { firmId: ctx.firm.id, assignedVocationalExpertId: ctx.user.id, status: { notIn: ["CANCELLED"] } },
      select: { caseId: true },
    }),
  ]);
  const entryCountByCase = new Map(entryGroups.map((g) => [g.caseId, g._count]));
  const queueCaseIds = [...new Set([...entryGroups.map((g) => g.caseId), ...engagements.map((e) => e.caseId)])];

  const [queueCases, entries, approvals, allCases] = await Promise.all([
    queueCaseIds.length
      ? prisma.case.findMany({
          where: { id: { in: queueCaseIds }, firmId: ctx.firm.id, status: { notIn: ["ARCHIVED"] } },
          orderBy: { updatedAt: "desc" },
          select: { id: true, clientName: true, caseNumber: true, status: true },
        })
      : Promise.resolve([]),
    queueCaseIds.length
      ? prisma.vocationalEntry.findMany({
          where: { firmId: ctx.firm.id, caseId: { in: queueCaseIds }, supersededById: null },
          select: { caseId: true, kind: true, verification: true, startDate: true, endDate: true },
        })
      : Promise.resolve([]),
    // Report-level vocational approval drives the top rung of the ladder.
    queueCaseIds.length
      ? prisma.reportApproval.findMany({
          where: { firmId: ctx.firm.id, caseId: { in: queueCaseIds }, expertRole: "vocational", status: "ACTIVE" },
          select: { caseId: true },
        })
      : Promise.resolve([]),
    // Picker: open cases within the caller's access scope.
    prisma.case.findMany({
      where: { firmId: ctx.firm.id, status: { notIn: ["CLOSED", "ARCHIVED"] }, ...(scoped ? { id: { in: scoped } } : {}) },
      orderBy: { updatedAt: "desc" },
      select: { id: true, clientName: true, caseNumber: true },
    }),
  ]);

  const approvedCases = new Set(approvals.map((a) => a.caseId));
  const readinessByCase = new Map(
    queueCases.map((c) => [
      c.id,
      vocationalReadiness(
        entries.filter((e) => e.caseId === c.id) as unknown as VocEntry[],
        { approved: approvedCases.has(c.id) },
      ),
    ]),
  );

  // ── Selection: ?caseId= (validated against the firm) → first queue case ────
  const requested = searchParams?.caseId;
  const validIds = new Set([...queueCases.map((c) => c.id), ...allCases.map((c) => c.id)]);
  const selectedId = requested && validIds.has(requested) ? requested : queueCases[0]?.id ?? null;
  const selectedCase =
    (selectedId && queueCases.find((c) => c.id === selectedId)) ||
    (selectedId && allCases.find((c) => c.id === selectedId)) ||
    null;

  // Mirror the API's canonical permission model exactly. Specialist seats are
  // case-scoped, and credential gates are evaluated by the shared registry.
  // A platform-admin view is strictly read-only — no mutation surfaces render.
  const readOnly = access.platformAdminReadOnly;
  const canEdit = Boolean(
    !readOnly &&
      selectedId &&
      canCanonicalPermission(ctx, "vocational.edit", { caseId: selectedId }),
  );
  const canReview = Boolean(
    !readOnly &&
      selectedId &&
      canCanonicalPermission(ctx, "vocational.attest", { caseId: selectedId }),
  );

  // Identity for the hero — the signed-in expert's actual name with their
  // working title from the VOCATIONAL_EXPERT assignment (same identity
  // resolution as the planner/physician workspaces); nothing is hardcoded.
  const titleGrant = await prisma.userRoleAssignment.findFirst({
    where: { firmId: ctx.firm.id, userId: ctx.user.id, status: "ACTIVE", builtInRole: "VOCATIONAL_EXPERT", responsibility: { not: null } },
    select: { responsibility: true },
  });
  const rawTitle = titleGrant?.responsibility ?? null;
  const expertTitle = rawTitle && !/^[A-Z_ ]+$/.test(rawTitle) ? rawTitle : "Vocational Expert";

  return (
    <div>
      <PageHeader
        title={ctx.user.name}
        subtitle={`${expertTitle} — ${queueCases.length} case${queueCases.length === 1 ? "" : "s"} with vocational intake · every entry carries a source citation`}
      />

      {/* ── Queue: readiness per case ────────────────────────────────────────── */}
      <div className="mt-5 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <div className="card overflow-hidden">
            <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-500">Vocational Queue</div>
            {queueCases.length === 0 ? (
              <div className="p-4 text-sm text-ink-500">No case carries vocational entries yet, and no engagement assigns you. Pick a case below to begin an intake.</div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {queueCases.map((c) => {
                  const r = readinessByCase.get(c.id);
                  return (
                    <li key={c.id} className={c.id === selectedId ? "bg-brand-50/60" : undefined}>
                      <Link href={`/vocational?caseId=${c.id}`} className="block px-4 py-3 hover:bg-ink-50">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-ink-800">{c.clientName}</span>
                          <span className="font-mono text-xs text-ink-400">{c.caseNumber}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {r && <Badge tone={READINESS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>}
                          <span className="text-xs text-ink-500">{entryCountByCase.get(c.id) ?? 0} entries{r && r.missing.length > 0 ? ` · ${r.missing.length} missing` : ""}</span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Case picker — any open firm case (native GET form, no client JS). */}
          <form method="GET" action="/vocational" className="card mt-4 p-4">
            <label htmlFor="voc-case-picker" className="text-xs font-medium uppercase tracking-wide text-ink-500">Open another case</label>
            <div className="mt-2 flex gap-2">
              <select id="voc-case-picker" name="caseId" defaultValue={selectedId ?? ""} className="input flex-1 text-sm">
                {allCases.length === 0 && <option value="">No open cases</option>}
                {allCases.map((c) => (
                  <option key={c.id} value={c.id}>{c.clientName} — {c.caseNumber}</option>
                ))}
              </select>
              <button type="submit" className="btn-primary">Open</button>
            </div>
          </form>
        </div>

        {/* ── Selected case: the existing per-case vocational workspace ──────── */}
        <div className="lg:col-span-2">
          {selectedCase ? (
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink-600">
                  Working on <Link href={`/cases/${selectedCase.id}`} className="font-semibold text-brand-700 hover:underline">{selectedCase.clientName}</Link>
                  <span className="ml-2 font-mono text-xs text-ink-400">{selectedCase.caseNumber}</span>
                </div>
                <Link href={`/cases/${selectedCase.id}`} className="text-xs text-brand-700 hover:underline">Open full case</Link>
              </div>
              <VocationalWorkspace caseId={selectedCase.id} canEdit={canEdit} canReview={canReview} />
            </div>
          ) : (
            <div className="card p-6 text-sm text-ink-500">Select a case from the queue or the picker to open its vocational workspace.</div>
          )}
        </div>
      </div>
    </div>
  );
}
