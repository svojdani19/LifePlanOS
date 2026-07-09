import { redirect } from "next/navigation";
import { requireContext, seatCount } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { effectiveLimits } from "@/lib/subscription/plans";
import { TeamManager } from "@/components/TeamManager";

export default async function TeamPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "team.manage")) redirect("/dashboard");

  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const seats = await seatCount(ctx.firm.id);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Team & Seats</h1>
        <p className="mt-1 text-sm text-ink-600">
          {seats} of {limits.seatLimit} seats used · roles govern what each teammate can do.
        </p>
      </div>
      <TeamManager currentUserId={ctx.user.id} />
    </div>
  );
}
