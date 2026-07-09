import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { assumptionsFor } from "@/lib/engine/generate";
import { CaseWorkspace } from "@/components/case/CaseWorkspace";

export default async function CaseDetailPage({ params }: { params: { caseId: string } }) {
  const ctx = await requireContext();
  const c = await prisma.case.findFirst({
    where: { id: params.caseId, firmId: ctx.firm.id },
    include: {
      createdBy: { select: { name: true } },
      documents: { orderBy: { createdAt: "desc" } },
      chronologyEvents: { orderBy: { eventDate: "asc" } },
      conditions: { orderBy: { confidence: "desc" } },
      futureCareItems: { orderBy: { presentValue: "desc" } },
      reviewFindings: { orderBy: { createdAt: "asc" } },
      reports: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!c) notFound();

  const assumptions = assumptionsFor(c);
  const totalLifetime = c.futureCareItems.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = c.futureCareItems.reduce((s, i) => s + i.presentValue, 0);

  return (
    <div>
      <Link href="/cases" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> All Cases
      </Link>
      <CaseWorkspace
        data={JSON.parse(JSON.stringify(c))}
        assumptions={assumptions}
        totals={{ totalLifetime, totalPresentValue }}
        permissions={ROLE_PERMISSIONS[ctx.user.role]}
      />
    </div>
  );
}
