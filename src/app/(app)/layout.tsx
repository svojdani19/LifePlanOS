import { requireContext } from "@/lib/tenant";
import { ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext(); // redirects to /login when unauthenticated

  return (
    <div className="flex h-screen overflow-hidden bg-ink-50">
      <Sidebar
        user={{ name: ctx.user.name, email: ctx.user.email, roleLabel: ROLE_LABELS[ctx.user.role] }}
        firm={{ name: ctx.firm.name, tier: ctx.subscription?.tier ?? "SOLO" }}
        permissions={ROLE_PERMISSIONS[ctx.user.role]}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
