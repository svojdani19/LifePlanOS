import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhysicianWorkspace } from "@/components/review/PhysicianWorkspace";
import { AdminReviewOverview, type AdminReviewGroup } from "@/components/review/AdminReviewOverview";
import { orderReviewQueue, weakestDimensions, sufficiencySummary, type ReviewQueueItem } from "@/lib/engine/reviewQueue";
import type { ConfidenceVector, EvidenceSufficiency } from "@/lib/engine/clinicalReasoning";

// ─────────────────────────────────────────────────────────────────────────────
// Physician Workspace (EPIC-005). The cross-case review queue: every
// recommendation awaiting physician review, ranked by what blocks export —
// blocking findings, then structurally invalid assessments, then gated ones,
// then dollars at stake — with each item's weakest confidence dimensions and
// sufficiency verdict surfaced so review starts at the weakest point.
// ─────────────────────────────────────────────────────────────────────────────

export default async function ReviewPage() {
  const ctx = await requireContext();

  // Firm administrators get an oversight view: firm-wide needs organized by
  // case, filterable by client or attorney, with no pricing, frequency,
  // codes, clinical criteria, or review controls.
  if (ctx.user.role === "ADMIN") {
    const pending = await prisma.futureCareItem.findMany({
      where: { supersededAt: null, physicianStatus: "PENDING", case: { firmId: ctx.firm.id, status: { notIn: ["CLOSED", "ARCHIVED"] } } },
      orderBy: { service: "asc" },
      select: {
        id: true,
        caseId: true,
        service: true,
        category: true,
        specialty: true,
        probability: true,
        defenseVulnerability: true,
        physicianStatus: true,
        case: { select: { clientName: true, caseNumber: true } },
      },
    });
    const caseIds = [...new Set(pending.map((i) => i.caseId))];
    const grants = caseIds.length
      ? await prisma.userRoleAssignment.findMany({
          where: { firmId: ctx.firm.id, caseId: { in: caseIds }, status: "ACTIVE", builtInRole: "ATTORNEY_CLIENT" },
          select: { caseId: true, userId: true },
        })
      : [];
    const attorneyUsers = grants.length
      ? await prisma.user.findMany({ where: { id: { in: grants.map((g) => g.userId) } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(attorneyUsers.map((u) => [u.id, u.name]));
    const attorneysByCase = new Map<string, string[]>();
    for (const g of grants) {
      if (!g.caseId) continue;
      const name = nameById.get(g.userId);
      if (!name) continue;
      attorneysByCase.set(g.caseId, [...new Set([...(attorneysByCase.get(g.caseId) ?? []), name])]);
    }
    const groupMap = new Map<string, AdminReviewGroup>();
    for (const it of pending) {
      const g = groupMap.get(it.caseId) ?? {
        caseId: it.caseId,
        clientName: it.case.clientName,
        caseNumber: it.case.caseNumber,
        attorneys: attorneysByCase.get(it.caseId) ?? [],
        items: [],
      };
      g.items.push({
        id: it.id,
        service: it.service,
        category: it.category,
        specialty: it.specialty,
        probability: it.probability,
        defenseVulnerability: it.defenseVulnerability,
        physicianStatus: it.physicianStatus,
      });
      groupMap.set(it.caseId, g);
    }
    const groups = [...groupMap.values()].sort((x, y) => x.clientName.localeCompare(y.clientName));
    return (
      <div>
        <PageHeader
          title="Physician Review"
          subtitle={`Firm-wide needs awaiting physician review — ${pending.length} item${pending.length === 1 ? "" : "s"} across ${groups.length} case${groups.length === 1 ? "" : "s"}`}
        />
        <div className="mt-5">
          <AdminReviewOverview groups={groups} />
        </div>
      </div>
    );
  }

  const canReview = ROLE_PERMISSIONS[ctx.user.role].includes("physician.review");
  if (!canReview) {
    return (
      <div>
        <PageHeader title="Physician Review" subtitle="Cross-case review queue" />
        <div className="card p-6 text-sm text-ink-600">Your role does not carry physician-review permission.</div>
      </div>
    );
  }

  const items = await prisma.futureCareItem.findMany({
    where: { supersededAt: null, physicianStatus: "PENDING", case: { firmId: ctx.firm.id, status: { notIn: ["CLOSED", "ARCHIVED"] } } },
    include: { case: { select: { id: true, clientName: true, caseNumber: true } } },
    orderBy: { presentValue: "desc" },
  });
  const caseIds = [...new Set(items.map((i) => i.caseId))];
  const [assessments, blockingFindings] = await Promise.all([
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

  return (
    <div>
      <PageHeader
        title="Physician Review"
        subtitle={`${queue.length} recommendation${queue.length === 1 ? "" : "s"} awaiting review across ${caseIds.length} case${caseIds.length === 1 ? "" : "s"} — weakest first`}
      />
      <PhysicianWorkspace queue={orderReviewQueue(queue)} />
    </div>
  );
}
