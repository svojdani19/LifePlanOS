import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhysicianWorkspace } from "@/components/review/PhysicianWorkspace";
import { orderReviewQueue, weakestDimensions, sufficiencySummary, type ReviewQueueItem } from "@/lib/engine/reviewQueue";
import { firmLearningProfile } from "@/lib/engine/learningService";
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
      learnedInsight: (it.learnedInsight as { kind: string; message: string; sampleSize: number } | null) ?? null,
    };
  });

  // Cross-case learning: how the engine's probability classes have fared under
  // this firm's OWN review history — so reviewers can see where it runs hot.
  const learning = await firmLearningProfile(ctx.firm.id).catch(() => null);
  const calibration = (learning?.calibration ?? []).filter((c) => c.samples >= 3);
  const correctedServices = (learning?.services ?? []).filter((s) => s.samples >= 3 && (s.rejected > 0 || s.frequencyDirection)).length;

  return (
    <div>
      <PageHeader
        title="Physician Review"
        subtitle={`${queue.length} recommendation${queue.length === 1 ? "" : "s"} awaiting review across ${caseIds.length} case${caseIds.length === 1 ? "" : "s"} — weakest first`}
      />
      {learning && (calibration.length > 0 || correctedServices > 0) && (
        <div className="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm text-ink-700">
          <span className="text-label">Engine calibration — your firm&apos;s review history</span>
          {calibration.map((c) => (
            <span key={c.probability}>
              <span className="font-medium">{c.probability.toLowerCase()}</span>: {c.approvedOrModified}/{c.samples} survived review
            </span>
          ))}
          {correctedServices > 0 && (
            <span className="text-xs text-ink-500">
              {correctedServices} service{correctedServices === 1 ? "" : "s"} with a consistent correction pattern — matching new proposals carry a “firm history” flag below.
            </span>
          )}
        </div>
      )}
      <PhysicianWorkspace queue={orderReviewQueue(queue)} />
    </div>
  );
}
