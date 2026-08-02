"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";

interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body?: string | null;
  caseId?: string | null;
  readAt?: string | null;
  createdAt: string;
}

/**
 * Notification bell for the sidebar. Feature-detects the notifications API:
 * if GET /api/notifications is absent (404) or errors, the bell renders
 * nothing so the shell keeps working without the service.
 */
export function NotificationBell() {
  const router = useRouter();
  const [available, setAvailable] = useState(true);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) setAvailable(false);
        return;
      }
      const data = await res.json();
      const list: AppNotification[] = Array.isArray(data) ? data : (data.notifications ?? data.data ?? []);
      setItems(list);
    } catch {
      // network hiccup — keep last known state
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!available) return null;
  const unread = items.filter((n) => !n.readAt).length;

  async function markRead(n: AppNotification) {
    if (!n.readAt) {
      try {
        await fetch(`/api/notifications?id=${encodeURIComponent(n.id)}`, { method: "PATCH" });
      } catch {
        // best-effort
      }
      setItems((prev) => prev.map((p) => (p.id === n.id ? { ...p, readAt: new Date().toISOString() } : p)));
    }
    if (n.caseId) {
      setOpen(false);
      router.push(`/cases/${n.caseId}`);
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        className="focusable relative rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-600 px-0.5 text-[10px] font-bold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border border-ink-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
            <p className="text-sm font-semibold text-ink-900">Notifications</p>
            {unread > 0 && <span className="text-xs text-ink-500">{unread} unread</span>}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-500">You&apos;re all caught up.</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => void markRead(n)}
                  className={cn(
                    "block w-full border-b border-ink-50 px-4 py-3 text-left last:border-b-0 hover:bg-ink-50",
                    !n.readAt && "bg-brand-50/40",
                  )}
                >
                  <p className={cn("text-sm text-ink-900", !n.readAt && "font-semibold")}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-ink-400">{new Date(n.createdAt).toLocaleString()}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
