import { redirect } from "next/navigation";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { can } from "@/lib/rbac";
import { REPORTS } from "@/lib/reports/registry";
import { OperationsWorkspace } from "@/components/operations/OperationsWorkspace";

// ─────────────────────────────────────────────────────────────────────────────
// Operations workspace (MDIP docs/28, Agent B). Commercial operations over the
// firm's engagements: pipeline, pricing config, derived invoices, expert
// capacity, and delivery deadlines. Separation of duties: this surface shows
// case NUMBERS only — no client names, no clinical content (BILLING_USER has
// no clinical access). Restricted server-side to ADMIN and BILLING_USER.
// ─────────────────────────────────────────────────────────────────────────────

export default async function OperationsPage() {
  const ctx = await requireContext();
  if (ctx.user.role !== "ADMIN" && ctx.user.role !== "BILLING_USER") redirect("/dashboard");

  const [engagements, users] = await Promise.all([
    prisma.caseEngagement.findMany({ where: { firmId: ctx.firm.id }, orderBy: { createdAt: "desc" } }),
    prisma.user.findMany({
      where: { firmId: ctx.firm.id, status: "ACTIVE" },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // Case numbers only — deliberately no clientName / clinical fields here.
  const caseIds = [...new Set(engagements.map((e) => e.caseId))];
  const cases = caseIds.length
    ? await prisma.case.findMany({
        where: { id: { in: caseIds }, firmId: ctx.firm.id },
        select: { id: true, caseNumber: true },
      })
    : [];
  const caseNumbers = Object.fromEntries(cases.map((c) => [c.id, c.caseNumber]));

  const features =
    typeof ctx.firm.features === "object" && ctx.firm.features !== null && !Array.isArray(ctx.firm.features)
      ? (ctx.firm.features as Record<string, unknown>)
      : {};
  const rawPricing = features["pricing"];
  const pricing =
    typeof rawPricing === "object" && rawPricing !== null && !Array.isArray(rawPricing)
      ? (rawPricing as Record<string, { fixed?: number; hourly?: number; rush?: number; turnaroundDays?: number }>)
      : {};

  return (
    <OperationsWorkspace
      engagements={engagements.map((e) => ({
        id: e.id,
        caseId: e.caseId,
        caseNumber: caseNumbers[e.caseId] ?? "—",
        reportType: e.reportType,
        status: e.status,
        feeEstimate: e.feeEstimate,
        feeStructure: e.feeStructure,
        estimatedCompletionDate: e.estimatedCompletionDate?.toISOString() ?? null,
        authorizedAt: e.authorizedAt?.toISOString() ?? null,
        completedAt: e.completedAt?.toISOString() ?? null,
        cancelledAt: e.cancelledAt?.toISOString() ?? null,
        cancellationStatus: e.cancellationStatus,
        missingRequirements: Array.isArray(e.missingRequirements) ? (e.missingRequirements as string[]) : [],
        createdAt: e.createdAt.toISOString(),
        assignedPlannerId: e.assignedPlannerId,
        assignedPhysicianId: e.assignedPhysicianId,
        assignedVocationalExpertId: e.assignedVocationalExpertId,
        assignedEconomistId: e.assignedEconomistId,
        assignedQaReviewerId: e.assignedQaReviewerId,
      }))}
      users={users}
      pricing={pricing}
      reportTypes={REPORTS.map((r) => ({ id: r.id, name: r.name }))}
      permissions={{
        authorize: can(ctx.user.role, "report.export") || can(ctx.user.role, "team.manage"),
        manage: can(ctx.user.role, "team.manage") || can(ctx.user.role, "case.edit"),
        pricing: can(ctx.user.role, "firm.settings"),
      }}
    />
  );
}
