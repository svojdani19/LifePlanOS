"use client";

import { FileText, ShieldCheck, ShieldAlert, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import type { ProofCard, ProofCitation } from "@/lib/engine/proofCard";

// ─────────────────────────────────────────────────────────────────────────────
// Six lines an attorney can act on, per recommendation.
//
// Deliberately NOT a raw clinical evidence workspace: the buckets, the
// literature, the guideline text and the challenge list stay in the dossier,
// where a planner and a reviewing physician work. This answers one question —
// can I prove this item, and what will the other side say — and it answers it
// from the item's OWN accepted evidence, never from a search across raw record
// text.
//
// Pricing is absent by construction: nothing here renders money, so the
// attorney redaction that hides figures elsewhere has nothing to hide here.
// ─────────────────────────────────────────────────────────────────────────────

function Citation({ citation, caseId }: { citation: ProofCitation; caseId: string }) {
  return (
    <>
      <p className="text-ink-800">
        {/* Verbatim record language is quoted; derived prose is not, because
            presenting the two identically misattributes the second. */}
        {citation.verbatim ? <>&ldquo;{citation.quote}&rdquo;</> : citation.quote}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-500">
        {citation.sourceDocumentId ? (
          <a
            href={`/api/cases/${caseId}/documents/${citation.sourceDocumentId}/view`}
            target="_blank"
            rel="noopener noreferrer"
            className="focusable inline-flex items-center gap-1 rounded font-medium text-brand-700 hover:underline"
          >
            <FileText aria-hidden="true" className="h-3 w-3 shrink-0" />
            Open the source record{citation.page != null ? `, p. ${citation.page}` : ""}
          </a>
        ) : (
          <span className="italic text-ink-400">No source document recorded.</span>
        )}
        {citation.recordedOn && <span>· {citation.recordedOn}</span>}
        {citation.field && <span>· {citation.field}</span>}
        <span>· {citation.strength.toLowerCase()}</span>
        {!citation.verbatim && <span className="text-ink-400">· summarised, not a direct quote</span>}
      </p>
    </>
  );
}

export function ProofCardView({ card, caseId }: { card: ProofCard; caseId: string }) {
  return (
    <section className="rounded-lg border border-ink-200 bg-ink-50/50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Proof</h4>
        <Badge tone={card.support.tone} title={card.support.title}>{card.support.short}</Badge>
        <Badge tone={card.support.membership === "SUPPORTED" ? "success" : "neutral"}>
          {card.support.membership === "SUPPORTED" ? "in the supported total" : "not in the supported total"}
        </Badge>
      </div>

      <div className="mt-2 space-y-2">
        <div>
          <p className="flex items-center gap-1 text-[11px] font-medium text-emerald-800">
            <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" /> Strongest support
          </p>
          <div className="mt-0.5 border-l-2 border-emerald-300 pl-2">
            {card.strongestSupport ? (
              <Citation citation={card.strongestSupport} caseId={caseId} />
            ) : (
              <p className="text-ink-500">No accepted record establishes the need for this service.</p>
            )}
          </div>
        </div>

        <div>
          <p className="flex items-center gap-1 text-[11px] font-medium text-amber-800">
            <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" /> Strongest contrary evidence
          </p>
          <div className="mt-0.5 border-l-2 border-amber-300 pl-2">
            {card.strongestOpposing ? (
              <Citation citation={card.strongestOpposing} caseId={caseId} />
            ) : (
              // Said explicitly. Silence here reads as "nothing to worry
              // about", and the absence of a search is not the absence of a
              // problem.
              <p className="text-ink-500">No accepted record in this case argues against it.</p>
            )}
          </div>
        </div>

        {card.missingProof.length > 0 && (
          <div>
            <p className="flex items-center gap-1 text-[11px] font-medium text-ink-600">
              <HelpCircle aria-hidden="true" className="h-3.5 w-3.5" /> Not established
            </p>
            <ul className="mt-0.5 space-y-0.5 border-l-2 border-ink-200 pl-2">
              {card.missingProof.map((m, i) => <li key={i} className="text-ink-700">{m}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-ink-200 pt-2 text-[11px] text-ink-600">
        <span><span className="font-medium">Physician:</span> {card.physicianDisposition}</span>
        <span className={cn(card.basis.state !== "CURRENT" && "text-amber-800")}>
          <span className="font-medium">Recorded basis:</span> {card.basis.label}
        </span>
      </div>
    </section>
  );
}
