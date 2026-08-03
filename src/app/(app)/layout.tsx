import { cookies } from "next/headers";
import { requireContext } from "@/lib/tenant";
import { ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac";
import { Sidebar } from "@/components/Sidebar";
import { prisma } from "@/lib/db";
import { LEGACY_ROLE_MAP } from "@/lib/authz/roles";
import { WORKSPACES } from "@/lib/workspaces";
import { isPlatformAdmin, VIEW_AS_COOKIE } from "@/lib/authz/platform";
import { SupportContextBanner, ViewAsBanner } from "@/components/platform/ViewAs";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext(); // redirects to /login when unauthenticated
  const roleAssignments = await prisma.userRoleAssignment.findMany({
    where: { userId: ctx.user.id, firmId: ctx.firm.id, status: "ACTIVE" },
    select: { builtInRole: true },
  });
  const roleKeys = new Set([LEGACY_ROLE_MAP[ctx.user.role], ...roleAssignments.map((a) => a.builtInRole).filter((v): v is string => !!v)]);
  const workspaces = [...roleKeys].map((key) => WORKSPACES[key]).filter(Boolean).map((w) => ({ href: w.href, label: w.label }));

  // Super Admin "View as" (presentation only): honored ONLY for users holding
  // the explicit DB platform-admin grant. It adds a labeled banner and a
  // sidebar entry — permissions, credentials, and audit identity are untouched,
  // and each workspace page's own guard still decides access.
  const viewAsKey = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  const viewAsDef = viewAsKey ? WORKSPACES[viewAsKey] : undefined;
  const viewAs =
    viewAsDef && (await isPlatformAdmin(ctx.user.id))
      ? { href: viewAsDef.href, label: viewAsDef.label }
      : null;

  return (
    <div className="flex h-screen overflow-hidden bg-ink-50">
      <Sidebar
        user={{ name: ctx.user.name, email: ctx.user.email, roleLabel: ROLE_LABELS[ctx.user.role] }}
        firm={{ name: ctx.firm.name, tier: ctx.subscription?.tier ?? "SOLO" }}
        permissions={ROLE_PERMISSIONS[ctx.user.role]}
        workspaces={workspaces}
        viewAs={viewAs}
      />
      <main className="flex-1 overflow-y-auto">
        {ctx.supportMode && <SupportContextBanner firmName={ctx.firm.name} />}
        {viewAs && <ViewAsBanner label={viewAs.label} />}
        {(ctx.firm as { isDemo?: boolean }).isDemo && (
          <div className="sticky top-0 z-40 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-white">
            DEMO ENVIRONMENT — SYNTHETIC DATA ONLY
          </div>
        )}
        {/* Wider working surface, tighter vertical rhythm — the case workspace
            and tables benefit from the width; density lives inside content. */}
        <div className="mx-auto max-w-7xl px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
