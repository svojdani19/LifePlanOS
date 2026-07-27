import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhysicianWorkspace } from "@/components/review/PhysicianWorkspace";
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
