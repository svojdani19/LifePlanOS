import { redirect } from "next/navigation";
import { AdminNav } from "@/components/ui/AdminNav";
import { requireContext, seatCount } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { effectiveLimits } from "@/lib/subscription/plans";
import { TeamManager } from "@/components/TeamManager";
import { prisma } from "@/lib/db";
import { Badge } from "@/components/ui/Badge";

export default async function TeamPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "team.manage") && !ctx.supportMode) redirect("/dashboard");

  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const seats = await seatCount(ctx.firm.id);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Team & Seats</h1>
        <p className="mt-1 text-sm text-ink-600">
          {seats} of {limits.seatLimit} seats used · roles govern what each teammate can do.
        </p>
        <AdminNav current="/team" />
      </div>
      {ctx.supportMode ? <ReadOnlyTeam firmId={ctx.firm.id} /> : <TeamManager currentUserId={ctx.user.id} />}
    </div>
  );
}

async function ReadOnlyTeam({ firmId }: { firmId: string }) {
  const users = await prisma.user.findMany({
    where: { firmId },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, role: true, status: true, preferredWorkspace: true },
  });
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">READ-ONLY PLATFORM SUPPORT VIEW</div>
      <table className="w-full text-sm">
        <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr><th className="px-4 py-2">Member</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Workspace</th><th className="px-4 py-2">Status</th></tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {users.map((user) => (
            <tr key={user.id}><td className="px-4 py-2"><div className="font-medium text-ink-900">{user.name}</div><div className="text-xs text-ink-500">{user.email}</div></td><td className="px-4 py-2">{user.role.replace(/_/g, " ")}</td><td className="px-4 py-2 text-ink-600">{user.preferredWorkspace?.replace(/_/g, " ") ?? "—"}</td><td className="px-4 py-2"><Badge tone={user.status === "ACTIVE" ? "success" : "neutral"}>{user.status.toLowerCase()}</Badge></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
