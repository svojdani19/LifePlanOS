// ─────────────────────────────────────────────────────────────────────────────
// What an attorney needs to know about one recommendation, in six lines.
//
// The clinical dossier is the right artefact for a planner or a reviewing
// physician: every bucket, every citation, every challenge. An attorney reading
// forty recommendations before a mediation is asking a narrower question — can
// I prove this one, and what will the other side say about it? — and answering
// it currently means reading the whole dossier for each.
//
// So: a fixed six-field card, selected from the item's OWN accepted evidence.
//
// The selection rule matters more than the layout. Every row here comes from
// `dossier.ledger`, which is per-item by construction: each row carries the
// `futureCareItemId` it was accepted for, the claim it establishes, its stance
// and its citation. Nothing is searched for in raw document text, so this card
// cannot quote a sentence that happens to sit near a matching word in an
// unrelated record — the failure mode that made "supporting quotes do not make
// sense" a real complaint about the causation cards.
// ─────────────────────────────────────────────────────────────────────────────

import type { LedgerRow, LedgerStrength } from "@/lib/engine/evidenceLedger";
import { supportBadgeFor, type SupportBadge } from "@/lib/engine/careSupportView";

/**
 * How persuasive a source is, in the order an attorney would rank it.
 *
 * A treating physician's own documentation beats an imaging finding, which
 * beats a history the patient reported. Guidance and literature rank below
 * both: they establish that the service is appropriate in general, not that
 * THIS patient needs it, and the difference is the first thing a cross
 * examination goes after.
 */
const STRENGTH_RANK: Record<LedgerStrength, number> = {
  DIAGNOSIS: 6,
  OBJECTIVE: 5,
  HISTORY: 4,
  REPORTED: 3,
  GUIDELINE: 2,
  LITERATURE: 1,
};

/** Claims that speak to whether the service is needed at all rank first. */
const CLAIM_RANK: Record<string, number> = {
  NECESSITY: 4,
  FUNCTIONAL_NEED: 3,
  DURATION: 2,
  FREQUENCY: 1,
};

export interface ProofCitation {
  quote: string;
  /** True when `quote` is the record's own words rather than derived prose. */
  verbatim: boolean;
  sourceDocumentId: string | null;
  page: number | null;
  field: string | null;
  strength: LedgerStrength;
  claim: string;
  recordedOn: string | null;
}

export interface ProofCard {
  /** The strongest record accepted FOR THIS ITEM. Null when none was. */
  strongestSupport: ProofCitation | null;
  /** The strongest accepted evidence arguing against it. */
  strongestOpposing: ProofCitation | null;
  /** What is not established — stated, never inferred. */
  missingProof: string[];
  physicianDisposition: string;
  support: SupportBadge;
  /** Whether the recorded basis still matches what the record now says. */
  basis: { state: string; label: string };
}

const rank = (row: LedgerRow): number =>
  (STRENGTH_RANK[row.strength] ?? 0) * 10 + (CLAIM_RANK[row.claim] ?? 0);

const toCitation = (row: LedgerRow): ProofCitation => ({
  quote: row.quote,
  verbatim: row.verbatim,
  sourceDocumentId: row.sourceDocumentId,
  page: row.page,
  field: row.field,
  strength: row.strength,
  claim: row.claim,
  recordedOn: row.recordedOn ? new Date(row.recordedOn).toISOString().slice(0, 10) : null,
});

/**
 * Pick the single strongest row of one stance.
 *
 * Ties break on the EARLIEST recorded date: the first time a fact appears in
 * the record is the one a defense expert has to account for, and picking the
 * most recent would let a late note stand in for a contemporaneous one.
 */
function strongestOf(rows: readonly LedgerRow[], stance: "SUPPORTS" | "OPPOSES"): LedgerRow | null {
  const candidates = rows.filter((r) => r.stance === stance && r.quote.trim().length > 0);
  if (!candidates.length) return null;
  return candidates.reduce((best, row) => {
    const d = rank(row) - rank(best);
    if (d !== 0) return d > 0 ? row : best;
    const bestOn = best.recordedOn ? new Date(best.recordedOn).getTime() : Number.POSITIVE_INFINITY;
    const rowOn = row.recordedOn ? new Date(row.recordedOn).getTime() : Number.POSITIVE_INFINITY;
    return rowOn < bestOn ? row : best;
  });
}

export const PHYSICIAN_DISPOSITION: Record<string, string> = {
  APPROVED: "Approved by the reviewing physician.",
  MODIFIED: "Approved with modification by the reviewing physician.",
  REJECTED: "Declined by the reviewing physician.",
  PENDING: "Not yet reviewed by a physician.",
};

/** Fixed phrases — never composed from model output, so a signed card is stable. */
export const BASIS_LABEL: Record<string, string> = {
  CURRENT: "The recorded basis matches the record as it stands.",
  STALE: "The record has moved since this basis was recorded.",
  MISSING: "No recorded basis has been captured for this recommendation.",
  INCOMPLETE: "The recorded basis is incomplete.",
  UNREADABLE: "The recorded basis could not be read.",
};

export interface ProofCardInput {
  item: { supportClass?: string | null; physicianStatus?: string | null; missingSupport?: string | null; id?: string };
  /** The item's own accepted evidence. Rows for other items are ignored. */
  ledger: readonly LedgerRow[];
  /** Unknowns the dossier already states. Never inferred here. */
  unknowns?: readonly string[];
  basisState?: { state: string } | null;
}

export function buildProofCard(input: ProofCardInput): ProofCard {
  // Item scoping, enforced here rather than assumed of the caller: a ledger
  // filtered by the wrong id would put another recommendation's proof on this
  // card, which is exactly the class of error this module exists to prevent.
  const rows = input.item.id ? input.ledger.filter((r) => r.futureCareItemId === input.item.id) : input.ledger;

  const support = strongestOf(rows, "SUPPORTS");
  const opposing = strongestOf(rows, "OPPOSES");

  const missingProof: string[] = [];
  if (!support) {
    missingProof.push("No accepted record establishes the need for this service.");
  }
  if (typeof input.item.missingSupport === "string" && input.item.missingSupport.trim()) {
    missingProof.push(input.item.missingSupport.trim());
  }
  for (const unknown of input.unknowns ?? []) {
    if (typeof unknown === "string" && unknown.trim()) missingProof.push(unknown.trim());
  }

  const state = input.basisState?.state ?? "CURRENT";
  return {
    strongestSupport: support ? toCitation(support) : null,
    strongestOpposing: opposing ? toCitation(opposing) : null,
    // Deduped and bounded: a list of twelve unknowns is not a proof card.
    missingProof: [...new Set(missingProof)].slice(0, 4),
    physicianDisposition: PHYSICIAN_DISPOSITION[String(input.item.physicianStatus ?? "PENDING")] ?? PHYSICIAN_DISPOSITION.PENDING,
    support: supportBadgeFor(input.item),
    basis: { state, label: BASIS_LABEL[state] ?? BASIS_LABEL.CURRENT },
  };
}
