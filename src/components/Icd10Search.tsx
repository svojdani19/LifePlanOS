"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X, Loader2, Check } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

interface Icd10Result {
  code: string;
  description: string;
}

/**
 * Strict ICD-10-CM diagnosis picker. The box is a KEYWORD SEARCH — as the user
 * types (lay terms are fine, e.g. "broken back", "knee replacement") it queries
 * /api/icd10 and lists matching codes. A diagnosis is only set by SELECTING a
 * result: free text is never committed, so every case carries a real ICD-10
 * code. Typing that isn't confirmed is discarded on blur.
 */
export function Icd10Search({
  value,
  code,
  onChange,
  disabled,
}: {
  value: string;
  code: string;
  onChange: (next: { diagnosis: string; icd10Code: string }) => void;
  disabled?: boolean;
}) {
  const committed = !!code && !!value; // a real code is linked
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Icd10Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // Keep the box in sync with the committed value (e.g. record-suggestion approvals).
  useEffect(() => setQuery(value), [value]);

  // Debounced keyword search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2 || (committed && q === value)) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/icd10?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (id === seq.current) {
          setResults(data.results ?? []);
          setSource(data.source ?? null);
          setActive(0);
        }
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, open, committed, value]);

  // Close on outside click and DISCARD any unconfirmed typing (no free text).
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value); // snap back to the committed selection (or empty)
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [value]);

  function select(r: Icd10Result) {
    onChange({ diagnosis: r.description, icd10Code: r.code });
    setQuery(r.description);
    setResults([]);
    setOpen(false);
  }

  function clear() {
    onChange({ diagnosis: "", icd10Code: "" });
    setQuery("");
    setResults([]);
    setOpen(true);
  }

  const showList = open && query.trim().length >= 2 && !(committed && query === value);

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          className="input pl-9 pr-24"
          disabled={disabled}
          value={query}
          placeholder="Search by keyword — e.g. broken back, knee replacement…"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            // Typing only drives the SEARCH — it never commits a diagnosis.
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!showList || results.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); select(results[active]); }
            else if (e.key === "Escape") { setOpen(false); setQuery(value); }
          }}
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-ink-400" />}
          {committed && query === value ? (
            <Badge tone="brand">{code}</Badge>
          ) : query.trim().length >= 2 ? (
            <Badge tone="amber">pick a code</Badge>
          ) : null}
          {(query || committed) && !disabled && (
            <button type="button" className="rounded p-0.5 text-ink-400 hover:bg-ink-100" title="Clear" onClick={clear}>
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {showList && (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-ink-200 bg-white shadow-card">
          {results.length === 0 && !loading && (
            <p className="px-3 py-3 text-sm text-ink-500">No ICD-10 match — try different keywords (e.g. a body part or the type of injury).</p>
          )}
          {results.map((r, i) => (
            <button
              key={r.code}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => select(r)}
              className={`flex w-full items-start gap-2 border-b border-ink-100 px-3 py-2 text-left last:border-0 ${i === active ? "bg-brand-50" : "hover:bg-brand-50"}`}
            >
              <span className="mt-0.5 shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-700">{r.code}</span>
              <span className="text-sm text-ink-800">{r.description}</span>
            </button>
          ))}
          {results.length > 0 && (
            <p className="px-3 py-1.5 text-[10px] text-ink-400">
              Select a code — free text is not accepted · {source === "nih" ? "ICD-10-CM · NIH Clinical Tables" : "ICD-10-CM · built-in reference set"}
            </p>
          )}
        </div>
      )}
      {committed && query === value && !disabled && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600"><Check className="h-3 w-3" /> ICD-10 code linked</p>
      )}
    </div>
  );
}
