"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, Eye, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Super Admin "View as" surfaces (presentation only). The panel lives on the
// platform-admin page; the banner is rendered by the app shell whenever the
// viewAsWorkspace cookie is set for a platform admin. Neither changes any
// authorization — target pages' own guards decide access; a page that denies
// simply redirects to /dashboard.
// ─────────────────────────────────────────────────────────────────────────────

async function postViewAs(workspace: string): Promise<{ redirect?: string; error?: string }> {
  const res = await fetch("/api/platform/view-as", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace }),
  });
  return res.json().catch(() => ({ error: "Request failed." }));
}

export function ViewAsPanel({
  workspaces,
  viewing,
}: {
  workspaces: { key: string; label: string; href: string }[];
  viewing: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function select(key: string) {
    setError(null);
    startTransition(async () => {
      const out = await postViewAs(key);
      if (out.error) {
        setError(out.error);
        return;
      }
      if (out.redirect) router.push(out.redirect);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 p-5">
      <div className="flex items-center gap-2">
        <Eye className="h-4 w-4 text-ink-500" aria-hidden />
        <h3 className="h-section">View as</h3>
      </div>
      <p className="mt-1 text-sm text-ink-500">
        Presentation-only navigation: opens a workspace with a labeled banner. It never changes your permissions,
        credentials, or audit identity — each workspace&rsquo;s own access rules still apply, and every switch is audited.
      </p>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {workspaces.map((w) => (
          <button
            key={w.key}
            type="button"
            disabled={pending}
            onClick={() => select(w.key)}
            className={cn(
              "focusable rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50",
              viewing === w.key
                ? "border-brand-600 bg-brand-50 font-semibold text-brand-800"
                : "border-ink-200 bg-white font-medium text-ink-700 hover:border-brand-300 hover:bg-ink-50",
            )}
          >
            {w.label}
          </button>
        ))}
      </div>
      {viewing && (
        <button
          type="button"
          disabled={pending}
          onClick={() => select("clear")}
          className="focusable mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          <Undo2 className="h-4 w-4" aria-hidden /> Stop viewing
        </button>
      )}
    </div>
  );
}

export function ViewAsBanner({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function returnToAdmin() {
    startTransition(async () => {
      await postViewAs("clear");
      router.push("/platform-admin");
      router.refresh();
    });
  }

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-3 bg-violet-700 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-white">
      <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Viewing as {label} — presentation only. Your own identity and permissions remain in effect.
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={returnToAdmin}
        className="focusable rounded-md bg-white/15 px-2.5 py-0.5 font-semibold text-white hover:bg-white/25 disabled:opacity-50"
      >
        Return to Platform Admin
      </button>
    </div>
  );
}

async function postTenantContext(firmId: string | null): Promise<{ redirect?: string; error?: string }> {
  const res = await fetch("/api/platform/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firmId }),
  });
  return res.json().catch(() => ({ error: "Request failed." }));
}

export function TenantContextButton({ firmId, active = false }: { firmId: string; active?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function select() {
    setError(null);
    startTransition(async () => {
      const out = await postTenantContext(active ? null : firmId);
      if (out.error) {
        setError(out.error);
        return;
      }
      router.push(out.redirect ?? "/dashboard");
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={select}
        className="focusable rounded-md border border-violet-300 bg-white px-2.5 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50"
      >
        {pending ? "Switching…" : active ? "Exit organization" : "Inspect read-only"}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

export function SupportContextBanner({ firmName }: { firmName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function exit() {
    startTransition(async () => {
      await postTenantContext(null);
      router.push("/platform-admin");
      router.refresh();
    });
  }

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-3 bg-red-700 px-4 py-2 text-center text-xs font-semibold tracking-wide text-white">
      <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>PLATFORM SUPPORT · {firmName} · READ-ONLY · every access is audited</span>
      <button
        type="button"
        disabled={pending}
        onClick={exit}
        className="focusable rounded-md bg-white/15 px-2.5 py-0.5 font-semibold text-white hover:bg-white/25 disabled:opacity-50"
      >
        Exit organization
      </button>
    </div>
  );
}
