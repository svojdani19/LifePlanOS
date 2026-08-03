import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext, requireCase, caseAccessFor } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { assumptionsFor } from "@/lib/engine/generate";
import { rankPrecedents } from "@/lib/precedents/match";
import { CaseWorkspace } from "@/components/case/CaseWorkspace";

export default async function CaseDetailPage({ params: paramsPromise, searchParams: searchParamsPromise }: { params: Promise<{ caseId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await paramsPromise;
  const searchParams = (await searchParamsPromise) ?? {};
  const ctx = await requireContext();
  // Direct URLs are guarded before any PHI-bearing relations are loaded. List
  // filtering is not authorization: the same case-scope policy protects this
  // server-rendered resource.
  await requireCase(ctx, params.caseId);
  const caseAccess = await caseAccessFor(ctx);
  const isFirmAdmin = ctx.user.role === "ADMIN";
  const attorneyPreview = isFirmAdmin && searchParams.viewAs === "attorney";
  const attorneyView = ctx.user.role === "ATTORNEY_REVIEWER" || attorneyPreview;
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
      treatingProviders: { orderBy: { createdAt: "asc" } },
      interviewFindings: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!c) notFound();

  // Absolute number of open export-blocking integrity findings — the items
  // standing between this case and ANY final report.
  const pendingResolution = await prisma.validationFinding.count({
    where: { caseId: c.id, exportBlocking: true, status: "OPEN" },
  });

  const assumptions = assumptionsFor(c);
  const totalLifetime = c.futureCareItems.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = c.futureCareItems.reduce((s, i) => s + i.presentValue, 0);

  // Rank the firm's precedent library against this case by "likeness".
  const precedents = await prisma.precedentPlan.findMany({ where: { firmId: ctx.firm.id } });
  // Medical-personnel seats eligible to be the designated preparing physician.
  const physicians = await prisma.user.findMany({
    where: { firmId: ctx.firm.id, status: "ACTIVE", role: { in: ["ADMIN", "PLANNER", "PHYSICIAN_REVIEWER"] } },
    select: { id: true, name: true, role: true, credentialSummary: true },
    orderBy: { name: "asc" },
  });
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href="/cases" className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
          <ArrowLeft className="h-4 w-4" /> All Cases
        </Link>
        {isFirmAdmin && (
          <Link
            href={`/cases/${params.caseId}${attorneyPreview ? "" : "?viewAs=attorney"}`}
            className={`focusable rounded-md border px-2.5 py-1 text-xs font-medium ${attorneyPreview ? "border-violet-300 bg-violet-50 text-violet-800" : "border-ink-200 text-ink-600 hover:bg-ink-50"}`}
          >
            {attorneyPreview ? "Attorney view — return to admin view" : "View as attorney"}
          </Link>
        )}
      </div>
      {attorneyPreview && (
        <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50/70 px-4 py-2 text-sm text-violet-900">
          Previewing this case exactly as the retaining attorney sees it — presentation only; your own permissions and identity are unchanged.
        </div>
      )}
      <CaseWorkspace
        data={JSON.parse(JSON.stringify(c))}
        assumptions={assumptions}
        totals={{ totalLifetime, totalPresentValue }}
        permissions={caseAccess.platformAdminReadOnly ? [] : attorneyPreview ? ROLE_PERMISSIONS.ATTORNEY_REVIEWER : ROLE_PERMISSIONS[ctx.user.role]}
        precedents={JSON.parse(JSON.stringify(ranked))}
        physicians={JSON.parse(JSON.stringify(physicians))}
        // Attorney-facing view: range-only pricing, condensed clinical detail,
        // no evidence tab, and the provider attorney-input surface. Firm admins
        // can preview it per case via ?viewAs=attorney (presentation only —
        // permissions are swapped to the attorney's set for a faithful preview,
        // while server-side authorization still runs against the real session).
        attorneyView={attorneyView}
        pendingResolution={pendingResolution}
      />
    </div>
  );
}
