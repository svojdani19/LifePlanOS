import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import AttorneyWorkspace from "@/components/attorney/AttorneyWorkspace";

// Attorney workspace (MDIP — docs/28). Read-only surface for the retaining
// attorney: damages-evaluation posture, evidence gaps, report options with
// firm pricing, engagement status, and released final deliverables. The server
// guard admits the legacy roles that legitimately see this view (ADMIN and
// ATTORNEY_REVIEWER); everyone else lands back on the dashboard.

export default async function AttorneyPage() {
  const ctx = await requireContext();
  if (ctx.user.role !== "ADMIN" && ctx.user.role !== "ATTORNEY_REVIEWER") redirect("/dashboard");

  const cases = await prisma.case.findMany({
    where: { firmId: ctx.firm.id, status: { notIn: ["ARCHIVED"] } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      clientName: true,
      caseNumber: true,
      status: true,
      dateOfInjury: true,
      updatedAt: true,
      _count: { select: { documents: true, chronologyEvents: true } },
    },
  });

  // Per-firm pricing placeholders: Firm.features["pricing.<REPORT_TYPE>"].
  const features = (ctx.firm.features ?? {}) as Record<string, unknown>;
  const pricing: Record<string, string> = {};
  for (const [key, value] of Object.entries(features)) {
    if (key.startsWith("pricing.") && typeof value === "string") pricing[key.slice("pricing.".length)] = value;
  }

  return (
    <AttorneyWorkspace
      firmName={ctx.firm.name}
      userName={ctx.user.name}
      pricing={pricing}
      cases={cases.map((c) => ({
        id: c.id,
        clientName: c.clientName,
        caseNumber: c.caseNumber,
        status: c.status,
        dateOfInjury: c.dateOfInjury ? c.dateOfInjury.toISOString() : null,
        updatedAt: c.updatedAt.toISOString(),
        documentCount: c._count.documents,
        chronologyCount: c._count.chronologyEvents,
      }))}
    />
  );
}
