import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { accessibleCaseIds, rolesWithPermission, templatesWithPermission } from "@/lib/authz/caseScope";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { PhysicianWorkspace } from "@/components/review/PhysicianWorkspace";
import { orderReviewQueue, weakestDimensions, sufficiencySummary, type ReviewQueueItem } from "@/lib/engine/reviewQueue";
import type { ConfidenceVector, EvidenceSufficiency } from "@/lib/engine/clinicalReasoning";

// ─────────────────────────────────────────────────────────────────────────────
// Physician Workspace (MDIP docs/28). The full-page physician surface: the
// cross-case review queue (same queue as /review, which remains available) plus
// the signed-in reviewer's own attestation history — report-level attestations
// (ReportApproval, kind ATTESTATION) and item-scope attestations (Attestation),
// each with its live status so a stale or invalidated signature is visible at
// a glance. Guard (case-scoped, assignment-based — docs/28 MDIP hardening):
// legacy PHYSICIAN_REVIEWER/ADMIN see the firm-wide queue; case-scoped
// PHYSICIAN_REVIEWER assignment holders see ONLY their granted/engaged cases;
// platform-admin assignments view read-only (no disposition controls).
// Anyone else is redirected to /dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const APPROVAL_TONE: Record<string, BadgeTone> = {
  ACTIVE: "success",
  STALE: "warning",
  INVALIDATED: "danger",
};

export default async function PhysicianWorkspacePage() {
  const ctx = await requireContext();
  const access = await accessibleCaseIds(ctx, {
    firmWideRoles: rolesWithPermission("physician.review"),
    assignmentTemplates: templatesWithPermission("physician.review"),
    orgWideAssignmentGrantsAll: true,
    engagementSlots: ["assignedPhysicianId"],
  });
  if (!access.allowed) redirect("/dashboard");
  // null = firm-wide; otherwise the explicit accessible case-id list.
  const scoped = access.cases === "all" ? null : access.cases;

  // ── Cross-case review queue — mirrors /review exactly (scoped to access) ───
  const items = await prisma.futureCareItem.findMany({
    where: {
      supersededAt: null,
      physicianStatus: "PENDING",
      ...(scoped ? { caseId: { in: scoped } } : {}),
      case: { firmId: ctx.firm.id, status: { notIn: ["CLOSED", "ARCHIVED"] } },
    },
    include: { case: { select: { id: true, clientName: true, caseNumber: true } } },
    orderBy: { presentValue: "desc" },
  });
  const caseIds = [...new Set(items.map((i) => i.caseId))];
  const [assessments, blockingFindings, reportAttestations, itemAttestations] = await Promise.all([
    prisma.clinicalReasoningAssessment.findMany({
      where: { firmId: ctx.firm.id, caseId: { in: caseIds }, status: { not: "SUPERSEDED" }, supersededById: null },
      orderBy: { updatedAt: "desc" },
      select: {
        recommendationId: true,
        status: true,
        medicalNecessityRationale: true,
        confidenceVector: true,
        evidenceSufficiency: true,
        unknowns: true,
      },
    }),
    prisma.validationFinding.findMany({
      where: { firmId: ctx.firm.id, caseId: { in: caseIds }, exportBlocking: true },
      select: { caseId: true, service: true, result: true },
    }),
    // Report-level attestations the signed-in reviewer has signed.
    prisma.reportApproval.findMany({
      where: { firmId: ctx.firm.id, reviewerId: ctx.user.id, kind: "ATTESTATION" },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, caseId: true, expertRole: true, status: true, invalidReason: true, createdAt: true },
    }),
    // Item-scope attestations the signed-in physician has signed.
    prisma.attestation.findMany({
      where: { firmId: ctx.firm.id, physicianId: ctx.user.id },
      orderBy: { signedAt: "desc" },
      take: 25,
      select: { id: true, caseId: true, status: true, invalidatedReason: true, itemCount: true, totalPresentValue: true, signedAt: true },
    }),
  ]);

  const byRec = new Map<string, (typeof assessments)[number]>();
  for (const a of assessments) if (!byRec.has(a.recommendationId)) byRec.set(a.recommendationId, a);

  const queue: ReviewQueueItem[] = items.map((it) => {
    const a = byRec.get(it.id) ?? null;
    return {
      itemId: it.id,
      caseId: it.caseId,
      caseNumber: it.case.caseNumber,
      clientName: it.case.clientName,
      service: it.service,
      category: it.category,
      presentValue: it.presentValue,
      probability: it.probability,
      isLifetime: it.isLifetime,
      frequencyPerYear: it.frequencyPerYear,
      durationYears: it.durationYears,
      assessmentStatus: a?.status ?? null,
      blockingFindings: blockingFindings
        .filter((f) => f.caseId === it.caseId && f.service.trim().toLowerCase() === it.service.trim().toLowerCase())
        .map((f) => f.result),
      sufficiency: sufficiencySummary((a?.evidenceSufficiency as unknown as EvidenceSufficiency) ?? null),
      weakestDimensions: weakestDimensions((a?.confidenceVector as unknown as ConfidenceVector) ?? null),
      necessityRationale: a?.medicalNecessityRationale ?? null,
      unknownCount: Array.isArray(a?.unknowns) ? (a!.unknowns as unknown[]).length : 0,
    };
  });

  // Case labels for the attestation lists (tenant-scoped lookup, names only).
  const attCaseIds = [...new Set([...reportAttestations.map((r) => r.caseId), ...itemAttestations.map((a) => a.caseId)])];
  const attCases = attCaseIds.length
    ? await prisma.case.findMany({ where: { id: { in: attCaseIds }, firmId: ctx.firm.id }, select: { id: true, clientName: true, caseNumber: true } })
    : [];
  const caseById = new Map(attCases.map((c) => [c.id, c]));
  const caseLabel = (id: string) => {
    const c = caseById.get(id);
    return c ? `${c.clientName} · ${c.caseNumber}` : "Case";
  };

  // Identity for the hero — the signed-in physician's actual name with their
  // working title from the PHYSICIAN_REVIEWER assignment (same identity
  // resolution as the planner and attorney workspaces). Raw enum-shaped
  // responsibilities fall back to the professional title; nothing is hardcoded
  // to any particular physician.
  const titleGrant = await prisma.userRoleAssignment.findFirst({
    where: { firmId: ctx.firm.id, userId: ctx.user.id, status: "ACTIVE", builtInRole: "PHYSICIAN_REVIEWER", caseId: null, responsibility: { not: null } },
    select: { responsibility: true },
  });
  const rawTitle = titleGrant?.responsibility ?? null;
  const physicianTitle = rawTitle && !/^[A-Z_ ]+$/.test(rawTitle) ? rawTitle : "Physician Reviewer";

  return (
    <div>
      <PageHeader
        title={ctx.user.name}
        subtitle={`${physicianTitle} — ${queue.length} recommendation${queue.length === 1 ? "" : "s"} awaiting review across ${caseIds.length} case${caseIds.length === 1 ? "" : "s"} — weakest first`}
      />
      {access.platformAdminReadOnly ? (
        // Platform-admin view is strictly read-only: no disposition controls.
        <div className="card mt-4 overflow-hidden">
          <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-500">
            Review Queue (read-only platform view)
          </div>
          {queue.length === 0 ? (
            <div className="p-4 text-sm text-ink-500">No recommendations are awaiting physician review.</div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {orderReviewQueue(queue).map((q) => (
                <li key={q.itemId} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-ink-800">{q.clientName}</span>
                    <span className="ml-2 font-mono text-xs text-ink-400">{q.caseNumber}</span>
                    <span className="ml-2 text-xs text-ink-500">{q.service}</span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-500">PV ${Math.round(q.presentValue).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <PhysicianWorkspace queue={orderReviewQueue(queue)} />
      )}

      {/* ── My attestations — every signature this reviewer has on record ───── */}
      <h2 className="text-label mt-8">My Attestations</h2>
      <div className="mt-2 grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <h3 className="h-section">Report Attestations</h3>
          <p className="mt-1 text-xs text-ink-500">Report-level signatures bound to the exact exported content hash.</p>
          <ul className="mt-3 space-y-2">
            {reportAttestations.length === 0 && <li className="text-sm text-ink-500">You have not signed any report-level attestations.</li>}
            {reportAttestations.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <Link href={`/cases/${r.caseId}`} className="font-medium text-brand-700 hover:underline">{caseLabel(r.caseId)}</Link>
                  <span className="ml-2 text-xs text-ink-500">{r.expertRole} · {formatDate(r.createdAt)}</span>
                </div>
                <Badge tone={APPROVAL_TONE[r.status] ?? "neutral"} title={r.invalidReason ?? undefined}>{r.status.toLowerCase()}</Badge>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-5">
          <h3 className="h-section">Item-Scope Attestations</h3>
          <p className="mt-1 text-xs text-ink-500">Recommendation-level signatures; material drift invalidates them automatically.</p>
          <ul className="mt-3 space-y-2">
            {itemAttestations.length === 0 && <li className="text-sm text-ink-500">You have not signed any item-scope attestations.</li>}
            {itemAttestations.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <Link href={`/cases/${a.caseId}`} className="font-medium text-brand-700 hover:underline">{caseLabel(a.caseId)}</Link>
                  <span className="ml-2 text-xs text-ink-500">
                    {a.itemCount} item{a.itemCount === 1 ? "" : "s"} · PV ${Math.round(a.totalPresentValue).toLocaleString()} · {formatDate(a.signedAt)}
                  </span>
                </div>
                <Badge tone={APPROVAL_TONE[a.status] ?? "neutral"} title={a.invalidatedReason ?? undefined}>{a.status.toLowerCase()}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
