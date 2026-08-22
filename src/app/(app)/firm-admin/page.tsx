import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, ShieldCheck, Settings, CreditCard, BadgeCheck, ScrollText, GraduationCap } from "lucide-react";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

// ─────────────────────────────────────────────────────────────────────────────
// Firm Admin Workspace (MDIP docs/28). The administration hub: live counts and
// deep links into the existing admin surfaces (Team, Roles & Access, Settings,
// Billing, Audit) plus the firm's credential ledger with verification status —
// unverified credentials never auto-qualify anyone for expert approval.
// Guard: legacy ADMIN or an ACTIVE FIRM_ADMINISTRATOR assignment.
// ─────────────────────────────────────────────────────────────────────────────

const CREDENTIAL_TONE: Record<string, BadgeTone> = {
  ORG_VERIFIED: "success",
  EXTERNALLY_VERIFIED: "success",
  SELF_REPORTED: "warning",
  PENDING: "info",
  EXPIRED: "danger",
  SUSPENDED: "danger",
};

export default async function FirmAdminPage() {
  const ctx = await requireContext();
  if (ctx.user.role !== "ADMIN" && !ctx.supportMode) {
    const assignment = await prisma.userRoleAssignment.count({
      where: { userId: ctx.user.id, firmId: ctx.firm.id, status: "ACTIVE", builtInRole: "FIRM_ADMINISTRATOR" },
    });
    if (assignment === 0) redirect("/dashboard");
  }
  const firmId = ctx.firm.id;

  const [userCount, activeAssignments, customRoleCount, credentials, unverifiedCount] = await Promise.all([
    prisma.user.count({ where: { firmId, status: { in: ["ACTIVE", "INVITED"] } } }),
    prisma.userRoleAssignment.count({ where: { firmId, status: "ACTIVE" } }),
    prisma.customRole.count({ where: { firmId } }),
    prisma.userCredential.findMany({
      where: { firmId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, type: true, label: true, category: true, status: true, expiresAt: true, createdAt: true, user: { select: { name: true } } },
    }),
    prisma.userCredential.count({ where: { firmId, status: { in: ["SELF_REPORTED", "PENDING"] } } }),
  ]);
  // Lessons waiting on a human. The approval API shipped with no way to reach
  // it, so the queue could grow with nobody able to see it.
  const pendingLessons = await prisma.learningCandidate.count({ where: { firmId, status: "APPROVAL_PENDING" } });

  const cards = [
    { href: "/team", icon: Users, title: "Team", desc: "Seats, invitations, and member status.", metric: `${userCount} member${userCount === 1 ? "" : "s"}` },
    { href: "/roles", icon: ShieldCheck, title: "Roles & Access", desc: "Built-in templates, custom roles, assignments, and temporary access grants.", metric: `${activeAssignments} active assignment${activeAssignments === 1 ? "" : "s"} · ${customRoleCount} custom role${customRoleCount === 1 ? "" : "s"}` },
    { href: "/settings", icon: Settings, title: "Firm Settings", desc: "Branding, letterhead, retention, and feature flags.", metric: `authz revision ${ctx.firm.authzRevision}` },
    { href: "/billing", icon: CreditCard, title: "Billing", desc: "Plan, seats, and usage for this firm.", metric: ctx.subscription ? `${ctx.subscription.tier.toLowerCase()} plan` : "no subscription" },
    { href: "/team", icon: BadgeCheck, title: "Credentials", desc: "Professional credentials on file; verification gates expert approvals.", metric: `${unverifiedCount} awaiting verification` },
    { href: "/settings/audit", icon: ScrollText, title: "Audit Log", desc: "The append-only trail of every action in the firm.", metric: "view trail" },
    { href: "/settings/learning", icon: GraduationCap, title: "Learned Lessons", desc: "Corrections generalised into guidance, and what the firm has adopted. Editorial lessons are adopted by the platform operator; clinical ones by a credentialed physician.", metric: `${pendingLessons} awaiting approval` },
  ];

  return (
    <div>
      <PageHeader
        title="Firm Administration"
        subtitle={`${ctx.firm.name} — team, roles, credentials, billing, and audit${ctx.supportMode ? " · read-only platform support view" : ""}`}
        metrics={[
          { label: "Members", value: String(userCount) },
          { label: "Active Assignments", value: String(activeAssignments) },
          { label: "Unverified Credentials", value: String(unverifiedCount) },
          { label: "Authz Revision", value: String(ctx.firm.authzRevision) },
        ]}
      />

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.title} href={c.href} className="card group p-5 transition hover:border-brand-300 hover:shadow-md">
            <div className="flex items-center justify-between">
              <c.icon className="h-5 w-5 text-brand-600" aria-hidden />
              <span className="text-xs text-ink-500">{c.metric}</span>
            </div>
            <h2 className="mt-3 text-sm font-semibold text-ink-900 group-hover:text-brand-800">{c.title}</h2>
            <p className="mt-1 text-sm text-ink-600">{c.desc}</p>
          </Link>
        ))}
      </div>

      {/* ── Credential ledger ─────────────────────────────────────────────────── */}
      <h2 className="text-label mt-8">Credential Ledger</h2>
      {credentials.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">No credentials are on file yet. Credentials are uploaded per member from the Team page and verified here before they gate expert approvals.</div>
      ) : (
        <div className="card mt-2 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 font-medium">Credential</th>
                <th className="px-4 py-2.5 font-medium">Category</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Expires</th>
                <th className="px-4 py-2.5 font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {credentials.map((cr) => (
                <tr key={cr.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5 font-medium text-ink-800">{cr.user.name}</td>
                  <td className="px-4 py-2.5 text-ink-600">{cr.label ?? cr.type.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2.5 text-ink-500">{cr.category ?? "—"}</td>
                  <td className="px-4 py-2.5"><Badge tone={CREDENTIAL_TONE[cr.status] ?? "neutral"}>{cr.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-2.5 text-ink-500">{cr.expiresAt ? formatDate(cr.expiresAt) : "—"}</td>
                  <td className="px-4 py-2.5 text-ink-500">{formatDate(cr.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
