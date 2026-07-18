"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, Send, X, Check, Clock, Ban, ChevronRight, ChevronLeft, CheckCircle2, ArrowUpRight, Undo2, RotateCcw, Keyboard } from "lucide-react";

interface Item {
  id: string; category: string; severity: string; title: string; summary: string; whyItMatters: string;
  suggestedAction: string; status: string; entityType: string | null; entityId: string | null; exportBlocking: boolean; stageLabel: string;
}
interface Stage { stage: string; label: string; ready: boolean; blocking: string[]; nextActions: string[] }

const SEV_CHIP: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700", HIGH: "bg-amber-100 text-amber-700",
  MODERATE: "bg-brand-100 text-brand-700", LOW: "bg-ink-100 text-ink-600", INFORMATIONAL: "bg-ink-100 text-ink-500",
};
const SEV_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, INFORMATIONAL: 4 };
const sevLabel = (s: string) => (s === "CRITICAL" ? "Critical" : s === "HIGH" ? "Important" : s === "MODERATE" ? "Review" : "Info");
const isBlocking = (i: Item) => i.severity === "CRITICAL" || i.exportBlocking;

type Seg = "all" | "blocking" | "important" | "review" | "deferred";

export function CaseAssistant({ caseId, canEdit, onFocus }: { caseId: string; canEdit: boolean; onFocus?: (entityType: string | null, entityId: string | null, category: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [deferred, setDeferred] = useState<Item[]>([]);
  const [readiness, setReadiness] = useState<Stage[]>([]);
  const [seg, setSeg] = useState<Seg>("all");
  const [gIdx, setGIdx] = useState(0);
  const [decided, setDecided] = useState({ resolved: 0, deferred: 0, dismissed: 0 });
  const [busy, setBusy] = useState(false);
  const [undoState, setUndo] = useState<{ items: Item[]; action: string; label: string } | null>(null);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/attention`);
      const j = (await res.json()) as { active?: Item[]; deferred?: Item[]; readiness?: Stage[] };
      setItems(j.active ?? []); setDeferred(j.deferred ?? []); setReadiness(j.readiness ?? []); setGIdx(0);
    } finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => {
    if (open) { void load(); setDecided({ resolved: 0, deferred: 0, dismissed: 0 }); setSeg("all"); setUndo(null); }
  }, [open, load]);

  useEffect(() => { if (open) setTimeout(() => asideRef.current?.focus(), 30); }, [open]);

  // Filtered queue — one item at a time; every decision is per-item.
  const queue = useMemo(() => items.filter((i) => (seg === "all" ? true : seg === "blocking" ? isBlocking(i) : seg === "important" ? i.severity === "HIGH" && !i.exportBlocking : seg === "review" ? SEV_RANK[i.severity] >= 2 : true)), [items, seg]);
  const current = seg === "deferred" ? undefined : queue[gIdx];
  useEffect(() => { setGIdx(0); }, [seg]);
  // Clamp the cursor when the queue shrinks after a decision.
  useEffect(() => { setGIdx((i) => Math.min(i, Math.max(0, queue.length - 1))); }, [queue.length]);

  const counts = useMemo(() => ({
    all: items.length, blocking: items.filter(isBlocking).length, important: items.filter((i) => i.severity === "HIGH" && !i.exportBlocking).length,
    review: items.filter((i) => SEV_RANK[i.severity] >= 2).length, deferred: deferred.length,
  }), [items, deferred]);

  const focus = (it: Item) => { onFocus?.(it.entityType, it.entityId, it.category); setOpen(false); };

  const patchAll = (ids: string[], action: string, note?: string) => Promise.all(ids.map((id) => fetch(`/api/cases/${caseId}/attention/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }) })));

  const act = useCallback(
    async (action: "resolve" | "defer" | "dismiss") => {
      const it = queue[gIdx];
      if (!it || busy) return;
      let note: string | undefined;
      if (action === "dismiss") { note = window.prompt("Reason for dismissing this item?") ?? undefined; if (!note) return; }
      setBusy(true);
      try {
        await patchAll([it.id], action, note);
        const kkey = action === "resolve" ? "resolved" : action === "defer" ? "deferred" : "dismissed";
        setDecided((d) => ({ ...d, [kkey]: d[kkey] + 1 }));
        setItems((prev) => prev.filter((i) => i.id !== it.id));
        if (action === "defer") setDeferred((prev) => [it, ...prev]);
        // Undo affordance.
        const label = `${action === "resolve" ? "Resolved" : action === "defer" ? "Deferred" : "Dismissed"} “${it.title}”`;
        setUndo({ items: [it], action, label });
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => setUndo(null), 6000);
      } finally { setBusy(false); }
    },
    [caseId, queue, gIdx, busy],
  );

  const undo = async () => {
    if (!undoState) return;
    const u = undoState; setUndo(null);
    await patchAll(u.items.map((i) => i.id), "reopen");
    const ids = new Set(u.items.map((i) => i.id));
    setDeferred((prev) => prev.filter((i) => !ids.has(i.id)));
    setItems((prev) => [...u.items, ...prev]);
    setSeg("all"); setGIdx(0);
    const kkey = u.action === "resolve" ? "resolved" : u.action === "defer" ? "deferred" : "dismissed";
    setDecided((d) => ({ ...d, [kkey]: Math.max(0, d[kkey] - u.items.length) }));
  };

  const restoreDeferred = async (it: Item) => {
    await patchAll([it.id], "reopen");
    setDeferred((prev) => prev.filter((i) => i.id !== it.id));
    setItems((prev) => [it, ...prev]);
    setSeg("all");
  };

  const ask = async () => {
    if (!q.trim()) return;
    setAsking(true); setAnswer(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
      const j = (await res.json()) as { answer?: string; error?: string };
      setAnswer(j.answer ?? j.error ?? "No answer.");
    } finally { setAsking(false); }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") return showHelp ? setShowHelp(false) : setOpen(false);
      if (e.key === "?") return setShowHelp((s) => !s);
      if (e.key.toLowerCase() === "u" && undoState) return void undo();
      if (!current || !canEdit) return;
      if (e.key.toLowerCase() === "r") void act("resolve");
      if (e.key.toLowerCase() === "d") void act("defer");
      if (e.key.toLowerCase() === "x") void act("dismiss");
      if (e.key === "ArrowRight") setGIdx((i) => Math.min(i + 1, queue.length - 1));
      if (e.key === "ArrowLeft") setGIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, current, canEdit, act, queue.length, undoState, showHelp]);

  const criticalCount = items.filter(isBlocking).length;
  const highCount = items.filter((i) => i.severity === "HIGH" && !i.exportBlocking).length;
  const total = items.length + deferred.length;
  const done = decided.resolved + decided.dismissed;
  const pct = total + done > 0 ? Math.round((done / (total + done)) * 100) : 0;

  const SEGS: { key: Seg; label: string; n: number }[] = [
    { key: "all", label: "All", n: counts.all }, { key: "blocking", label: "Blocking", n: counts.blocking },
    { key: "important", label: "Important", n: counts.important }, { key: "review", label: "Review", n: counts.review },
    { key: "deferred", label: "Deferred", n: counts.deferred },
  ];

  return (
    <>
      <style>{`@keyframes ca-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes ca-slide{from{transform:translateX(100%)}to{transform:none}}`}</style>

      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 shadow-sm transition hover:bg-ink-50">
        {criticalCount > 0 ? <ShieldAlert className="h-4 w-4 text-red-600" /> : <ShieldCheck className="h-4 w-4 text-emerald-600" />}
        Case Review
        {criticalCount > 0 && <span className="rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700">{criticalCount}</span>}
        {criticalCount === 0 && highCount > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">{highCount}</span>}
        {counts.deferred > 0 && <span className="rounded-full bg-ink-100 px-1.5 text-xs font-semibold text-ink-500" title={`${counts.deferred} deferred`}>{counts.deferred}⏱</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-ink-900/30 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          <aside ref={asideRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Case review" style={{ animation: "ca-slide 220ms cubic-bezier(.22,.61,.36,1)" }} className="relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl outline-none">
            {/* Header + progress ring */}
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="relative h-9 w-9 shrink-0">
                  <svg viewBox="0 0 36 36" className="h-9 w-9 -rotate-90">
                    <circle cx="18" cy="18" r="15" fill="none" stroke="#e5e7eb" strokeWidth="3" />
                    <circle cx="18" cy="18" r="15" fill="none" stroke={criticalCount ? "#dc2626" : "#059669"} strokeWidth="3" strokeDasharray={`${(pct / 100) * 94.2} 94.2`} strokeLinecap="round" />
                  </svg>
                  <span className="absolute inset-0 grid place-items-center text-[10px] font-semibold text-ink-600">{pct}%</span>
                </div>
                <div>
                  <p className="font-semibold text-ink-900">Case Review</p>
                  <p className="text-xs text-ink-500">{queue.length ? `${Math.min(gIdx + 1, queue.length)} of ${queue.length}` : total === 0 ? "All clear" : "Nothing in this view"}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setShowHelp((s) => !s)} title="Keyboard shortcuts (?)" className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100"><Keyboard className="h-4 w-4" /></button>
                <button onClick={() => setOpen(false)} title="Close (Esc)" className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {/* Progress bar */}
            {queue.length > 0 && <div className="h-1 w-full bg-ink-100"><div className="h-1 bg-brand-500 transition-all duration-300" style={{ width: `${(gIdx / queue.length) * 100}%` }} /></div>}

            {/* Segmented filter */}
            <div className="flex gap-1 overflow-x-auto border-b border-ink-100 px-3 py-2">
              {SEGS.map((s) => (
                <button key={s.key} onClick={() => setSeg(s.key)} className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition ${seg === s.key ? "bg-brand-600 text-white" : "bg-ink-50 text-ink-600 hover:bg-ink-100"}`}>
                  {s.label}{s.n > 0 && <span className={`ml-1 ${seg === s.key ? "opacity-80" : "opacity-60"}`}>{s.n}</span>}
                </button>
              ))}
            </div>

            {/* Readiness strip */}
            {readiness.length > 0 && (
              <div className="flex gap-1.5 border-b border-ink-100 px-4 py-2">
                {readiness.map((s) => (
                  <span key={s.stage} title={s.ready ? s.nextActions[0] : `Blocked: ${s.blocking.join(", ")}`} className={`flex-1 rounded px-1.5 py-1 text-center text-[10px] font-medium ${s.ready ? "bg-emerald-50 text-emerald-700" : "bg-ink-50 text-ink-400"}`}>{s.label.replace("Ready for ", "")}</span>
                ))}
              </div>
            )}

            {/* Body */}
            <div className="relative flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-ink-500"><Loader2 className="h-4 w-4 animate-spin" /> Reviewing case…</div>
              ) : seg === "deferred" ? (
                <ul className="space-y-2">
                  {deferred.length === 0 && <p className="text-sm text-ink-500">Nothing deferred.</p>}
                  {deferred.map((i) => (
                    <li key={i.id} className="rounded-lg border border-ink-100 p-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 font-semibold ${SEV_CHIP[i.severity]}`}>{sevLabel(i.severity)}</span>
                        <span className="truncate font-medium text-ink-800">{i.title}</span>
                        {canEdit && <button onClick={() => void restoreDeferred(i)} className="ml-auto flex shrink-0 items-center gap-1 text-brand-700 hover:underline"><RotateCcw className="h-3 w-3" /> Restore</button>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : current ? (
                <div key={current.id} style={{ animation: "ca-in 180ms ease-out" }}>
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-600">{current.stageLabel}</span>
                    <span className={`rounded px-2 py-0.5 font-semibold ${SEV_CHIP[current.severity]}`}>{sevLabel(current.severity)}</span>
                    {current.exportBlocking && <span className="rounded bg-red-100 px-2 py-0.5 font-semibold text-red-700">blocks export</span>}
                  </div>
                  <h3 className="text-base font-semibold text-ink-900">{current.title}</h3>
                  <p className="mt-2 text-sm text-ink-700">{current.summary}</p>
                  {current.entityType === "recommendation" && current.entityId && (
                    <button onClick={() => focus(current)} className="mt-2 inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-100">
                      Go to this item <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <div className="mt-3 rounded-lg bg-ink-50 p-3 text-sm">
                    <p className="text-ink-700"><span className="font-semibold text-ink-800">Why it matters. </span>{current.whyItMatters}</p>
                    <p className="mt-1.5 text-ink-700"><span className="font-semibold text-ink-800">Suggested. </span>{current.suggestedAction}</p>
                  </div>
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <CheckCircle2 className="h-12 w-12 text-emerald-500" style={{ animation: "ca-in 260ms ease-out" }} />
                  <p className="mt-3 font-semibold text-ink-900">{total === 0 ? "This case is clean" : "Nothing left in this view"}</p>
                  <p className="mt-1 text-sm text-ink-500">{decided.resolved} resolved · {decided.deferred} deferred · {decided.dismissed} dismissed</p>
                  {readiness.find((s) => s.stage === "final_export")?.ready
                    ? <p className="mt-2 text-sm text-emerald-700">No export-blocking findings remain — ready for final export.</p>
                    : counts.deferred > 0 ? <button onClick={() => setSeg("deferred")} className="mt-2 text-sm text-amber-700 hover:underline">{counts.deferred} deferred — some may still block export. Review →</button>
                    : counts.blocking > 0 ? <button onClick={() => setSeg("blocking")} className="mt-2 text-sm text-red-700 hover:underline">{counts.blocking} blocking item(s) remain →</button> : null}
                </div>
              )}

              {/* Undo toast */}
              {undoState && (
                <div className="pointer-events-auto absolute inset-x-4 bottom-3 flex items-center justify-between gap-3 rounded-lg bg-ink-900 px-3 py-2 text-xs text-white shadow-lg" style={{ animation: "ca-in 160ms ease-out" }}>
                  <span>{undoState.label}</span>
                  <button onClick={() => void undo()} className="flex items-center gap-1 font-semibold text-brand-200 hover:text-white"><Undo2 className="h-3.5 w-3.5" /> Undo<kbd className="ml-1 opacity-60">U</kbd></button>
                </div>
              )}

              {/* Shortcuts help */}
              {showHelp && (
                <div className="absolute inset-0 grid place-items-center bg-white/95 p-6 text-sm" onClick={() => setShowHelp(false)}>
                  <div className="w-full max-w-xs space-y-1.5">
                    <p className="mb-2 font-semibold text-ink-900">Keyboard shortcuts</p>
                    {[["R", "Resolve"], ["D", "Defer"], ["X", "Dismiss"], ["← / →", "Skip between items"], ["U", "Undo last action"], ["?", "Toggle this help"], ["Esc", "Close"]].map(([k, v]) => (
                      <div key={k} className="flex justify-between text-ink-600"><kbd className="rounded bg-ink-100 px-1.5 font-mono text-xs">{k}</kbd><span>{v}</span></div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Action bar */}
            {current && seg !== "deferred" && (
              <div className="border-t border-ink-100 p-3">
                {canEdit ? (
                  <div className="grid grid-cols-3 gap-2">
                    <button disabled={busy} onClick={() => void act("resolve")} className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 disabled:opacity-50"><Check className="h-4 w-4" /> Resolve <kbd className="ml-1 text-[10px] opacity-70">R</kbd></button>
                    <button disabled={busy} onClick={() => void act("defer")} className="flex items-center justify-center gap-1.5 rounded-lg bg-ink-100 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-200 active:scale-95 disabled:opacity-50"><Clock className="h-4 w-4" /> Defer <kbd className="ml-1 text-[10px] opacity-70">D</kbd></button>
                    <button disabled={busy} onClick={() => void act("dismiss")} className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-500 ring-1 ring-ink-200 transition hover:text-red-600 active:scale-95 disabled:opacity-50"><Ban className="h-4 w-4" /> Dismiss <kbd className="ml-1 text-[10px] opacity-70">X</kbd></button>
                  </div>
                ) : <p className="text-center text-xs text-ink-400">View-only access; triage requires edit permission.</p>}
                <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
                  <button onClick={() => setGIdx((i) => Math.max(i - 1, 0))} disabled={gIdx === 0} className="flex items-center gap-1 disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /> Prev</button>
                  <button onClick={() => setShowHelp(true)} className="hover:text-ink-700">shortcuts</button>
                  <button onClick={() => setGIdx((i) => Math.min(i + 1, queue.length - 1))} disabled={gIdx >= queue.length - 1} className="flex items-center gap-1 disabled:opacity-30">Next <ChevronRight className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}

            {/* Ask — case-aware, evidence-grounded Q&A with contextual starters */}
            <div className="border-t border-ink-100 p-3">
              {answer && (
                <div className="mb-2 rounded-lg bg-ink-50 p-2.5 text-sm text-ink-800" style={{ animation: "ca-in 160ms ease-out" }}>
                  <button onClick={() => setAnswer(null)} aria-label="Dismiss answer" className="float-right text-ink-400 hover:text-ink-700"><X className="h-3.5 w-3.5" /></button>
                  <p className="whitespace-pre-wrap">{answer}</p>
                </div>
              )}
              {!answer && !q && (
                <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Suggested questions">
                  {["What blocks final export?", "Which items lack physician confirmation?", "Show recommendation conflicts.", "Summarize unresolved findings."].map((s) => (
                    <button
                      key={s}
                      onClick={() => setQ(s)}
                      className="rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void ask()} placeholder="Ask: what blocks final export?" className="min-w-0 flex-1 rounded-lg border border-ink-200 px-3 py-1.5 text-sm focus:border-brand-400 focus:outline-none" />
                <button onClick={() => void ask()} disabled={asking} className="rounded-lg bg-brand-600 px-3 py-1.5 text-white transition hover:bg-brand-700 active:scale-95 disabled:opacity-50">{asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
