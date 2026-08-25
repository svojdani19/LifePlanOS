"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  Stethoscope,
  Users,
  CreditCard,
  Settings,
  Activity,
  LogOut,
  BriefcaseBusiness,
  Eye,
  Scale,
  ClipboardList,
  FileSearch,
  HeartPulse,
  Briefcase,
  Calculator,
  ShieldCheck,
  Receipt,
  Building2,
  ServerCog,
  UserSearch,
  Landmark,
  Glasses,
} from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { NotificationBell } from "@/components/NotificationBell";
import type { Permission } from "@/lib/rbac";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  perm?: Permission;
}

/**
 * A distinct icon per workspace.
 *
 * Every workspace link rendered `BriefcaseBusiness`. Below `lg` the labels are
 * hidden, so the rail became a column of identical briefcases: nothing
 * distinguished the Records workspace from the Physician one except position,
 * and a `title` a keyboard user has to hover to read. Keyed by href, which is
 * what the Sidebar is given — the WORKSPACES registry stays a server-side data
 * contract with no presentational fields in it.
 */
const WORKSPACE_ICON: Record<string, typeof LayoutDashboard> = {
  "/attorney": Scale,
  "/case-manager": ClipboardList,
  "/records": FileSearch,
  "/planner": HeartPulse,
  "/physician": Stethoscope,
  "/vocational": Briefcase,
  "/economist": Calculator,
  "/qa": ShieldCheck,
  "/operations": Receipt,
  "/firm-admin": Building2,
  "/platform-admin": ServerCog,
  "/external-expert": UserSearch,
  "/insurance": Landmark,
  "/observer": Glasses,
};

/** An unknown workspace keeps the old icon rather than rendering nothing. */
const workspaceIcon = (href: string) => WORKSPACE_ICON[href] ?? BriefcaseBusiness;

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cases", label: "Cases", icon: FolderKanban, perm: "case.view" },
  { href: "/review", label: "Physician Review", icon: Stethoscope, perm: "physician.review" },
  { href: "/team", label: "Team & Seats", icon: Users, perm: "team.manage" },
  { href: "/billing", label: "Billing", icon: CreditCard, perm: "billing.manage" },
  { href: "/settings", label: "Firm Management", icon: Settings, perm: "firm.settings" },
];

export function Sidebar({
  user,
  firm,
  permissions,
  workspaces,
  viewAs,
}: {
  user: { name: string; email: string; roleLabel: string };
  firm: { name: string; tier: string };
  permissions: Permission[];
  workspaces: { href: string; label: string }[];
  /** Platform-admin "View as" target (presentation only) — shown in addition
   *  to the user's own workspaces, visually marked as a viewed workspace. */
  viewAs?: { href: string; label: string } | null;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const items = NAV.filter((n) => !n.perm || permissions.includes(n.perm));

  return (
    // Collapses to an icon rail below lg so the working surface keeps priority
    // on laptops/tablets; full labels return at lg.
    <aside className="flex w-16 shrink-0 flex-col border-r border-ink-200 bg-white lg:w-60">
      <div className="flex items-center gap-2 px-3 py-4 lg:px-5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
          <Activity className="h-5 w-5" aria-hidden />
        </div>
        <span className="hidden text-lg font-bold tracking-tight text-ink-900 lg:inline">LifePlanOS</span>
      </div>

      <div className="mx-3 mb-2 hidden rounded-lg bg-ink-50 px-3 py-2 lg:block">
        <p className="truncate text-sm font-semibold text-ink-900">{firm.name}</p>
        <p className="text-xs capitalize text-ink-500">{firm.tier.toLowerCase().replace("_", " ")} plan</p>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-0.5 px-2 py-2 lg:px-3">
        {workspaces.map((workspace) => {
          const active = pathname === workspace.href;
          return (
            <Link key={workspace.href} href={workspace.href} title={`${workspace.label} workspace`} aria-current={active ? "page" : undefined} className={cn("focusable relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors", active ? "bg-brand-50 font-semibold text-brand-800" : "font-medium text-ink-500 hover:bg-ink-50 hover:text-ink-900")}>
              {(() => { const Icon = workspaceIcon(workspace.href); return <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />; })()}
              {/* The label is hidden below lg, so the accessible name would be
                  the icon alone. `sr-only` keeps it available to a screen
                  reader at every width without changing the rail's layout. */}
              <span className="truncate max-lg:sr-only">{workspace.label}</span>
            </Link>
          );
        })}
        {viewAs && !workspaces.some((w) => w.href === viewAs.href) && (
          <Link
            href={viewAs.href}
            title={`Viewing ${viewAs.label} workspace (presentation only)`}
            aria-current={pathname === viewAs.href ? "page" : undefined}
            className={cn(
              "focusable relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              pathname === viewAs.href
                ? "bg-violet-50 font-semibold text-violet-800"
                : "font-medium text-violet-700 hover:bg-violet-50",
            )}
          >
            <Eye className="h-[18px] w-[18px] shrink-0" aria-hidden />
            <span className="truncate max-lg:sr-only">{viewAs.label}</span>
            <span className="hidden rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 lg:inline">
              viewing
            </span>
          </Link>
        )}
        {(workspaces.length > 0 || viewAs) && <div className="my-2 border-t border-ink-100" />}
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focusable relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-brand-50 font-semibold text-brand-800 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-600"
                  : "font-medium text-ink-500 hover:bg-ink-50 hover:text-ink-900",
              )}
            >
              <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
              <span className="max-lg:sr-only">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-ink-200 p-2 lg:p-3">
        <div className="flex flex-wrap items-center gap-2 rounded-lg px-1 py-1.5 lg:flex-nowrap lg:gap-3 lg:px-2">
          <Link href="/account" title="Account & security" className="focusable flex min-w-0 flex-1 items-center gap-3 rounded-lg hover:opacity-80">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
              {initials(user.name)}
            </div>
            <div className="hidden min-w-0 flex-1 lg:block">
              <p className="truncate text-sm font-medium text-ink-900">{user.name}</p>
              <p className="truncate text-xs text-ink-500">{user.roleLabel}</p>
            </div>
          </Link>
          {/* Both were `hidden lg:block`, so below lg there was no way to log
              out and no notifications at all — not a layout choice but a
              missing control. They are icon-only, which the 16-wide rail fits;
              the row wraps rather than the buttons disappearing. */}
          <NotificationBell />
          <button type="button" onClick={logout} title="Log out" aria-label="Log out" className="focusable rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}
