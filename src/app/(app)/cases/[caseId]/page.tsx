import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext, requireCase, caseAccessFor, canCanonicalPermission } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/rbac";
import { effectiveLegacyPermissions, effectiveAssignmentTemplates, isAttorneyPresentation } from "@/lib/authz/effective";
import { assumptionsFor } from "@/lib/engine/generate";
import { significanceOf } from "@/lib/engine/chronology";
import { CHRONOLOGY_REVIEW_WHERE } from "@/lib/records/encounterLifecycle";
import { rankPrecedents } from "@/lib/precedents/match";
import { CaseWorkspace } from "@/components/case/CaseWorkspace";

export default async function CaseDetailPage({ params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  const ctx = await requireContext();
  // Direct URLs are guarded before any PHI-bearing relations are loaded. List
  // filtering is not authorization: the same case-scope policy protects this
  // server-rendered resource.
  await requireCase(ctx, params.caseId);
  const caseAccess = await caseAccessFor(ctx);
  // Effective permissions: the user's legacy seat UNION their currently
  // effective role-template assignments applicable to THIS case (org-wide or
  // case-scoped) — so an assignment-based Life Care Planner authors with full
  // clinical permissions regardless of the seat they occupy. Firm admins and
  // attorney seats WITHOUT clinical-authoring authority get the attorney
  // presentation; clinical authors always get the normal clinical view.
  const scopeInput = {
    userId: ctx.user.id,
    firmId: ctx.firm.id,
    role: ctx.user.role,
    caseId: params.caseId,
  };
  const [effectivePermissions, effectiveTemplates] = await Promise.all([
    effectiveLegacyPermissions(scopeInput),
    effectiveAssignmentTemplates(scopeInput),
  ]);
  const attorneyView = isAttorneyPresentation(ctx.user.role, effectivePermissions, effectiveTemplates);
  // Factual record verification (records.verify) — canonical, case-scoped,
  // never satisfied by platform/super-admin status alone; supportMode stays
  // read-only through the same evaluator.
  const canVerifyRecords = !caseAccess.platformAdminReadOnly && canCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
  // Firm admins see who the assigned attorney(s) on the matter are, right in
  // the case banner (case-scoped attorney assignments).
  let assignedAttorneys: string[] = [];
  if (ctx.user.role === "ADMIN") {
    const grants = await prisma.userRoleAssignment.findMany({
      where: { firmId: ctx.firm.id, caseId: params.caseId, status: "ACTIVE", builtInRole: { in: ["ATTORNEY_CLIENT"] } },
      select: { userId: true },
    });
    if (grants.length) {
      const users = await prisma.user.findMany({
        where: { id: { in: grants.map((g) => g.userId) } },
        select: { name: true },
      });
      assignedAttorneys = users.map((u) => u.name);
    }
  }
  const c = await prisma.case.findFirst({
    where: { id: params.caseId, firmId: ctx.firm.id },
    include: {
      createdBy: { select: { name: true } },
      documents: { orderBy: { createdAt: "desc" } },
      // Review scope: current events plus STALE for re-review comparison;
      // superseded and rejected history stays out of the workspace.
      chronologyEvents: { where: CHRONOLOGY_REVIEW_WHERE, orderBy: { eventDate: "asc" } },
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
  // Physician-entered citations, which are NOT derivable and so must travel
  // with the case. The machine-derived ledger deliberately does not: the panel
  // rebuilds it from the same builder, and sending both would create two
  // sources of truth for one thing.
  //
  // Optional-chained for the same reason `structuredRecord` optional-chains
  // its findings query: a running server holding a Prisma client generated
  // before this model existed has no `recommendationEvidence` at all, so
  // `.findMany` throws SYNCHRONOUSLY and `.catch` never gets a promise to
  // attach to. A stale client should cost the citations, not the whole page.
  const physicianEvidence = await prisma.recommendationEvidence
    ?.findMany({
      where: { caseId: c.id, firmId: c.firmId, addedById: { not: null } },
      orderBy: { addedAt: "asc" },
    })
    .catch(() => []) ?? [];

  // Significance is computed at display time against the case's CURRENT
  // conditions and care items — never stored on the row, where it would
  // describe whatever the plan said at the last records rebuild.
  {
    const condNames = c.conditions.map((x) => x.name).filter(Boolean);
    const careServices = c.futureCareItems.map((x) => x.service).filter(Boolean);
    for (const e of c.chronologyEvents) {
      e.clinicalSignificance = significanceOf(e, condNames, careServices);
    }
  }

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
      <Link href="/cases" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> All Cases
      </Link>
      <CaseWorkspace
        data={JSON.parse(JSON.stringify({ ...c, physicianEvidence }))}
        assumptions={assumptions}
        totals={{ totalLifetime, totalPresentValue }}
        permissions={caseAccess.platformAdminReadOnly ? [] : attorneyView ? ROLE_PERMISSIONS.ATTORNEY_REVIEWER : effectivePermissions}
        precedents={JSON.parse(JSON.stringify(ranked))}
        physicians={JSON.parse(JSON.stringify(physicians))}
        // Attorney-facing view: range-only pricing, condensed clinical detail,
        // no evidence tab, and the provider attorney-input surface. Applies to
        // firm admins and attorney seats without clinical authority; users with
        // an effective clinical grant (planner or physician assignment) always
        // get the full clinical view their professional work requires.
        attorneyView={attorneyView}
        assignedAttorneys={Array.from(new Set(assignedAttorneys))}
        canVerifyRecords={canVerifyRecords}
        pendingResolution={pendingResolution}
      />
    </div>
  );
}
