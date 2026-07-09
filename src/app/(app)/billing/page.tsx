import { redirect } from "next/navigation";
import { requireContext } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { BillingManager } from "@/components/BillingManager";

export default async function BillingPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "billing.manage")) redirect("/dashboard");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Billing & Subscription</h1>
        <p className="mt-1 text-sm text-ink-600">Manage your firm's plan, seats, and usage limits.</p>
      </div>
      <BillingManager />
    </div>
  );
}
