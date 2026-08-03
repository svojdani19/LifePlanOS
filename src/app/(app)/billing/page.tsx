import { redirect } from "next/navigation";
import { AdminNav } from "@/components/ui/AdminNav";
import { requireContext } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { BillingManager } from "@/components/BillingManager";
import { seatCount, activeCaseCount } from "@/lib/tenant";

export default async function BillingPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "billing.manage") && !ctx.supportMode) redirect("/dashboard");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Billing & Subscription</h1>
        <p className="mt-1 text-sm text-ink-600">Manage your firm's plan, seats, and usage limits.</p>
        <AdminNav current="/billing" />
      </div>
      {ctx.supportMode ? <ReadOnlyBilling ctx={ctx} /> : <BillingManager />}
    </div>
  );
}

async function ReadOnlyBilling({ ctx }: { ctx: Awaited<ReturnType<typeof requireContext>> }) {
  const [seats, cases] = await Promise.all([seatCount(ctx.firm.id), activeCaseCount(ctx.firm.id)]);
  return (
    <div className="card p-5">
      <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">READ-ONLY PLATFORM SUPPORT VIEW</div>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-xs uppercase text-ink-500">Tier</dt><dd className="mt-1 font-semibold">{ctx.subscription?.tier ?? "None"}</dd></div><div><dt className="text-xs uppercase text-ink-500">Status</dt><dd className="mt-1 font-semibold">{ctx.subscription?.status ?? "None"}</dd></div><div><dt className="text-xs uppercase text-ink-500">Seats used</dt><dd className="mt-1 font-semibold">{seats}</dd></div><div><dt className="text-xs uppercase text-ink-500">Active cases</dt><dd className="mt-1 font-semibold">{cases}</dd></div></dl>
    </div>
  );
}
