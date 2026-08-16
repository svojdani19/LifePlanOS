"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Findings, shown once, at the scope they name.
//
// A case-level or document-level finding is not a defect in any one note, and
// copying it onto every note of a document is what made the review area
// unreadable. It belongs here: once, beside the thing it is about, with a way
// to answer it.
//
// Answering is a professional act, so the request carries the finding's own
// fingerprint AND the source state it was displayed over. The server refuses
// anything that moved in between rather than attaching a human decision to
// content nobody saw.
// ─────────────────────────────────────────────────────────────────────────────

export interface FindingView {
  id: string;
  scope: string;
  type: string;
  severity: string;
  blocking: boolean;
  source: string;
  detail: string;
  excerpt?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  status: string;
  fingerprint?: string | null;
  sourceFingerprint?: string | null;
}

export const FINDING_TYPE_LABEL: Record<string, string> = {
  MISSING_ENCOUNTER: "A note in the source produced no entry",
  SECTION_NOT_PROCESSED: "Part of this document was not read",
  DOCUMENT_EXTRACTION_FAILED: "This document could not be processed",
  DOCUMENT_NOT_PROCESSED: "This document has not been processed",
  SOURCE_CLIPPED: "The source text was clipped at the storage cap",
  PAGE_UNREADABLE: "This page could not be read",
  PAGE_LOW_CONFIDENCE: "Weak text recognition on this page",
  PAGE_TRUNCATED: "This page was truncated during processing",
  UNCLEAR_NOTE_BOUNDARY: "A note boundary could not be determined",
  DOCUMENTS_STILL_PROCESSING: "Not every document has finished processing",
};

/**
 * The same type means something different at case scope: the audit raises
 * DOCUMENT_EXTRACTION_FAILED both about one document and about "N documents
 * across this case", and calling the second one "this document" is wrong.
 */
const CASE_SCOPE_LABEL: Record<string, string> = {
  DOCUMENT_EXTRACTION_FAILED: "Documents in this case failed to process",
  SECTION_NOT_PROCESSED: "Part of the record was not read",
  MISSING_ENCOUNTER: "Notes in the source produced no entry",
};

const labelFor = (f: FindingView): string =>
  (f.scope === "CASE" ? CASE_SCOPE_LABEL[f.type] : undefined) ??
  FINDING_TYPE_LABEL[f.type] ??
  f.type.replace(/_/g, " ").toLowerCase();

const SOURCE_LABEL: Record<string, string> = {
  DETERMINISTIC_VALIDATOR: "deterministic check",
  EXTRACTION_CRITIC: "critic pass",
  ADJUDICATOR: "adjudicator",
  CORROBORATION: "blind second reading",
  OCR: "text recognition",
  PAGE_LEDGER: "page ledger",
  HUMAN_REVIEW: "a reviewer",
};

const pageLabel = (f: FindingView): string | null => {
  if (f.pageStart == null) return null;
  return f.pageEnd != null && f.pageEnd !== f.pageStart ? `pp. ${f.pageStart}–${f.pageEnd}` : `p. ${f.pageStart}`;
};

export function FindingList({
  caseId,
  findings,
  canDisposition,
  onChanged,
  emptyLabel,
}: {
  caseId: string;
  findings: FindingView[];
  canDisposition: boolean;
  onChanged: () => void;
  emptyLabel?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function disposition(f: FindingView, action: "confirm" | "dismiss" | "resolve", withReason?: string) {
    setBusy(f.id);
    setError(null);
    const res = await fetch(`/api/cases/${caseId}/records/findings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        findingId: f.id,
        action,
        expectedFingerprint: f.fingerprint,
        expectedSourceFingerprint: f.sourceFingerprint ?? null,
        ...(withReason ? { reason: withReason } : {}),
      }),
    }).catch(() => null);
    const out = (await res?.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    setReasonFor(null);
    setReason("");
    // A refused disposition changed nothing; say so rather than letting the
    // list look answered.
    if (!res || !res.ok) setError(out?.error ?? "The decision could not be applied; nothing was changed.");
    else onChanged();
  }

  if (!findings.length) {
    return emptyLabel ? <p className="text-[11px] text-ink-400">{emptyLabel}</p> : null;
  }

  return (
    <div className="space-y-1.5">
      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-800">
          <span className="font-medium">Nothing was changed.</span>
          <span>{error}</span>
          <button type="button" className="ml-auto underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {findings.map((f) => {
        const where = pageLabel(f);
        return (
          <div
            key={f.id}
            className={cn(
              "rounded border px-2 py-1.5 text-[11px]",
              f.blocking ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900",
            )}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{labelFor(f)}</span>
              {where && <span className="opacity-70">{where}</span>}
              {f.status === "CONFIRMED" && <span className="rounded-full bg-red-100 px-1.5 py-0.5 font-medium">Confirmed by a reviewer</span>}
              <span className="ml-auto opacity-60">
                {f.blocking ? "Blocks final export" : "Advisory"} · found by {SOURCE_LABEL[f.source] ?? f.source.toLowerCase()}
              </span>
            </div>
            <p className="mt-0.5">{f.detail}</p>
            {f.excerpt && <p className="mt-0.5 italic opacity-80">&ldquo;{f.excerpt}&rdquo;</p>}

            {canDisposition && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {f.status !== "CONFIRMED" && (
                  <button type="button" className="btn-ghost h-6 px-2 text-[11px]" disabled={busy === f.id} onClick={() => disposition(f, "confirm")}>
                    This is real
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost h-6 px-2 text-[11px]"
                  disabled={busy === f.id}
                  onClick={() => (f.blocking ? setReasonFor(reasonFor === `${f.id}:resolve` ? null : `${f.id}:resolve`) : disposition(f, "resolve"))}
                >
                  Resolved
                </button>
                <button
                  type="button"
                  className="btn-ghost h-6 px-2 text-[11px]"
                  disabled={busy === f.id}
                  onClick={() => (f.blocking ? setReasonFor(reasonFor === `${f.id}:dismiss` ? null : `${f.id}:dismiss`) : disposition(f, "dismiss"))}
                >
                  Not a problem
                </button>
              </div>
            )}
            {/* Closing a blocker is a judgement someone stands behind, so the
                reason is asked for here rather than refused by the server. */}
            {reasonFor?.startsWith(f.id) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <input
                  className="input h-7 flex-1 text-[11px]"
                  placeholder="Why is this no longer a problem? (required)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  aria-label="Reason for closing a blocking finding"
                />
                <button
                  type="button"
                  className="btn h-7 px-2 text-[11px]"
                  disabled={!reason.trim() || busy === f.id}
                  onClick={() => disposition(f, reasonFor.endsWith(":dismiss") ? "dismiss" : "resolve", reason.trim())}
                >
                  Record it
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The same list, folded. Document and page findings live inside their
 * document and should not be open by default — the point of scoping them was
 * to stop them shouting at every note.
 */
export function FoldedFindings({
  caseId,
  title,
  findings,
  canDisposition,
  onChanged,
}: {
  caseId: string;
  title: string;
  findings: FindingView[];
  canDisposition: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!findings.length) return null;
  const blocking = findings.filter((f) => f.blocking).length;
  return (
    <div className="mt-2 rounded border border-ink-100 bg-white">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px]"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="text-ink-400">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-ink-800">{title}</span>
        <span className="text-ink-500">
          {findings.length} finding{findings.length === 1 ? "" : "s"}
          {blocking > 0 && <span className="text-red-700"> · {blocking} blocks final export</span>}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-100 p-2">
          <FindingList caseId={caseId} findings={findings} canDisposition={canDisposition} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}
