import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { can } from "@/lib/rbac";

const fmt = (d: Date) => d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default async function AuditPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "audit.view")) redirect("/dashboard");
  const logs = await prisma.auditLog.findMany({
    where: { firmId: ctx.firm.id },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { user: { select: { name: true, email: true } } },
  });

  return (
    <div>
      <Link href="/settings" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Firm Management
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Audit Log</h1>
        <p className="mt-1 text-sm text-ink-600">The 200 most recent access and change events for {ctx.firm.name}. Every PHI access, export, and edit is recorded through the tenant guard.</p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {logs.map((l) => (
              <tr key={l.id} className="hover:bg-ink-50/60">
                <td className="whitespace-nowrap px-4 py-2 text-ink-600">{fmt(l.createdAt)}</td>
                <td className="px-4 py-2 text-ink-800">{l.user?.name ?? "—"}</td>
                <td className="px-4 py-2"><span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-700">{l.action}</span></td>
                <td className="px-4 py-2 text-ink-500">{l.targetType ? `${l.targetType}${l.targetId ? ` · ${l.targetId.slice(0, 8)}` : ""}` : "—"}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-400">{l.ip ?? "—"}</td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-400">No audit events yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
