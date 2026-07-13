"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, Send, X, Check, Clock, Ban, ChevronRight, ChevronLeft, ListChecks, CheckCircle2, ArrowUpRight } from "lucide-react";

interface Item {
  id: string; category: string; severity: string; title: string; summary: string; whyItMatters: string;
  suggestedAction: string; status: string; entityType: string | null; entityId: string | null; exportBlocking: boolean; stageLabel: string;
}
interface Stage { stage: string; label: string; ready: boolean; blocking: string[]; nextActions: string[] }
interface Group { key: string; title: string; category: string; stageLabel: string; severity: string; exportBlocking: boolean; whyItMatters: string; suggestedAction: string; items: Item[] }

const SEV_CHIP: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700", HIGH: "bg-amber-100 text-amber-700",
  MODERATE: "bg-brand-100 text-brand-700", LOW: "bg-ink-100 text-ink-600", INFORMATIONAL: "bg-ink-100 text-ink-500",
};
const SEV_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, INFORMATIONAL: 4 };
const sevLabel = (s: string) => (s === "CRITICAL" ? "Critical" : s === "HIGH" ? "Important" : s === "MODERATE" ? "Review" : "Info");

export function CaseAssistant({ caseId, canEdit, onFocus }: { caseId: string; canEdit: boolean; onFocus?: (entityType: string | null, entityId: string | null, category: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [readiness, setReadiness] = useState<Stage[]>([]);
  const [gIdx, setGIdx] = useState(0);
  const [decided, setDecided] = useState({ resolved: 0, deferred: 0, dismissed: 0 });
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [showList, setShowList] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/attention`);
      const j = (await res.json()) as { active?: Item[]; readiness?: Stage[] };
      setItems(j.active ?? []); setReadiness(j.readiness ?? []); setGIdx(0);
    } finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => {
    if (open) { void load(); setDecided({ resolved: 0, deferred: 0, dismissed: 0 }); }
  }, [open, load]);

  // Collapse repetitive findings: same category+title = one group (items keep
  // their own affected entity). The server already returns items in pipeline →
  // severity order, so insertion order preserves that for groups.
  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const it of items) {
      const key = `${it.category}|${it.title}`;
      let g = m.get(key);
      if (!g) { g = { key, title: it.title, category: it.category, stageLabel: it.stageLabel, severity: it.severity, exportBlocking: it.exportBlocking, whyItMatters: it.whyItMatters, suggestedAction: it.suggestedAction, items: [] }; m.set(key, g); }
      g.items.push(it);
      if (SEV_RANK[it.severity] < SEV_RANK[g.severity]) g.severity = it.severity;
      if (it.exportBlocking) g.exportBlocking = true;
    }
    return [...m.values()];
  }, [items]);

  const current = groups[gIdx];

  const focus = (it: Item) => { onFocus?.(it.entityType, it.entityId, it.category); setOpen(false); };

  const act = useCallback(
    async (action: "resolve" | "defer" | "dismiss") => {
      const g = groups[gIdx];
      if (!g || busy) return;
      let note: string | undefined;
      if (action === "dismiss") {
        note = window.prompt(`Reason for dismissing ${g.items.length === 1 ? "this item" : `all ${g.items.length} items`}?`) ?? undefined;
        if (!note) return;
      }
      setBusy(true);
      try {
        await Promise.all(g.items.map((i) => fetch(`/api/cases/${caseId}/attention/${i.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }) })));
        const kkey = action === "resolve" ? "resolved" : action === "defer" ? "deferred" : "dismissed";
        setDecided((d) => ({ ...d, [kkey]: d[kkey] + g.items.length }));
        const ids = new Set(g.items.map((i) => i.id));
        setItems((prev) => prev.filter((i) => !ids.has(i.id))); // removes the whole group; gIdx now points at the next
      } finally { setBusy(false); }
    },
    [caseId, groups, gIdx, busy],
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") return setOpen(false);
      if (!current || !canEdit) return;
      if (e.key.toLowerCase() === "r") void act("resolve");
      if (e.key.toLowerCase() === "d") void act("defer");
      if (e.key.toLowerCase() === "x") void act("dismiss");
      if (e.key === "ArrowRight") setGIdx((i) => Math.min(i + 1, groups.length - 1));
      if (e.key === "ArrowLeft") setGIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, current, canEdit, act, groups.length]);

  const criticalCount = items.filter((i) => i.severity === "CRITICAL" || i.exportBlocking).length;
  const highCount = items.filter((i) => i.severity === "HIGH").length;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 hover:bg-ink-50">
        {criticalCount > 0 ? <ShieldAlert className="h-4 w-4 text-red-600" /> : <ShieldCheck className="h-4 w-4 text-emerald-600" />}
        Case Review
        {criticalCount > 0 && <span className="rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700">{criticalCount}</span>}
        {criticalCount === 0 && highCount > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">{highCount}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-ink-900/30" onClick={() => setOpen(false)} />
          <aside className="relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <div>
                <p className="font-semibold text-ink-900">Case Review</p>
                <p className="text-xs text-ink-500">{groups.length ? `${Math.min(gIdx + 1, groups.length)} of ${groups.length} to review` : "Nothing to review"}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowList((s) => !s)} title="View all" className={`rounded-md p-1.5 ${showList ? "bg-brand-50 text-brand-700" : "text-ink-400 hover:bg-ink-100"}`}><ListChecks className="h-4 w-4" /></button>
                <button onClick={() => setOpen(false)} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {groups.length > 0 && (
              <div className="h-1 w-full bg-ink-100"><div className="h-1 bg-brand-500 transition-all" style={{ width: `${(gIdx / groups.length) * 100}%` }} /></div>
            )}

            {readiness.length > 0 && (
              <div className="flex gap-1.5 border-b border-ink-100 px-4 py-2">
                {readiness.map((s) => (
                  <span key={s.stage} title={s.ready ? s.nextActions[0] : `Blocked: ${s.blocking.join(", ")}`} className={`flex-1 rounded px-1.5 py-1 text-center text-[10px] font-medium ${s.ready ? "bg-emerald-50 text-emerald-700" : "bg-ink-50 text-ink-400"}`}>{s.label.replace("Ready for ", "")}</span>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-ink-500"><Loader2 className="h-4 w-4 animate-spin" /> Reviewing case…</div>
              ) : showList ? (
                <ul className="space-y-1.5">
                  {groups.map((g, k) => (
                    <li key={g.key}>
                      <button onClick={() => { setGIdx(k); setShowList(false); }} className={`flex w-full items-center gap-2 rounded-md border border-ink-100 px-2.5 py-1.5 text-left text-xs hover:bg-ink-50 ${k === gIdx ? "ring-1 ring-brand-300" : ""}`}>
                        <span className={`rounded px-1.5 py-0.5 font-semibold ${SEV_CHIP[g.severity]}`}>{sevLabel(g.severity)}</span>
                        <span className="truncate text-ink-800">{g.title}</span>
                        {g.items.length > 1 && <span className="ml-auto shrink-0 rounded bg-ink-100 px-1.5 text-ink-500">×{g.items.length}</span>}
                      </button>
                    </li>
                  ))}
                  {groups.length === 0 && <p className="text-sm text-ink-500">No open items.</p>}
                </ul>
              ) : current ? (
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-600">{current.stageLabel}</span>
                    <span className={`rounded px-2 py-0.5 font-semibold ${SEV_CHIP[current.severity]}`}>{sevLabel(current.severity)}</span>
                    {current.exportBlocking && <span className="rounded bg-red-100 px-2 py-0.5 font-semibold text-red-700">blocks export</span>}
                    {current.items.length > 1 && <span className="ml-auto rounded bg-brand-50 px-2 py-0.5 font-semibold text-brand-700">{current.items.length} recommendations</span>}
                  </div>
                  <h3 className="text-base font-semibold text-ink-900">{current.title}</h3>

                  {current.items.length === 1 ? (
                    <>
                      {current.items[0].entityType === "recommendation" && current.items[0].entityId && (
                        <button onClick={() => focus(current.items[0])} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">Open {current.items[0].entityId} <ArrowUpRight className="h-3 w-3" /></button>
                      )}
                      <p className="mt-2 text-sm text-ink-700">{current.items[0].summary}</p>
                    </>
                  ) : (
                    <div className="mt-2">
                      <p className="text-xs text-ink-500">Affects — resolve all together, or open one to fix it in place:</p>
                      <ul className="mt-1.5 space-y-1">
                        {current.items.slice(0, 12).map((i) => (
                          <li key={i.id} className="flex items-center justify-between gap-2 rounded border border-ink-100 px-2 py-1 text-xs">
                            <span className="truncate text-ink-700">{i.entityId}</span>
                            {i.entityType === "recommendation" && i.entityId && <button onClick={() => focus(i)} className="shrink-0 text-brand-700 hover:underline">Open</button>}
                          </li>
                        ))}
                        {current.items.length > 12 && <li className="text-xs text-ink-400">+ {current.items.length - 12} more</li>}
                      </ul>
                    </div>
                  )}

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
                  {readiness.find((s) => s.stage === "final_export")?.ready
                    ? <p className="mt-2 text-sm text-emerald-700">No export-blocking findings remain.</p>
                    : <p className="mt-2 text-sm text-amber-700">Some blocking items were deferred — final export stays blocked until they’re resolved.</p>}
                </div>
              )}
            </div>

            {current && !showList && (
              <div className="border-t border-ink-100 p-3">
                {canEdit ? (
                  <div className="grid grid-cols-3 gap-2">
                    <button disabled={busy} onClick={() => void act("resolve")} className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Check className="h-4 w-4" /> Resolve{current.items.length > 1 ? " all" : ""} <kbd className="ml-1 text-[10px] opacity-70">R</kbd></button>
                    <button disabled={busy} onClick={() => void act("defer")} className="flex items-center justify-center gap-1.5 rounded-lg bg-ink-100 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-200 disabled:opacity-50"><Clock className="h-4 w-4" /> Defer <kbd className="ml-1 text-[10px] opacity-70">D</kbd></button>
                    <button disabled={busy} onClick={() => void act("dismiss")} className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-500 ring-1 ring-ink-200 hover:text-red-600 disabled:opacity-50"><Ban className="h-4 w-4" /> Dismiss <kbd className="ml-1 text-[10px] opacity-70">X</kbd></button>
                  </div>
                ) : (
                  <p className="text-center text-xs text-ink-400">View-only access; triage requires edit permission.</p>
                )}
                <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
                  <button onClick={() => setGIdx((i) => Math.max(i - 1, 0))} disabled={gIdx === 0} className="flex items-center gap-1 disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /> Prev</button>
                  <span>Skip with ← / →</span>
                  <button onClick={() => setGIdx((i) => Math.min(i + 1, groups.length - 1))} disabled={gIdx >= groups.length - 1} className="flex items-center gap-1 disabled:opacity-30">Next <ChevronRight className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}

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
