import Link from "next/link";
import { cn } from "@/lib/utils";

// Cross-links between the firm-administration pages (Firm, Team, Billing) —
// they live behind separate sidebar icons, so each page shows where the
// others are. Pure presentation; permissions are enforced by each page.
const PAGES = [
  { href: "/settings", label: "Firm" },
  { href: "/team", label: "Team & Seats" },
  { href: "/billing", label: "Billing" },
  { href: "/roles", label: "Roles & Access" },
];

export function AdminNav({ current }: { current: string }) {
  return (
    <div className="mt-3 inline-flex items-center gap-1 rounded-xl bg-ink-100 p-1" role="tablist" aria-label="Firm administration">
      {PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          role="tab"
          aria-selected={current === p.href}
          className={cn(
            "rounded-lg px-3 py-1.5 text-sm font-medium transition",
            current === p.href ? "bg-white text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800",
          )}
        >
          {p.label}
        </Link>
      ))}
    </div>
  );
}
