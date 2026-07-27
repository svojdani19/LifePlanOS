"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, X, Pencil, Loader2, ExternalLink, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import type { ReviewQueueItem } from "@/lib/engine/reviewQueue";

// ─────────────────────────────────────────────────────────────────────────────
// Physician Workspace client. One-keystroke review over the ordered cross-case
// queue: j/k (or arrows) move, A approves, R rejects, M opens modify, Enter
// expands the reasoning detail. Dispositions call the existing physician-review
// route — the same ledgered, assessment-refreshing path as the case workspace —
// so this surface adds speed, not a second review mechanism.
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

export function PhysicianWorkspace({ queue }: { queue: ReviewQueueItem[] }) {
  const router = useRouter();
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modifying, setModifying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [freq, setFreq] = useState<number | "">("");
  const [dur, setDur] = useState<number | "">("");
  const listRef = useRef<HTMLUListElement>(null);

  const current = queue[cursor] ?? null;

  async function disposition(item: ReviewQueueItem, status: "APPROVED" | "REJECTED" | "MODIFIED") {
    setBusy(item.itemId);
    const body: Record<string, unknown> = { status };
    if (status === "MODIFIED" || note.trim()) body.note = note.trim() || undefined;
    if (status === "MODIFIED") {
      if (freq !== "") body.frequencyPerYear = freq;
      if (dur !== "") body.durationYears = dur;
    }
    const res = await fetch(`/api/cases/${item.caseId}/future-care/${item.itemId}/physician`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(e.error ?? "Review action failed");
      return;
    }
    setModifying(null);
    setNote("");
    setFreq("");
    setDur("");
    router.refresh();
  }

  // Keyboard review flow. Disabled while typing in the modify form.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!queue.length) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, queue.length - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); setExpanded((x) => (current && x === current.itemId ? null : current?.itemId ?? null)); }
      else if ((e.key === "a" || e.key === "A") && current) { e.preventDefault(); disposition(current, "APPROVED"); }
      else if ((e.key === "r" || e.key === "R") && current) { e.preventDefault(); disposition(current, "REJECTED"); }
      else if ((e.key === "m" || e.key === "M") && current) { e.preventDefault(); setExpanded(current.itemId); setModifying(current.itemId); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, cursor, current, note, freq, dur]);

  // Keep the cursor row visible while keyboard-navigating.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (queue.length === 0) {
    return <div className="card mt-4 p-6 text-sm text-ink-600">Nothing awaits physician review. New recommendations appear here the moment a plan is generated or regenerated.</div>;
  }

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs text-ink-500">
        Keyboard: <kbd className="rounded border border-ink-300 px-1">j</kbd>/<kbd className="rounded border border-ink-300 px-1">k</kbd> move ·{" "}
        <kbd className="rounded border border-ink-300 px-1">A</kbd> approve · <kbd className="rounded border border-ink-300 px-1">R</kbd> reject ·{" "}
        <kbd className="rounded border border-ink-300 px-1">M</kbd> modify · <kbd className="rounded border border-ink-300 px-1">Enter</kbd> detail
      </p>
      <ul ref={listRef} className="space-y-2" aria-label="Physician review queue">
        {queue.map((item, i) => {
          const isCursor = i === cursor;
          const isOpen = expanded === item.itemId;
          return (
            <li
              key={item.itemId}
              className={`card p-4 transition-shadow ${isCursor ? "ring-2 ring-brand-500/60" : ""}`}
              onClick={() => setCursor(i)}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink-900">{item.service}</span>
                    {item.blockingFindings.length > 0 && (
                      <Badge tone="danger"><ShieldAlert className="mr-1 h-3 w-3" />blocks export</Badge>
                    )}
                    {item.assessmentStatus === "INVALID" && <Badge tone="danger">invalid</Badge>}
                    {item.assessmentStatus === "NEEDS_REVIEW" && <Badge tone="warning">gated</Badge>}
                    {item.sufficiency && !item.sufficiency.sufficient && (
                      <Badge tone="warning">evidence {item.sufficiency.score}/{item.sufficiency.threshold}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {item.clientName} · <span className="font-mono">{item.caseNumber}</span> · {item.category.replace(/_/g, " ").toLowerCase()} ·{" "}
                    {item.frequencyPerYear}×/yr {item.isLifetime ? "× lifetime" : item.durationYears ? `× ${item.durationYears} yrs` : ""} · {item.probability.toLowerCase()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="num-metric text-sm">{money(item.presentValue)}</span>
                  <button className="btn-primary px-2.5 py-1 text-xs" disabled={busy === item.itemId} onClick={(e) => { e.stopPropagation(); disposition(item, "APPROVED"); }}>
                    {busy === item.itemId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve
                  </button>
                  <button className="btn-outline px-2.5 py-1 text-xs" onClick={(e) => { e.stopPropagation(); setExpanded(item.itemId); setModifying(item.itemId); }}>
                    <Pencil className="h-3.5 w-3.5" /> Modify
                  </button>
                  <button className="btn-outline px-2.5 py-1 text-xs text-red-700" disabled={busy === item.itemId} onClick={(e) => { e.stopPropagation(); disposition(item, "REJECTED"); }}>
                    <X className="h-3.5 w-3.5" /> Reject
                  </button>
                </div>
              </div>

              {(item.weakestDimensions.length > 0 || item.blockingFindings.length > 0) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {item.blockingFindings.map((f) => (
                    <span key={f} className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">{f}</span>
                  ))}
                  {item.weakestDimensions.map((d) => (
                    <span key={d.dimension} className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">
                      weakest: {d.dimension} {d.score}
                    </span>
                  ))}
                  {item.unknownCount > 0 && <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">{item.unknownCount} unknown{item.unknownCount === 1 ? "" : "s"}</span>}
                </div>
              )}

              {isOpen && (
                <div className="mt-3 border-t border-ink-100 pt-3 text-sm text-ink-700">
                  {item.necessityRationale ? (
                    <p className="text-[13px] leading-relaxed">{item.necessityRationale}</p>
                  ) : (
                    <p className="text-xs text-ink-500">No persisted assessment yet — run the pipeline, or open the case's Evidence Explorer for the full reasoning chain.</p>
                  )}
                  {item.sufficiency && item.sufficiency.missing.length > 0 && (
                    <div className="mt-2">
                      <p className="text-label">Missing evidence</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-ink-600">
                        {item.sufficiency.missing.map((m) => <li key={m}>{m}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2">
                    <Link href={`/cases/${item.caseId}`} className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
                      Open case workspace <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  {modifying === item.itemId && (
                    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
                      <textarea className="input h-16 w-full sm:w-96" placeholder="Physician note (required context for the modification)" value={note} onChange={(e) => setNote(e.target.value)} />
                      <div>
                        <label className="label">Frequency /yr</label>
                        <input type="number" step={0.5} className="input w-28" value={freq} onChange={(e) => setFreq(e.target.value === "" ? "" : Number(e.target.value))} />
                      </div>
                      <div>
                        <label className="label">Duration (yrs)</label>
                        <input type="number" step={0.5} className="input w-28" value={dur} onChange={(e) => setDur(e.target.value === "" ? "" : Number(e.target.value))} placeholder={item.isLifetime ? "lifetime" : ""} />
                      </div>
                      <button className="btn-primary py-1.5 text-sm" disabled={busy === item.itemId || !note.trim()} onClick={() => disposition(item, "MODIFIED")}>
                        Save modification
                      </button>
                      <button className="btn-ghost py-1.5 text-sm" onClick={() => { setModifying(null); setNote(""); setFreq(""); setDur(""); }}>Cancel</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
