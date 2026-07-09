"use client";

import { useMemo, useState } from "react";
import { X, Search, Plus, Check, FileText } from "lucide-react";
import { PRE_EXISTING_GROUPS } from "@/lib/intake/preExisting";

/**
 * Pop-up multi-select for pre-existing conditions. The caller passes the current
 * selection and receives the new list on Save. "No known pre-existing
 * conditions" is a valid (mutually-exclusive) selection so the section can be
 * marked Complete even when the list is empty.
 */
export function PreExistingConditionsModal({
  initial,
  detectedInRecords = [],
  onClose,
  onSave,
  saving,
}: {
  initial: string[];
  detectedInRecords?: string[];
  onClose: () => void;
  onSave: (selected: string[], none: boolean) => void;
  saving?: boolean;
}) {
  const NONE = "No known pre-existing conditions";
  const detected = new Set(detectedInRecords);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const [none, setNone] = useState<boolean>(false);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  function toggle(c: string) {
    setNone(false);
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  }

  function addCustom() {
    const v = custom.trim();
    if (!v) return;
    setNone(false);
    setSelected((prev) => new Set(prev).add(v));
    setCustom("");
  }

  // Custom (user-added) selections not present in the catalog.
  const catalog = useMemo(() => new Set(PRE_EXISTING_GROUPS.flatMap((g) => g.conditions)), []);
  const customSelected = [...selected].filter((c) => !catalog.has(c));

  const q = query.trim().toLowerCase();
  const groups = PRE_EXISTING_GROUPS.map((g) => ({
    ...g,
    conditions: g.conditions.filter((c) => !q || c.toLowerCase().includes(q)),
  })).filter((g) => g.conditions.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onClick={onClose}>
      <div className="card flex max-h-[85vh] w-full max-w-2xl flex-col p-0" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-ink-900">Pre-Existing Conditions</h2>
            <p className="text-xs text-ink-500">Select all that apply, add any not listed, then save.</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-400 hover:bg-ink-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search + none */}
        <div className="border-b border-ink-100 px-6 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search conditions…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={none}
              onChange={(e) => {
                setNone(e.target.checked);
                if (e.target.checked) setSelected(new Set());
              }}
            />
            <span className="font-medium text-ink-800">{NONE}</span>
          </label>
        </div>

        {/* Records-detection legend */}
        {detected.size > 0 && !none && (
          <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-semibold">Highlighted</span> conditions ({detected.size}) were noted in the ingested medical records. Review and select those that apply.
            </span>
          </div>
        )}

        {/* Groups */}
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {none ? (
            <p className="py-8 text-center text-sm text-ink-500">Marked as no known pre-existing conditions.</p>
          ) : (
            <div className="space-y-5">
              {groups.map((g) => (
                <div key={g.group}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{g.group}</h3>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {g.conditions.map((c) => {
                      const on = selected.has(c);
                      const inRecords = detected.has(c);
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => toggle(c)}
                          className={
                            "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors " +
                            (on
                              ? "border-brand-400 bg-brand-50 text-brand-900"
                              : inRecords
                                ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                                : "border-ink-200 text-ink-700 hover:bg-ink-50")
                          }
                        >
                          <span className={"grid h-4 w-4 shrink-0 place-items-center rounded border " + (on ? "border-brand-500 bg-brand-500 text-white" : inRecords ? "border-amber-400" : "border-ink-300")}>
                            {on && <Check className="h-3 w-3" />}
                          </span>
                          <span className="flex-1">{c}</span>
                          {inRecords && <span className="shrink-0 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">in records</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {customSelected.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Added</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {customSelected.map((c) => (
                      <button key={c} type="button" onClick={() => toggle(c)} className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-xs text-brand-800">
                        {c} <X className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Add custom */}
              <div className="flex gap-2 pt-1">
                <input
                  className="input"
                  placeholder="Add another condition…"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
                />
                <button type="button" className="btn-outline" onClick={addCustom}>
                  <Plus className="h-4 w-4" /> Add
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-ink-200 px-6 py-4">
          <span className="text-sm text-ink-500">{none ? "None selected" : `${selected.size} selected`}</span>
          <div className="flex gap-2">
            <button className="btn-outline" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={saving} onClick={() => onSave([...selected], none)}>
              {saving ? "Saving…" : "Save Conditions"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
