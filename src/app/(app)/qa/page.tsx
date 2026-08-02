import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { approvalStale } from "@/lib/reports/persist";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

// ─────────────────────────────────────────────────────────────────────────────
// QA Workspace (MDIP docs/28). Firm-wide quality-assurance queue: integrity
// findings per case (blocking first), approvals whose signature no longer
// covers the exported bytes (status STALE, or an ACTIVE approval whose
// contentSha256 diverges from its export — approvalStale), expert drafts
// awaiting final release, and a per-case release-readiness summary. QA is
// DISPLAY-ONLY here by design: a QA reviewer cannot approve as an expert —
// approval/attestation happens in the case Report tab under the responsible
// expert's own credentials. Guard: an ACTIVE QUALITY_ASSURANCE_REVIEWER
// assignment, or legacy ADMIN/PHYSICIAN_REVIEWER.
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<string, BadgeTone> = {
  Critical: "danger",
  High: "danger",
  Moderate: "warning",
  Low: "neutral",
};

export default async function QaWorkspacePage() {
  const ctx = await requireContext();
  const legacyAllowed = ctx.user.role === "ADMIN" || ctx.user.role === "PHYSICIAN_REVIEWER";
  if (!legacyAllowed) {
    const assignment = await prisma.userRoleAssignment.count({
      where: { userId: ctx.user.id, firmId: ctx.firm.id, status: "ACTIVE", builtInRole: "QUALITY_ASSURANCE_REVIEWER" },
    });
    if (assignment === 0) redirect("/dashboard");
  }
  const firmId = ctx.firm.id;

  const [findings, approvals, draftsAwaitingRelease, openCases] = await Promise.all([
    prisma.validationFinding.findMany({
      where: { firmId, case: { status: { notIn: ["CLOSED", "ARCHIVED"] } } },
      orderBy: [{ exportBlocking: "desc" }, { createdAt: "desc" }],
      select: { id: true, caseId: true, service: true, result: true, issue: true, severity: true, exportBlocking: true },
    }),
    prisma.reportApproval.findMany({
      where: { firmId, status: { in: ["ACTIVE", "STALE"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, caseId: true, reportExportId: true, kind: true, expertRole: true, reviewerName: true, contentSha256: true, status: true, updatedAt: true },
    }),
    // Expert drafts that have not been released as finals.
    prisma.reportExport.findMany({
      where: { firmId, lifecycle: "draft_expert", supersededById: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, caseId: true, reportType: true, format: true, version: true, createdAt: true },
    }),
    prisma.case.findMany({
      where: { firmId, status: { notIn: ["CLOSED", "ARCHIVED"] } },
      select: { id: true, clientName: true, caseNumber: true, status: true },
    }),
  ]);

  // Hash-check every approval against its export: a signature is stale when it
  // is marked STALE, or when the exported bytes no longer match what was signed.
  const exportIds = [...new Set(approvals.map((a) => a.reportExportId))];
  const approvalExports = exportIds.length
    ? await prisma.reportExport.findMany({ where: { id: { in: exportIds }, firmId }, select: { id: true, contentSha256: true, reportType: true, version: true } })
    : [];
  const exportById = new Map(approvalExports.map((e) => [e.id, e]));
  const staleApprovals = approvals.filter((a) => {
    if (a.status === "STALE") return true;
    const exp = exportById.get(a.reportExportId);
    return exp ? approvalStale(a, exp) : false;
  });

  const caseById = new Map(openCases.map((c) => [c.id, c]));
  const caseLabel = (id: string) => {
    const c = caseById.get(id);
    return c ? `${c.clientName} · ${c.caseNumber}` : "Case";
  };

  // Per-case rollup for the release-readiness summary.
  const blockingByCase = new Map<string, number>();
  const nonBlockingByCase = new Map<string, number>();
  for (const f of findings) {
    const m = f.exportBlocking ? blockingByCase : nonBlockingByCase;
    m.set(f.caseId, (m.get(f.caseId) ?? 0) + 1);
  }
  const staleByCase = new Map<string, number>();
  for (const s of staleApprovals) staleByCase.set(s.caseId, (staleByCase.get(s.caseId) ?? 0) + 1);
  const draftsByCase = new Map<string, number>();
  for (const d of draftsAwaitingRelease) draftsByCase.set(d.caseId, (draftsByCase.get(d.caseId) ?? 0) + 1);

  // Cases with any QA-relevant signal, ordered: blocked → stale → drafts.
  const qaCases = openCases
    .filter((c) => blockingByCase.has(c.id) || nonBlockingByCase.has(c.id) || staleByCase.has(c.id) || draftsByCase.has(c.id))
    .sort((a, b) => (blockingByCase.get(b.id) ?? 0) - (blockingByCase.get(a.id) ?? 0) || (staleByCase.get(b.id) ?? 0) - (staleByCase.get(a.id) ?? 0));

  const totalBlocking = findings.filter((f) => f.exportBlocking).length;

  return (
    <div>
      <PageHeader
        title="QA Workspace"
        subtitle="Firm-wide quality queue — integrity findings, stale signatures, and reports awaiting final release"
        metrics={[
          { label: "Blocking Findings", value: String(totalBlocking) },
          { label: "Stale Approvals", value: String(staleApprovals.length) },
          { label: "Awaiting Release", value: String(draftsAwaitingRelease.length) },
        ]}
      />

      <div className="card mt-4 border-sky-200 bg-sky-50/60 p-4 text-sm text-ink-700">
        QA review is display-only: a QA reviewer cannot approve or attest in an expert&apos;s place. Approvals are signed by the
        responsible expert from the case&apos;s Report tab, and every signature stays bound to the exact exported content hash.
      </div>

      {/* ── Release readiness per case ────────────────────────────────────────── */}
      <h2 className="text-label mt-6">Release Readiness</h2>
      {qaCases.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">Nothing needs QA attention — no open findings, stale approvals, or unreleased expert drafts.</div>
      ) : (
        <div className="card mt-2 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Blocking</th>
                <th className="px-4 py-2.5 font-medium">Other Findings</th>
                <th className="px-4 py-2.5 font-medium">Stale Approvals</th>
                <th className="px-4 py-2.5 font-medium">Drafts Awaiting Release</th>
                <th className="px-4 py-2.5 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {qaCases.map((c) => {
                const nBlock = blockingByCase.get(c.id) ?? 0;
                const nStale = staleByCase.get(c.id) ?? 0;
                const nDrafts = draftsByCase.get(c.id) ?? 0;
                const blocked = nBlock > 0 || nStale > 0;
                return (
                  <tr key={c.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <Link href={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.clientName}</Link>
                      <span className="ml-2 font-mono text-xs text-ink-400">{c.caseNumber}</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{nBlock > 0 ? <span className="font-medium text-red-700">{nBlock}</span> : 0}</td>
                    <td className="px-4 py-2.5 tabular-nums">{nonBlockingByCase.get(c.id) ?? 0}</td>
                    <td className="px-4 py-2.5 tabular-nums">{nStale > 0 ? <span className="font-medium text-amber-700">{nStale}</span> : 0}</td>
                    <td className="px-4 py-2.5 tabular-nums">{nDrafts}</td>
                    <td className="px-4 py-2.5">
                      {blocked ? (
                        <Badge tone="danger">not releasable</Badge>
                      ) : nDrafts > 0 ? (
                        <Badge tone="info">ready for expert release</Badge>
                      ) : (
                        <Badge tone="neutral">review</Badge>
                      )}
                      <Link href={`/cases/${c.id}`} className="ml-2 text-xs text-brand-700 hover:underline">Report tab</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* ── Stale approvals ─────────────────────────────────────────────────── */}
        <div className="card p-5">
          <h3 className="h-section">Stale Approvals &amp; Attestations</h3>
          <p className="mt-1 text-xs text-ink-500">Marked STALE, or the export&apos;s content hash no longer matches the signed hash.</p>
          <ul className="mt-3 space-y-2">
            {staleApprovals.length === 0 && <li className="text-sm text-ink-500">Every approval on file still covers its exported content.</li>}
            {staleApprovals.map((s) => {
              const exp = exportById.get(s.reportExportId);
              return (
                <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <Link href={`/cases/${s.caseId}`} className="font-medium text-brand-700 hover:underline">{caseLabel(s.caseId)}</Link>
                    <span className="ml-2 text-xs text-ink-500">
                      {s.expertRole} {s.kind.toLowerCase()} by {s.reviewerName}
                      {exp?.reportType ? ` · ${exp.reportType.replace(/_/g, " ")} v${exp.version}` : ""}
                    </span>
                  </div>
                  <Badge tone="warning">{s.status === "STALE" ? "stale" : "hash mismatch"}</Badge>
                </li>
              );
            })}
          </ul>
        </div>

        {/* ── Reports awaiting release ────────────────────────────────────────── */}
        <div className="card p-5">
          <h3 className="h-section">Reports Awaiting Release</h3>
          <p className="mt-1 text-xs text-ink-500">Expert drafts (lifecycle draft_expert) not yet superseded by a final.</p>
          <ul className="mt-3 space-y-2">
            {draftsAwaitingRelease.length === 0 && <li className="text-sm text-ink-500">No expert drafts are waiting on release.</li>}
            {draftsAwaitingRelease.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <Link href={`/cases/${d.caseId}`} className="font-medium text-brand-700 hover:underline">{caseLabel(d.caseId)}</Link>
                  <span className="ml-2 text-xs text-ink-500">{(d.reportType ?? d.format).toString().replace(/_/g, " ")} v{d.version} · {formatDate(d.createdAt)}</span>
                </div>
                <Badge tone="info">draft expert</Badge>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── Findings, blocking first ──────────────────────────────────────────── */}
      <h2 className="text-label mt-6">Integrity Findings (blocking first)</h2>
      {findings.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">No open integrity findings across the firm&apos;s active cases.</div>
      ) : (
        <div className="card mt-2 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Case</th>
                <th className="px-4 py-2.5 font-medium">Service</th>
                <th className="px-4 py-2.5 font-medium">Finding</th>
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Blocks Export</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {findings.slice(0, 50).map((f) => (
                <tr key={f.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/cases/${f.caseId}`} className="font-medium text-brand-700 hover:underline">{caseLabel(f.caseId)}</Link>
                  </td>
                  <td className="px-4 py-2.5 text-ink-600">{f.service}</td>
                  <td className="px-4 py-2.5 text-ink-600">
                    <span className="font-medium text-ink-800">{f.result}</span>
                    <span className="text-ink-500"> — {f.issue}</span>
                  </td>
                  <td className="px-4 py-2.5"><Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"}>{f.severity}</Badge></td>
                  <td className="px-4 py-2.5">{f.exportBlocking ? <Badge tone="danger">yes</Badge> : <span className="text-ink-400">no</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {findings.length > 50 && <div className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">Showing the first 50 of {findings.length} findings — open a case for its full list.</div>}
        </div>
      )}
    </div>
  );
}
