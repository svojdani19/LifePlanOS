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
        (v as { text?: string }[] | string[]).map((x) => (typeof x === "string" ? x : String(x.text))).sort(),
      ]),
    ),
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
