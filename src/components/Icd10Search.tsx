"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

interface Icd10Result {
  code: string;
  description: string;
}

/**
 * ICD-10-CM diagnosis search. As the user types it queries /api/icd10 (NIH
 * Clinical Tables, with a curated offline fallback) and shows the most relevant
 * clinical diagnoses. Selecting one sets both the description and the code.
 * Free text is still allowed for diagnoses without a clean code.
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
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Icd10Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => setQuery(value), [value]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
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
        }
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, open]);

  // Close on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function select(r: Icd10Result) {
    onChange({ diagnosis: r.description, icd10Code: r.code });
    setQuery(r.description);
    setOpen(false);
  }

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          className="input pl-9 pr-24"
          disabled={disabled}
          value={query}
          placeholder="Search ICD-10 diagnoses…"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // Typing free text detaches any previously-linked code.
            onChange({ diagnosis: e.target.value, icd10Code: "" });
          }}
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-ink-400" />}
          {code ? <Badge tone="brand">{code}</Badge> : query.trim().length > 0 ? <Badge tone="amber">no code</Badge> : null}
          {(query || code) && !disabled && (
            <button
              type="button"
              className="rounded p-0.5 text-ink-400 hover:bg-ink-100"
              onClick={() => {
                setQuery("");
                onChange({ diagnosis: "", icd10Code: "" });
                setResults([]);
              }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {open && query.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-ink-200 bg-white shadow-card">
          {results.length === 0 && !loading && (
            <p className="px-3 py-3 text-sm text-ink-500">No matching ICD-10 codes. You can keep the text as a free-form diagnosis.</p>
          )}
          {results.map((r) => (
            <button
              key={r.code}
              type="button"
              onClick={() => select(r)}
              className="flex w-full items-start gap-2 border-b border-ink-100 px-3 py-2 text-left last:border-0 hover:bg-brand-50"
            >
              <span className="mt-0.5 shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-700">{r.code}</span>
              <span className="text-sm text-ink-800">{r.description}</span>
            </button>
          ))}
          {results.length > 0 && (
            <p className="px-3 py-1.5 text-[10px] text-ink-400">
              {source === "nih" ? "ICD-10-CM · NIH Clinical Tables" : "ICD-10-CM · built-in reference set"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
