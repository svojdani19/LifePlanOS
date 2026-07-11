import { requireContext } from "@/lib/tenant";
import { ROLE_LABELS } from "@/lib/rbac";
import { MfaCard } from "@/components/MfaCard";

export default async function AccountPage() {
  const ctx = await requireContext();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Account & Security</h1>
        <p className="mt-1 text-sm text-ink-600">
          {ctx.user.name} · {ctx.user.email} · {ROLE_LABELS[ctx.user.role]}
        </p>
      </div>
      <MfaCard enabled={ctx.user.mfaEnabled} />
    </div>
  );
}
