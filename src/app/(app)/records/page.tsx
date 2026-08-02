import Link from "next/link";
import { redirect } from "next/navigation";
import { Files, ScanSearch, CopyX, ListChecks } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireContext } from "@/lib/tenant";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { WORKSPACES } from "@/lib/workspaces";
import { TYPE_LABEL } from "@/lib/documents/taxonomy";

// ─────────────────────────────────────────────────────────────────────────────
// Records Analyst workspace — the firm-wide triage surface over existing record
// tools. It surfaces processing problems (OCR, classification, duplicates,
// flags), chronology QA coverage, and missing-record signals; every correction
// happens in the case Records tab, which already has the tools. No mutation
// APIs are introduced here. Access: legacy ADMIN / PLANNER / PARALEGAL, or an
// ACTIVE MEDICAL_RECORD_ANALYST role assignment.
// ─────────────────────────────────────────────────────────────────────────────

const OCR_VERIFY_THRESHOLD = 0.8;

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  PROCESSED: "success",
  PROCESSING: "info",
  OCR_PENDING: "warning",
  UPLOADED: "neutral",
  FAILED: "danger",
};

export default async function RecordsAnalystPage() {
  const ctx = await requireContext();
  const firmId = ctx.firm.id;

  // Server-side workspace guard (deny → dashboard).
  if (!(["ADMIN", "PLANNER", "PARALEGAL"] as string[]).includes(ctx.user.role)) {
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId: ctx.user.id, firmId, status: "ACTIVE", builtInRole: "MEDICAL_RECORD_ANALYST" },
      select: { id: true },
    });
    if (!assignment) redirect("/dashboard");
  }

  const [totalDocs, statusCounts, lowOcrCount, unclassifiedCount, flaggedCount, queueDocs, caseQa, dupGroups, missingFindings] = await Promise.all([
    prisma.document.count({ where: { firmId } }),
    prisma.document.groupBy({ by: ["status"], where: { firmId }, _count: true }),
    prisma.document.count({ where: { firmId, ocrConfidence: { lt: OCR_VERIFY_THRESHOLD } } }),
    prisma.document.count({ where: { firmId, type: "OTHER" } }),
    prisma.document.count({ where: { firmId, flags: { not: null } } }),
    // Processing queue: anything not cleanly processed, low OCR confidence,
    // unclassified, or carrying an ingest flag.
    prisma.document.findMany({
      where: {
        firmId,
        OR: [
          { status: { in: ["UPLOADED", "OCR_PENDING", "PROCESSING", "FAILED"] } },
          { ocrConfidence: { lt: OCR_VERIFY_THRESHOLD } },
          { type: "OTHER" },
          { flags: { not: null } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        caseId: true,
        filename: true,
        type: true,
        status: true,
        ocrConfidence: true,
        flags: true,
        createdAt: true,
        case: { select: { clientName: true, caseNumber: true } },
      },
    }),
    // Chronology QA: structured-event coverage vs. uploaded records per case.
    prisma.case.findMany({
      where: { firmId, status: { notIn: ["CLOSED", "ARCHIVED"] } },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        clientName: true,
        caseNumber: true,
        status: true,
        _count: { select: { documents: true, chronologyEvents: true } },
      },
    }),
    // Duplicate-name detection: identical filename uploaded twice to one case.
    prisma.document.groupBy({
      by: ["caseId", "filename"],
      where: { firmId },
      _count: { _all: true },
      having: { filename: { _count: { gt: 1 } } },
    }),
    // Missing-records signals from the deterministic integrity check.
    prisma.validationFinding.findMany({
      where: {
        firmId,
        OR: [
          { issue: { contains: "missing", mode: "insensitive" } },
          { issue: { contains: "record", mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, caseId: true, issue: true, severity: true },
    }),
  ]);

  const statusMap = new Map(statusCounts.map((s) => [s.status as string, s._count]));
  const caseById = new Map(caseQa.map((c) => [c.id, c]));
  const chronologyGaps = caseQa.filter((c) => c._count.documents > 0 && c._count.chronologyEvents === 0);
  const findingCase = (caseId: string) => caseById.get(caseId);
  const dupWithNames = dupGroups
    .map((d) => ({ ...d, caseInfo: caseById.get(d.caseId) }))
    .filter((d) => d.caseInfo); // duplicates on closed/archived cases are out of triage scope

  const ws = WORKSPACES.MEDICAL_RECORD_ANALYST;
  const kpis = [
    { label: "Documents Firm-wide", value: totalDocs, sub: `${statusMap.get("PROCESSED") ?? 0} processed`, icon: Files },
    { label: "Needs Verification", value: lowOcrCount, sub: `OCR confidence < ${OCR_VERIFY_THRESHOLD}`, icon: ScanSearch },
    { label: "Unclassified / Flagged", value: unclassifiedCount + flaggedCount, sub: `${unclassifiedCount} unclassified · ${flaggedCount} flagged`, icon: ListChecks },
    { label: "Duplicate Filenames", value: dupWithNames.length, sub: "same name in one case", icon: CopyX },
  ];

  return (
    <div>
      {/* Intro band */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{ctx.firm.name}</p>
          <h1 className="h-page mt-1">Records Analyst Workspace</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-600">{ws.objective}</p>
        </div>
        <Link href="/cases" className="btn-primary"><Files className="h-4 w-4" /> Go to Cases</Link>
      </div>

      {/* KPIs */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-meta">{k.label}</span>
              <k.icon className="h-4 w-4 text-ink-400" aria-hidden />
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="num-metric text-2xl">{k.value}</span>
              <span className="text-xs text-ink-500">{k.sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Processing queue */}
      <h2 className="text-label mt-6">Processing Queue</h2>
      {queueDocs.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">
          Nothing needs triage — every document is processed, classified, confidently OCR&apos;d, and unflagged.
        </div>
      ) : (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Document</th>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">OCR</th>
                <th className="px-4 py-2.5 font-medium">Flags</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {queueDocs.map((d) => (
                <tr key={d.id} className="hover:bg-ink-50">
                  <td className="max-w-[16rem] truncate px-4 py-2.5 font-medium text-ink-800" title={d.filename}>{d.filename}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-ink-700">{d.case.clientName}</span>
                    <span className="ml-2 font-mono text-xs text-ink-400">{d.case.caseNumber}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    {d.type === "OTHER"
                      ? <Badge tone="warning">unclassified</Badge>
                      : <span className="text-xs text-ink-600">{TYPE_LABEL[d.type] ?? d.type.replace(/_/g, " ").toLowerCase()}</span>}
                  </td>
                  <td className="px-4 py-2.5"><Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-2.5">
                    {d.ocrConfidence == null
                      ? <span className="text-xs text-ink-400">—</span>
                      : d.ocrConfidence < OCR_VERIFY_THRESHOLD
                        ? <Badge tone="danger">verify · {Math.round(d.ocrConfidence * 100)}%</Badge>
                        : <span className="text-xs tabular-nums text-ink-600">{Math.round(d.ocrConfidence * 100)}%</span>}
                  </td>
                  <td className="max-w-[12rem] truncate px-4 py-2.5 text-xs text-amber-700" title={d.flags ?? undefined}>{d.flags ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/cases/${d.caseId}?tab=records`} className="text-xs font-medium text-brand-700 hover:underline">Open records</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Chronology QA */}
      <h2 className="text-label mt-6">Chronology QA</h2>
      {caseQa.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">No open cases yet.</div>
      ) : (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">Documents</th>
                <th className="px-4 py-2.5 font-medium">Chronology Events</th>
                <th className="px-4 py-2.5 font-medium">Signal</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {caseQa.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                    <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                  </td>
                  <td className="px-4 py-2.5"><Badge tone="neutral">{c.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-2.5 tabular-nums">{c._count.documents}</td>
                  <td className="px-4 py-2.5 tabular-nums">{c._count.chronologyEvents}</td>
                  <td className="px-4 py-2.5">
                    {c._count.documents === 0
                      ? <span className="text-xs text-ink-400">no records yet</span>
                      : c._count.chronologyEvents === 0
                        ? <Badge tone="warning">records without chronology</Badge>
                        : <Badge tone="success">chronology built</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/cases/${c.id}?tab=chronology`} className="text-xs font-medium text-brand-700 hover:underline">Open chronology</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Duplicate filenames */}
        <div className="card p-5">
          <h3 className="h-section">Duplicate Filenames</h3>
          <p className="mt-1 text-xs text-ink-500">The same filename uploaded more than once to a case — usually a re-upload, occasionally a genuinely distinct record needing a rename.</p>
          {dupWithNames.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">No duplicate filenames detected in open cases.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {dupWithNames.slice(0, 10).map((d) => (
                <li key={`${d.caseId}:${d.filename}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-ink-800" title={d.filename}>{d.filename}</span>
                    <span className="ml-2 text-xs text-ink-500">{d.caseInfo!.clientName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone="warning">{d._count._all}×</Badge>
                    <Link href={`/cases/${d.caseId}?tab=records`} className="text-xs font-medium text-brand-700 hover:underline">Review</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Missing-records signals */}
        <div className="card p-5">
          <h3 className="h-section">Missing-Records Signals</h3>
          <p className="mt-1 text-xs text-ink-500">Integrity-check findings that mention missing information or records — pointers to gaps in the record set.</p>
          {missingFindings.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">No integrity findings currently point at missing records.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {missingFindings.map((f) => {
                const c = findingCase(f.caseId);
                return (
                  <li key={f.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate" title={f.issue}>
                      {c ? (
                        <Link href={`/cases/${f.caseId}?tab=records`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                      ) : (
                        <span className="font-medium text-ink-700">Case</span>
                      )}
                      <span className="ml-2 text-xs text-ink-600">{f.issue}</span>
                    </span>
                    <Badge tone={f.severity === "Critical" || f.severity === "High" ? "danger" : "warning"} className="shrink-0">{f.severity.toLowerCase()}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-5 text-xs text-ink-500">
        Triage surface only — classification, reprocessing, and chronology corrections happen in each case&apos;s Records and Chronology tabs.
      </p>
    </div>
  );
}
