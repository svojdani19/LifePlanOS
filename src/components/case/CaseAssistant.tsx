"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, ChevronDown, Send, X } from "lucide-react";

type AnyRec = Record<string, unknown>;
interface Item { id: string; category: string; severity: string; title: string; summary: string; whyItMatters: string; suggestedAction: string; status: string; entityType: string | null; entityId: string | null; exportBlocking: boolean; assignedUserId: string | null; resolutionNote: string | null }
interface Stage { stage: string; label: string; ready: boolean; blocking: string[]; outstanding: string[]; nextActions: string[] }

const SEV_TONE: Record<string, string> = {
  CRITICAL: "border-red-300 bg-red-50 text-red-800",
  HIGH: "border-amber-300 bg-amber-50 text-amber-800",
  MODERATE: "border-brand-200 bg-brand-50 text-brand-800",
  LOW: "border-ink-200 bg-ink-50 text-ink-600",
  INFORMATIONAL: "border-ink-200 bg-ink-50 text-ink-500",
};
const band = (i: Item) => (i.severity === "CRITICAL" || i.exportBlocking ? "Critical — blocks final export" : i.severity === "HIGH" ? "Important — affects defensibility or cost" : i.severity === "MODERATE" ? "Review suggested" : "Informational");
const BANDS = ["Critical — blocks final export", "Important — affects defensibility or cost", "Review suggested", "Informational"];

export function CaseAssistant({ caseId, canEdit }: { caseId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ active: Item[]; readiness: Stage[]; blocking: boolean } | null>(null);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/attention`);
      const j = (await res.json()) as AnyRec;
      setData(j as never);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (open && !data) void load();
  }, [open, data, load]);

  const act = async (itemId: string, action: string) => {
    let note: string | undefined;
    if (action === "dismiss") {
      note = window.prompt("Reason for dismissing this item?") ?? undefined;
      if (!note) return;
    }
    await fetch(`/api/cases/${caseId}/attention/${itemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }) });
    await load();
  };

  const ask = async () => {
    if (!q.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
      const j = (await res.json()) as { answer?: string; error?: string };
      setAnswer(j.answer ?? j.error ?? "No answer.");
    } finally {
      setAsking(false);
    }
  };

  const active = data?.active ?? [];
  const criticalCount = active.filter((i) => i.severity === "CRITICAL" || i.exportBlocking).length;
  const highCount = active.filter((i) => i.severity === "HIGH").length;

  return (
    <div className="mt-4 rounded-xl border border-ink-200 bg-white">
      {/* Header control */}
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 font-semibold text-ink-900">
          {criticalCount > 0 ? <ShieldAlert className="h-5 w-5 text-red-600" /> : <ShieldCheck className="h-5 w-5 text-emerald-600" />}
          Case Assistant
          {data && (
            <span className="ml-1 flex gap-1.5 text-xs font-medium">
              {criticalCount > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">{criticalCount} critical</span>}
              {highCount > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">{highCount} important</span>}
              {criticalCount === 0 && highCount === 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">clear</span>}
            </span>
          )}
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-ink-100 p-4">
          {loading && !data ? (
            <div className="flex items-center gap-2 text-sm text-ink-500"><Loader2 className="h-4 w-4 animate-spin" /> Reviewing case…</div>
          ) : (
            <>
              {/* Readiness */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {data?.readiness.map((s) => (
                  <div key={s.stage} className={`rounded-lg border p-2.5 text-xs ${s.ready ? "border-emerald-200 bg-emerald-50" : "border-ink-200 bg-ink-50"}`}>
                    <p className="flex items-center gap-1.5 font-semibold text-ink-800">
                      {s.ready ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> : <ShieldAlert className="h-3.5 w-3.5 text-ink-400" />}
                      {s.label}
                    </p>
                    {s.blocking.length > 0 && <p className="mt-1 text-red-700">Blocked: {s.blocking.slice(0, 2).join(", ")}{s.blocking.length > 2 ? "…" : ""}</p>}
                    {s.ready && s.nextActions[0] && <p className="mt-1 text-emerald-700">{s.nextActions[0]}</p>}
                  </div>
                ))}
              </div>

              {/* Grouped attention items */}
              <div className="mt-4 space-y-3">
                {active.length === 0 && <p className="text-sm text-ink-500">No open attention items — the case is clean on the current findings.</p>}
                {BANDS.map((b) => {
                  const group = active.filter((i) => band(i) === b);
                  if (!group.length) return null;
                  return (
                    <div key={b}>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">{b} ({group.length})</p>
                      <ul className="space-y-2">
                        {group.map((i) => (
                          <li key={i.id} className={`rounded-lg border p-2.5 text-xs ${SEV_TONE[i.severity] ?? SEV_TONE.LOW}`}>
                            <p className="font-semibold">{i.title}{i.entityType === "recommendation" && i.entityId ? <span className="font-normal opacity-70"> · {i.entityId}</span> : null}</p>
                            <p className="mt-0.5 opacity-90">{i.summary}</p>
                            <p className="mt-0.5 italic opacity-75">Why it matters: {i.whyItMatters}</p>
                            <p className="mt-0.5">Suggested: {i.suggestedAction}</p>
                            {canEdit && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                <button onClick={() => act(i.id, "resolve")} className="rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700">Resolve</button>
                                <button onClick={() => act(i.id, "defer")} className="rounded bg-ink-200 px-2 py-0.5 text-ink-700 hover:bg-ink-300">Defer</button>
                                <button onClick={() => act(i.id, "dismiss")} className="rounded bg-white px-2 py-0.5 text-ink-500 ring-1 ring-ink-200 hover:text-red-600">Dismiss…</button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              {/* Ask */}
              <div className="mt-4 border-t border-ink-100 pt-3">
                <div className="flex gap-2">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void ask()}
                    placeholder="Ask: what prevents this case from being finalized?"
                    className="min-w-0 flex-1 rounded-lg border border-ink-200 px-3 py-1.5 text-sm focus:border-brand-400 focus:outline-none"
                  />
                  <button onClick={() => void ask()} disabled={asking} className="rounded-lg bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700 disabled:opacity-50">
                    {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
                {answer && (
                  <div className="mt-2 rounded-lg bg-ink-50 p-3 text-sm text-ink-800">
                    <button onClick={() => setAnswer(null)} className="float-right text-ink-400 hover:text-ink-700"><X className="h-3.5 w-3.5" /></button>
                    <p className="whitespace-pre-wrap">{answer}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
