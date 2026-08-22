// ─────────────────────────────────────────────────────────────────────────────
// Build the basis once; let every consumer read the same one.
//
// Five places call `buildRecommendationDossier()` independently — the panel,
// the report, validation, clinical reasoning, the generator. They agree today
// only because their inputs were forced to agree, one bug at a time: an
// unordered condition query made the panel and the ledger argue about a
// cervical versus a lumbar diagnosis; an unordered chronology read made the
// per-claim cap keep a different twelve on each run.
//
// Each of those was fixed by making the INPUTS match. That is the fragile
// version of this guarantee: it holds until someone adds a sixth call site with
// a sixth query. The durable version is to compute the basis once, hash it, and
// have readers compare.
//
// The comparison matters as much as the record. A reader that silently prefers
// its own recomputation is back where it started; a reader that silently trusts
// a stale basis prints last week's evidence. So `compareBasis` reports, and a
// person decides — the same discipline the evidence ledger already uses.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { resolveIntervention } from "@/lib/engine/serviceOntology";
import { supportClassOf } from "@/lib/engine/supportClass";
import type { RecommendationDossier, DossierItem } from "@/lib/engine/medicalNecessity";

export const BASIS_VERSION = "basis-1";

/** The evidence a basis accepts, by the role it plays. */
export interface AcceptedEvidence {
  diagnoses: { text: string; source: string | null }[];
  objectiveFindings: { text: string; source: string | null }[];
  functionalLimitations: { text: string; source: string | null }[];
  priorTreatment: { text: string; source: string | null }[];
  guidelines: { text: string; source: string | null }[];
  contrary: string[];
}

/**
 * The provenance of one accepted evidence row, as the hash sees it.
 *
 * The first version hashed the displayed TEXT and dropped everything else, so
 * the source document, the page, the provider, the stance and the extraction
 * fingerprint could all change while the basis kept reporting CURRENT. A
 * citation whose attribution silently moves is worse than a missing one: the
 * quote still reads true and now points somewhere else.
 */
export interface EvidenceProvenance {
  claim: string;
  stance: string;
  strength: string;
  sourceKind: string;
  documentId: string | null;
  encounterId: string | null;
  chronologyEventId: string | null;
  page: number | null;
  field: string | null;
  verbatim: boolean;
  sourceFingerprint: string | null;
  /** sha256 of the exact accepted excerpt. */
  textHash: string;
}

/**
 * Where a QUANTITY comes from — separately from where the service comes from.
 *
 * "Why this service?" and "why this frequency, for this long, at this price?"
 * are different claims, and a life care plan is challenged on the second at
 * least as often as the first. The schema had the column and generation left it
 * null, so the supposedly authoritative basis was silent on three of the four
 * things a defence expert asks about.
 */
export interface ClaimBasis {
  /** RECORD: the chart states it. GUIDELINE: cited guidance states it.
   *  PROFESSIONAL: a reviewer set it. ASSUMPTION: a planning convention. */
  kind: "RECORD" | "GUIDELINE" | "PROFESSIONAL" | "ASSUMPTION";
  statement: string;
}

export interface BasisRecord {
  futureCareItemId: string;
  lineageId: string | null;
  interventionId: string;
  serviceFamily: string;
  conditionId: string | null;
  bodyRegion: string | null;
  spinalLevels: string[];
  laterality: string | null;
  supportClass: string;
  supportReason: string | null;
  acceptedEvidence: AcceptedEvidence;
  /** Full provenance for every accepted row — hashed, not merely displayed. */
  evidenceProvenance: EvidenceProvenance[];
  /** Frequency, duration and cost, each with its own basis. */
  claimBasis: { frequency: ClaimBasis; duration: ClaimBasis; cost: ClaimBasis };
  missingPremises: string[];
  necessityNarrative: string;
  producerVersion: string;
  basisHash: string;
}

const clean = (xs: { text: string; source?: string | null }[]) =>
  xs.map((x) => ({ text: String(x.text).replace(/\s+/g, " ").trim(), source: x.source ?? null }));

/**
 * The hash that decides staleness.
 *
 * Over the ACCEPTED EVIDENCE and the structural facts — not over the narrative,
 * which is derived from them. A wording change must not stale every basis in
 * the system; a change to the evidence must stale exactly the ones affected.
 * Key-sorted and order-independent so re-persisting the same basis is not a
 * change.
 */
export function basisHash(input: Omit<BasisRecord, "basisHash" | "necessityNarrative" | "producerVersion">): string {
  const canonical = {
    intervention: input.interventionId,
    family: input.serviceFamily,
    condition: input.conditionId,
    region: input.bodyRegion,
    levels: [...input.spinalLevels].sort(),
    laterality: input.laterality,
    supportClass: input.supportClass,
    evidence: Object.fromEntries(
      Object.entries(input.acceptedEvidence).map(([k, v]) => [
        k,
        // The SOURCE travels with the text. Hashing the quote alone let the
        // file, page and provider beside it change without invalidating
        // anything.
        (v as { text?: string; source?: string | null }[] | string[])
          .map((x) => (typeof x === "string" ? x : `${x.text}\u0000${x.source ?? ""}`))
          .sort(),
      ]),
    ),
    // And the full citation identity of every accepted row: document, encounter,
    // chronology event, page, field, stance, verbatim status and the
    // fingerprint of the source text at extraction.
    provenance: input.evidenceProvenance
      .map((p) =>
        [p.claim, p.stance, p.strength, p.sourceKind, p.documentId, p.encounterId, p.chronologyEventId, p.page, p.field, p.verbatim, p.sourceFingerprint, p.textHash].join("|"),
      )
      .sort(),
    // A quantity moving from RECORD to ASSUMPTION changes what the plan claims
    // about it, so it is material.
    claims: [input.claimBasis.frequency.kind, input.claimBasis.duration.kind, input.claimBasis.cost.kind],
    missing: [...input.missingPremises].sort(),
  };
  return `${BASIS_VERSION}:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").slice(0, 32)}`;
}

/** Assemble the basis for one item from its dossier and its persisted class. */
export function buildBasis(
  item: DossierItem & { id?: string | null; lineageId?: string | null; supportClass?: string | null; supportReason?: string | null },
  dossier: RecommendationDossier,
): BasisRecord {
  const r = resolveIntervention(item as { service: string; category?: string | null });
  const se = dossier.supportingEvidence;
  const acceptedEvidence: AcceptedEvidence = {
    // Only ITEM-scoped evidence is accepted as support. Condition background is
    // deliberately absent: it is shown on the panel and it is not what the
    // recommendation rests on.
    diagnoses: clean(se.diagnoses.filter((d) => d.scope !== "CONDITION")),
    objectiveFindings: clean([...se.objectiveFindings, ...se.imaging, ...se.examination].filter((d) => d.scope !== "CONDITION")),
    functionalLimitations: clean(se.functionalLimitations),
    priorTreatment: clean(se.priorTreatment),
    guidelines: clean(se.guidelines),
    contrary: dossier.contradictoryEvidence.map((c) => String(c).replace(/\s+/g, " ").trim()),
  };
  const evidenceProvenance: EvidenceProvenance[] = (dossier.ledger ?? []).map((r) => ({
    claim: String(r.claim),
    stance: String(r.stance),
    strength: String(r.strength),
    sourceKind: String(r.sourceKind),
    documentId: r.sourceDocumentId ?? null,
    encounterId: r.encounterId ?? null,
    chronologyEventId: r.chronologyEventId ?? null,
    page: r.page ?? null,
    field: r.field ?? null,
    verbatim: !!r.verbatim,
    sourceFingerprint: r.sourceFingerprint ?? null,
    textHash: createHash("sha256").update(String(r.quote).replace(/\s+/g, " ").trim(), "utf8").digest("hex").slice(0, 16),
  }));

  // Each quantity's basis, read from the evidence that actually speaks to it.
  // A ledger row only carries a FREQUENCY or DURATION claim when its text
  // stated a cadence or a span — the semantic gate guarantees that — so their
  // presence is exactly the right test.
  const claims = new Set((dossier.ledger ?? []).map((r) => String(r.claim)));
  const quantityBasis = (claim: string, what: string): ClaimBasis =>
    claims.has(claim)
      ? { kind: "RECORD", statement: `The record states ${what} for this service.` }
      : { kind: "ASSUMPTION", statement: `No source states ${what}; the projected value is a planning assumption pending review.` };
  const claimBasis = {
    frequency: quantityBasis("FREQUENCY", "a cadence"),
    duration: quantityBasis("DURATION", "a duration"),
    // Cost is priced from a fee schedule or a survey, never from the clinical
    // record — so it is an assumption unless a COST row exists.
    cost: claims.has("COST")
      ? ({ kind: "RECORD", statement: "A billed amount or fee-schedule figure is documented for this service." } as ClaimBasis)
      : ({ kind: "ASSUMPTION", statement: `Priced from ${item.pricingSource ?? "the configured pricing source"}; no case-specific cost is documented.` } as ClaimBasis),
  };

  const core = {
    futureCareItemId: String(item.id ?? ""),
    lineageId: item.lineageId ?? null,
    interventionId: r.id,
    serviceFamily: r.family,
    conditionId: (item as { conditionId?: string | null }).conditionId ?? null,
    bodyRegion: r.region,
    spinalLevels: r.spinalLevels,
    laterality: r.laterality,
    supportClass: supportClassOf(item as { supportClass?: string | null }),
    supportReason: item.supportReason ?? null,
    acceptedEvidence,
    evidenceProvenance,
    claimBasis,
    missingPremises: dossier.unknowns.map((u) => String(u)),
  };
  return {
    ...core,
    necessityNarrative: dossier.medicalNecessity,
    producerVersion: BASIS_VERSION,
    basisHash: basisHash(core),
  };
}

export type BasisState = "CURRENT" | "STALE" | "MISSING";

export interface BasisComparison {
  state: BasisState;
  storedHash: string | null;
  derivedHash: string;
  /** What a reader is told. Null when current. */
  notice: string | null;
}

/**
 * Compare a stored basis against what this consumer would derive now.
 *
 * Neither side wins automatically. A stored basis that no longer matches the
 * record is not obviously wrong — the record may have changed since a physician
 * approved it, which is precisely the thing a reviewer needs told rather than
 * resolved.
 */
export function compareBasis(stored: { basisHash?: string | null } | null, derived: BasisRecord): BasisComparison {
  if (!stored?.basisHash) {
    return {
      state: "MISSING",
      storedHash: null,
      derivedHash: derived.basisHash,
      notice: "No basis has been recorded for this recommendation. What is shown is derived from the record as it stands now; regenerate the plan to record it.",
    };
  }
  if (stored.basisHash === derived.basisHash) {
    return { state: "CURRENT", storedHash: stored.basisHash, derivedHash: derived.basisHash, notice: null };
  }
  return {
    state: "STALE",
    storedHash: stored.basisHash,
    derivedHash: derived.basisHash,
    notice: "The recorded basis for this recommendation no longer matches the record. The recorded basis is shown; regenerate the plan to bring it current.",
  };
}
