"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  CreditCard,
  Settings,
  Activity,
  LogOut,
} from "lucide-react";
import { cn, initials } from "@/lib/utils";
import type { Permission } from "@/lib/rbac";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  perm?: Permission;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cases", label: "Cases", icon: FolderKanban, perm: "case.view" },
  { href: "/team", label: "Team & Seats", icon: Users, perm: "team.manage" },
  { href: "/billing", label: "Billing", icon: CreditCard, perm: "billing.manage" },
  { href: "/settings", label: "Firm Management", icon: Settings, perm: "firm.settings" },
];

export function Sidebar({
  user,
  firm,
  permissions,
}: {
  user: { name: string; email: string; roleLabel: string };
  firm: { name: string; tier: string };
  permissions: Permission[];
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
    <aside className="flex w-64 shrink-0 flex-col border-r border-ink-200 bg-white">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
          <Activity className="h-5 w-5" />
        </div>
        <span className="text-lg font-bold tracking-tight text-ink-900">LifePlanOS</span>
      </div>

      <div className="mx-3 mb-2 rounded-lg bg-ink-50 px-3 py-2">
        <p className="truncate text-sm font-semibold text-ink-900">{firm.name}</p>
        <p className="text-xs capitalize text-ink-500">{firm.tier.toLowerCase().replace("_", " ")} plan</p>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-brand-50 text-brand-800" : "text-ink-600 hover:bg-ink-50 hover:text-ink-900",
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-ink-200 p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <Link href="/account" title="Account & security" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg hover:opacity-80">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
              {initials(user.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-900">{user.name}</p>
              <p className="truncate text-xs text-ink-500">{user.roleLabel}</p>
            </div>
          </Link>
          <button onClick={logout} title="Log out" className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
