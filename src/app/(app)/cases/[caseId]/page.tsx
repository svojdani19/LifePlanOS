import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { assumptionsFor } from "@/lib/engine/generate";
import { rankPrecedents } from "@/lib/precedents/match";
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
      futureCareItems: { where: { supersededAt: null }, orderBy: { presentValue: "desc" } },
      assumptionChanges: { orderBy: { createdAt: "desc" }, take: 20 },
      reviewFindings: { orderBy: { createdAt: "asc" } },
      reports: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!c) notFound();

  const assumptions = assumptionsFor(c);
  const totalLifetime = c.futureCareItems.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = c.futureCareItems.reduce((s, i) => s + i.presentValue, 0);

  // Rank the firm's precedent library against this case by "likeness".
  const precedents = await prisma.precedentPlan.findMany({ where: { firmId: ctx.firm.id } });
  const age = c.dateOfBirth ? Math.floor((Date.now() - c.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000)) : null;
  const caseFeatures = {
    injurySpecialty: c.injurySpecialty,
    icd10Code: c.icd10Code,
    diagnosis: c.diagnosis,
    jurisdiction: c.jurisdiction,
    mechanism: c.mechanism,
    age,
    careCategories: [...new Set(c.futureCareItems.map((i) => i.category as string))],
    presentValue: totalPresentValue || null,
  };
  const ranked = rankPrecedents(caseFeatures, precedents.map((p) => ({ ...p, careCategories: (Array.isArray(p.careCategories) ? p.careCategories : []) as string[] })));

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
        precedents={JSON.parse(JSON.stringify(ranked))}
      />
    </div>
  );
}
