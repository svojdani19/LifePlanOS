"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, Send, X, Check, Clock, Ban, ChevronRight, ChevronLeft, ListChecks, CheckCircle2 } from "lucide-react";

type AnyRec = Record<string, unknown>;
interface Item {
  id: string; category: string; severity: string; title: string; summary: string; whyItMatters: string;
  suggestedAction: string; status: string; entityType: string | null; entityId: string | null; exportBlocking: boolean; stageLabel: string;
}
interface Stage { stage: string; label: string; ready: boolean; blocking: string[]; nextActions: string[] }

const SEV_CHIP: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700",
  HIGH: "bg-amber-100 text-amber-700",
  MODERATE: "bg-brand-100 text-brand-700",
  LOW: "bg-ink-100 text-ink-600",
  INFORMATIONAL: "bg-ink-100 text-ink-500",
};
const sevLabel = (s: string) => (s === "CRITICAL" ? "Critical" : s === "HIGH" ? "Important" : s === "MODERATE" ? "Review" : "Info");

export function CaseAssistant({ caseId, canEdit }: { caseId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [readiness, setReadiness] = useState<Stage[]>([]);
  const [idx, setIdx] = useState(0);
  const [decided, setDecided] = useState({ resolved: 0, deferred: 0, dismissed: 0 });
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [showList, setShowList] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/attention`);
      const j = (await res.json()) as { active?: Item[]; readiness?: Stage[] };
      setItems(j.active ?? []);
      setReadiness(j.readiness ?? []);
      setIdx(0);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (open) { void load(); setDecided({ resolved: 0, deferred: 0, dismissed: 0 }); }
  }, [open, load]);

  const current = items[idx];

  const act = useCallback(
    async (action: "resolve" | "defer" | "dismiss") => {
      if (!current) return;
      let note: string | undefined;
      if (action === "dismiss") {
        note = window.prompt("Reason for dismissing this item?") ?? undefined;
        if (!note) return;
      }
      await fetch(`/api/cases/${caseId}/attention/${current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }) });
      setDecided((d) => ({ ...d, [action === "resolve" ? "resolved" : action === "defer" ? "deferred" : "dismissed"]: d[action === "resolve" ? "resolved" : action === "defer" ? "deferred" : "dismissed"] + 1 }));
      // The decided item leaves the active queue; keep idx pointing at the next one.
      setItems((prev) => prev.filter((_, i) => i !== idx));
      setIdx((i) => Math.min(i, items.length - 2 < 0 ? 0 : items.length - 2));
    },
    [caseId, current, idx, items.length],
  );

  const ask = async () => {
    if (!q.trim()) return;
    setAsking(true); setAnswer(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
      const j = (await res.json()) as { answer?: string; error?: string };
      setAnswer(j.answer ?? j.error ?? "No answer.");
    } finally { setAsking(false); }
  };

  // Keyboard shortcuts within the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "Escape") setOpen(false);
      if (!current || !canEdit) return;
      if (e.key.toLowerCase() === "r") void act("resolve");
      if (e.key.toLowerCase() === "d") void act("defer");
      if (e.key.toLowerCase() === "x") void act("dismiss");
      if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, items.length - 1));
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, current, canEdit, act, items.length]);

  const criticalCount = items.filter((i) => i.severity === "CRITICAL" || i.exportBlocking).length;
  const highCount = items.filter((i) => i.severity === "HIGH").length;

  return (
    <>
      {/* Launcher — a compact control (sits in the header action row) */}
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 hover:bg-ink-50">
        {criticalCount > 0 ? <ShieldAlert className="h-4 w-4 text-red-600" /> : <ShieldCheck className="h-4 w-4 text-emerald-600" />}
        Case Review
        {criticalCount > 0 && <span className="rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700">{criticalCount}</span>}
        {criticalCount === 0 && highCount > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">{highCount}</span>}
      </button>

      {/* Slide-over drawer — overlays, never pushes page content */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-ink-900/30" onClick={() => setOpen(false)} />
          <aside className="relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <div>
                <p className="font-semibold text-ink-900">Case Review</p>
                <p className="text-xs text-ink-500">{items.length ? `${Math.min(idx + 1, items.length)} of ${items.length} to review` : "Nothing to review"}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowList((s) => !s)} title="View all" className={`rounded-md p-1.5 ${showList ? "bg-brand-50 text-brand-700" : "text-ink-400 hover:bg-ink-100"}`}><ListChecks className="h-4 w-4" /></button>
                <button onClick={() => setOpen(false)} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {/* Progress bar */}
            {items.length > 0 && (
              <div className="h-1 w-full bg-ink-100">
                <div className="h-1 bg-brand-500 transition-all" style={{ width: `${(idx / items.length) * 100}%` }} />
              </div>
            )}

            {/* Readiness strip */}
            {readiness.length > 0 && (
              <div className="flex gap-1.5 border-b border-ink-100 px-4 py-2">
                {readiness.map((s) => (
                  <span key={s.stage} title={s.ready ? s.nextActions[0] : `Blocked: ${s.blocking.join(", ")}`} className={`flex-1 rounded px-1.5 py-1 text-center text-[10px] font-medium ${s.ready ? "bg-emerald-50 text-emerald-700" : "bg-ink-50 text-ink-400"}`}>
                    {s.label.replace("Ready for ", "")}
                  </span>
                ))}
              </div>
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-ink-500"><Loader2 className="h-4 w-4 animate-spin" /> Reviewing case…</div>
              ) : showList ? (
                <ul className="space-y-1.5">
                  {items.map((i, k) => (
                    <li key={i.id}>
                      <button onClick={() => { setIdx(k); setShowList(false); }} className={`flex w-full items-center gap-2 rounded-md border border-ink-100 px-2.5 py-1.5 text-left text-xs hover:bg-ink-50 ${k === idx ? "ring-1 ring-brand-300" : ""}`}>
                        <span className={`rounded px-1.5 py-0.5 font-semibold ${SEV_CHIP[i.severity]}`}>{sevLabel(i.severity)}</span>
                        <span className="truncate text-ink-800">{i.title}</span>
                      </button>
                    </li>
                  ))}
                  {items.length === 0 && <p className="text-sm text-ink-500">No open items.</p>}
                </ul>
              ) : current ? (
                <div>
                  {/* Stage + severity */}
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-600">{current.stageLabel}</span>
                    <span className={`rounded px-2 py-0.5 font-semibold ${SEV_CHIP[current.severity]}`}>{sevLabel(current.severity)}</span>
                    {current.exportBlocking && <span className="rounded bg-red-100 px-2 py-0.5 font-semibold text-red-700">blocks export</span>}
                  </div>
                  <h3 className="text-base font-semibold text-ink-900">{current.title}</h3>
                  {current.entityType === "recommendation" && current.entityId && <p className="mt-0.5 text-xs text-ink-500">Affects recommendation: {current.entityId}</p>}
                  <p className="mt-2 text-sm text-ink-700">{current.summary}</p>
                  <div className="mt-3 rounded-lg bg-ink-50 p-3 text-sm">
                    <p className="text-ink-700"><span className="font-semibold text-ink-800">Why it matters. </span>{current.whyItMatters}</p>
                    <p className="mt-1.5 text-ink-700"><span className="font-semibold text-ink-800">Suggested. </span>{current.suggestedAction}</p>
                  </div>
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                  <p className="mt-3 font-semibold text-ink-900">All items reviewed</p>
                  <p className="mt-1 text-sm text-ink-500">{decided.resolved} resolved · {decided.deferred} deferred · {decided.dismissed} dismissed</p>
                  {readiness.find((s) => s.stage === "final_export")?.ready ? (
                    <p className="mt-2 text-sm text-emerald-700">No export-blocking findings remain.</p>
                  ) : (
                    <p className="mt-2 text-sm text-amber-700">Some blocking items were deferred — final export stays blocked until they’re resolved.</p>
                  )}
                </div>
              )}
            </div>

            {/* Action bar (one decision → next) */}
            {current && !showList && (
              <div className="border-t border-ink-100 p-3">
                {canEdit ? (
                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={() => void act("resolve")} className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"><Check className="h-4 w-4" /> Resolve <kbd className="ml-1 text-[10px] opacity-70">R</kbd></button>
                    <button onClick={() => void act("defer")} className="flex items-center justify-center gap-1.5 rounded-lg bg-ink-100 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-200"><Clock className="h-4 w-4" /> Defer <kbd className="ml-1 text-[10px] opacity-70">D</kbd></button>
                    <button onClick={() => void act("dismiss")} className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-500 ring-1 ring-ink-200 hover:text-red-600"><Ban className="h-4 w-4" /> Dismiss <kbd className="ml-1 text-[10px] opacity-70">X</kbd></button>
                  </div>
                ) : (
                  <p className="text-center text-xs text-ink-400">You have view-only access; triage requires edit permission.</p>
                )}
                <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
                  <button onClick={() => setIdx((i) => Math.max(i - 1, 0))} disabled={idx === 0} className="flex items-center gap-1 disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /> Prev</button>
                  <span>Skip with the arrow keys — no decision recorded</span>
                  <button onClick={() => setIdx((i) => Math.min(i + 1, items.length - 1))} disabled={idx >= items.length - 1} className="flex items-center gap-1 disabled:opacity-30">Next <ChevronRight className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}

            {/* Ask box */}
            <div className="border-t border-ink-100 p-3">
              {answer && (
                <div className="mb-2 rounded-lg bg-ink-50 p-2.5 text-sm text-ink-800">
                  <button onClick={() => setAnswer(null)} className="float-right text-ink-400 hover:text-ink-700"><X className="h-3.5 w-3.5" /></button>
                  <p className="whitespace-pre-wrap">{answer}</p>
                </div>
              )}
              <div className="flex gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void ask()} placeholder="Ask: what blocks final export?" className="min-w-0 flex-1 rounded-lg border border-ink-200 px-3 py-1.5 text-sm focus:border-brand-400 focus:outline-none" />
                <button onClick={() => void ask()} disabled={asking} className="rounded-lg bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700 disabled:opacity-50">{asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
