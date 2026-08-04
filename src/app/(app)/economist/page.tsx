import Link from "next/link";
import { redirect } from "next/navigation";
import { canCanonicalPermission, requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { accessibleCaseIds, rolesWithPermission, templatesWithPermission } from "@/lib/authz/caseScope";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import EconomistWorkspace from "@/components/case/EconomistWorkspace";
import { economistReadiness, type StoredEconResult, type ScenarioRow } from "@/lib/reports/economist";

// ─────────────────────────────────────────────────────────────────────────────
// Forensic Economist Workspace (MDIP docs/28). Cross-case surface for the
// economic service line: a queue of every case carrying explicitly entered
// assumptions (plus cases where an engagement assigns this economist), each
// with its readiness ladder, and the existing per-case EconomistWorkspace
// mounted for the selected case. Guard (case-scoped, assignment-based —
// docs/28 MDIP hardening): an ACTIVE FORENSIC_ECONOMIST (or other
// economic.view-holding template) assignment — case-scoped holders see ONLY
// their granted/engaged cases — or a legacy role whose template holds
// economic.view (ADMIN). The legacy PHYSICIAN_REVIEWER fallback is gone: a
// reviewer seat confers no economist authority. Platform-admin assignments
// may view read-only. No assumption is ever silently chosen.
// ─────────────────────────────────────────────────────────────────────────────

const READINESS_TONE: Record<string, BadgeTone> = {
  "Intake incomplete": "neutral",
  "Expert input required": "warning",
  "Draft support package available": "info",
  "Expert review required": "warning",
  "Ready for final export": "success",
};

export default async function EconomistWorkspacePage({ searchParams: searchParamsPromise }: { searchParams?: Promise<{ caseId?: string }> }) {
  const searchParams = await searchParamsPromise;
  const ctx = await requireContext();
  const access = await accessibleCaseIds(ctx, {
    firmWideRoles: rolesWithPermission("economic.view"),
    assignmentTemplates: templatesWithPermission("economic.view"),
    orgWideAssignmentGrantsAll: false,
    engagementSlots: ["assignedEconomistId"],
  });
  if (!access.allowed) redirect("/dashboard");
  // null = firm-wide; otherwise the explicit accessible case-id list.
  const scoped = access.cases === "all" ? null : access.cases;

  // ── Queue: cases with entered assumptions, plus engagement-assigned cases ──
  const [assumptionGroups, engagements] = await Promise.all([
    prisma.economicAssumption.groupBy({
      by: ["caseId"],
      where: { firmId: ctx.firm.id, supersededById: null, ...(scoped ? { caseId: { in: scoped } } : {}) },
      _count: true,
    }),
    prisma.caseEngagement.findMany({
      where: { firmId: ctx.firm.id, assignedEconomistId: ctx.user.id, status: { notIn: ["CANCELLED"] } },
      select: { caseId: true },
    }),
  ]);
  const assumptionCountByCase = new Map(assumptionGroups.map((g) => [g.caseId, g._count]));
  const queueCaseIds = [...new Set([...assumptionGroups.map((g) => g.caseId), ...engagements.map((e) => e.caseId)])];

  const [queueCases, assumptions, scenarios, allCases] = await Promise.all([
    queueCaseIds.length
      ? prisma.case.findMany({
          where: { id: { in: queueCaseIds }, firmId: ctx.firm.id, status: { notIn: ["ARCHIVED"] } },
          orderBy: { updatedAt: "desc" },
          select: { id: true, clientName: true, caseNumber: true, status: true },
        })
      : Promise.resolve([]),
    queueCaseIds.length
      ? prisma.economicAssumption.findMany({
          where: { firmId: ctx.firm.id, caseId: { in: queueCaseIds }, supersededById: null },
          select: { caseId: true, key: true, value: true, unit: true },
        })
      : Promise.resolve([]),
    queueCaseIds.length
      ? prisma.economicScenario.findMany({
          where: { firmId: ctx.firm.id, caseId: { in: queueCaseIds } },
          select: { caseId: true, name: true, result: true, computedAt: true },
        })
      : Promise.resolve([]),
    // Picker: open cases within the caller's access scope.
    prisma.case.findMany({
      where: { firmId: ctx.firm.id, status: { notIn: ["CLOSED", "ARCHIVED"] }, ...(scoped ? { id: { in: scoped } } : {}) },
      orderBy: { updatedAt: "desc" },
      select: { id: true, clientName: true, caseNumber: true },
    }),
  ]);

  // Pre-approval readiness — the same call the economics API makes for its
  // banner (report-level economist approval is layered on by the report
  // workflow, not here, so conclusion/approval rungs are conservatively false).
  const readinessByCase = new Map(
    queueCases.map((c) => [
      c.id,
      economistReadiness(
        assumptions.filter((a) => a.caseId === c.id),
        scenarios
          .filter((s) => s.caseId === c.id)
          .map((s): ScenarioRow => ({ name: s.name, result: s.result as StoredEconResult | null, computedAt: s.computedAt })),
        false,
        false,
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

  // Mirror the economics API's canonical permission and credential checks.
  // A platform-admin view is strictly read-only — no mutation surfaces render.
  const canEdit = Boolean(
    !access.platformAdminReadOnly &&
      selectedId &&
      canCanonicalPermission(ctx, "economic.edit", { caseId: selectedId }),
  );

  // Identity for the hero — the signed-in economist's actual name with their
  // working title from the FORENSIC_ECONOMIST assignment (same identity
  // resolution as the other expert workspaces); nothing is hardcoded.
  const titleGrant = await prisma.userRoleAssignment.findFirst({
    where: { firmId: ctx.firm.id, userId: ctx.user.id, status: "ACTIVE", builtInRole: "FORENSIC_ECONOMIST", responsibility: { not: null } },
    select: { responsibility: true },
  });
  const rawTitle = titleGrant?.responsibility ?? null;
  const expertTitle = rawTitle && !/^[A-Z_ ]+$/.test(rawTitle) ? rawTitle : "Forensic Economist";

  return (
    <div>
      <PageHeader
        title={ctx.user.name}
        subtitle={`${expertTitle} — ${queueCases.length} case${queueCases.length === 1 ? "" : "s"} with entered assumptions · every value is explicitly sourced, nothing is defaulted`}
      />

      <div className="mt-5 grid gap-6 lg:grid-cols-3">
        {/* ── Queue: readiness per case ──────────────────────────────────────── */}
        <div className="lg:col-span-1">
          <div className="card overflow-hidden">
            <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-500">Economist Queue</div>
            {queueCases.length === 0 ? (
              <div className="p-4 text-sm text-ink-500">No case carries economic assumptions yet, and no engagement assigns you. Pick a case below to begin.</div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {queueCases.map((c) => {
                  const r = readinessByCase.get(c.id);
                  return (
                    <li key={c.id} className={c.id === selectedId ? "bg-brand-50/60" : undefined}>
                      <Link href={`/economist?caseId=${c.id}`} className="block px-4 py-3 hover:bg-ink-50">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-ink-800">{c.clientName}</span>
                          <span className="font-mono text-xs text-ink-400">{c.caseNumber}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {r && <Badge tone={READINESS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>}
                          <span className="text-xs text-ink-500">
                            {assumptionCountByCase.get(c.id) ?? 0} assumptions{r && r.missing.length > 0 ? ` · ${r.missing.length} required missing` : ""}
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Case picker — any open firm case (native GET form, no client JS). */}
          <form method="GET" action="/economist" className="card mt-4 p-4">
            <label htmlFor="econ-case-picker" className="text-xs font-medium uppercase tracking-wide text-ink-500">Open another case</label>
            <div className="mt-2 flex gap-2">
              <select id="econ-case-picker" name="caseId" defaultValue={selectedId ?? ""} className="input flex-1 text-sm">
                {allCases.length === 0 && <option value="">No open cases</option>}
                {allCases.map((c) => (
                  <option key={c.id} value={c.id}>{c.clientName} — {c.caseNumber}</option>
                ))}
              </select>
              <button type="submit" className="btn-primary">Open</button>
            </div>
          </form>
        </div>

        {/* ── Selected case: the existing per-case economist workspace ───────── */}
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
              <EconomistWorkspace caseId={selectedCase.id} canEdit={canEdit} />
            </div>
          ) : (
            <div className="card p-6 text-sm text-ink-500">Select a case from the queue or the picker to open its economist workspace.</div>
          )}
        </div>
      </div>
    </div>
  );
}
