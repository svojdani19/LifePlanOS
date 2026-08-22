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
import { supportClassOf, itemIsSupported } from "@/lib/engine/supportClass";
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

/**
 * The probability determination, as a MATERIAL part of the basis.
 *
 * "More likely than not" is a clinical and legal claim, not a rendering choice.
 * Treating it as presentation would let the classification flip — from a
 * reasonable possibility to a probability — without invalidating an approval
 * given on the other reading.
 *
 * The `statement` is generated prose ABOUT the classification and factors, so
 * it is stored for rendering and excluded from the hash: a reworded sentence is
 * stylistic, a changed classification or a changed factor is not.
 */
export interface ProbabilityBasis {
  classification: string;
  statement: string;
  factors: { label: string; present: boolean }[];
}

/**
 * Every input that can move a dollar or change a care claim.
 *
 * `ClaimBasis` recorded the KIND of each quantity's support and none of the
 * values, so the hash carried "frequency is an assumption" and not "four visits
 * a year". Changing four visits to six, or $300 to $500, left all three kinds
 * unchanged and the basis reported CURRENT — while `materialHash` in the
 * reasoning engine DID move, so the assessment staled and the export gate,
 * which reads the basis, did not. Split brain over exactly the numbers a
 * defence expert attacks.
 *
 * Chart amounts and market pricing are kept apart on purpose. A frequency the
 * treating record states is patient evidence; a fee-schedule figure is a
 * commercial input that happens to be attached to this patient.
 */
export interface ProjectionBasis {
  /** What the plan claims about the care itself. */
  frequencyPerYear: number | null;
  frequencyUnit: "per_year";
  durationYears: number | null;
  durationClass: "one_time" | "defined_course" | "lifetime";
  isLifetime: boolean;

  /** External market pricing — NOT a fact about this patient. */
  unitCost: number | null;
  pricingSourceCategory: "FEE_SCHEDULE" | "SURVEY" | "VENDOR" | "CASE_RECORD" | "UNKNOWN";
  pricingSourceId: string | null;
  /** When that price was retrieved, so a stale market figure is visible. */
  pricedAt: string | null;

  /** The projection assumptions that turn a unit cost into a lifetime figure. */
  horizonYears: number | null;
  discountRate: number | null;
  medicalInflation: number | null;
  geographicFactor: number | null;
}

/**
 * The exported specification table, as recorded.
 *
 * The report built this row-by-row from the LIVE item at export time and set it
 * beside a recorded narrative, so a document could state a recorded medical
 * necessity next to a frequency, cost and review status that had changed since.
 * Nothing warned the reader, because each half was internally consistent.
 */
export interface SpecificationBasis {
  service: string;
  supportingDiagnosis: string | null;
  responsibleSpecialty: string | null;
  frequencyText: string;
  durationText: string;
  lifetimeQuantity: number;
  cptCode: string | null;
  unitCost: number | null;
  lifetimeCost: number | null;
  presentValue: number | null;
  /** The physician-review disposition this basis was recorded under. */
  physicianStatus: string;
  recordSupported: boolean;
  contingencyOnly: boolean;
  startTrigger: string | null;
  prerequisite: string | null;
  earliestTiming: string | null;
  replacesService: string | null;
}

/**
 * The material and evidentiary conclusions of the clinical reasoning.
 *
 * Recorded because the panel and the report DISPLAY them. Before this, both
 * re-derived every one of these from whatever the record said at read time,
 * under a hash that claimed to certify them — so an approved recommendation
 * could show a different probability class, inclusion rationale, confidence or
 * duration verdict than the physician approved, with no divergence reported.
 *
 * Deliberately excluded, because they are live workflow state rather than
 * recorded conclusions: conflict flags (set context), physician review status
 * as a workflow position, validation status and lifecycle status. Those must
 * reflect the case as it stands now, and a change in them is caught by the
 * specification basis above rather than frozen here.
 */
export interface MaterialAssessment {
  probabilityClassification: string;
  inclusionRationale: string;
  inclusionInTotalsStatus: string;
  costEligibilityStatus: string;
  frequencyRationale: string;
  frequencySupported: boolean;
  durationClass: string;
  durationRationale: string;
  durationSupported: boolean;
  durationBasisLabel: string | null;
  evidenceStrength: string;
  recommendationConfidence: string;
  confidenceExplanation: string;
  residualUncertainty: string;
  medicalNecessityRationale: string;
  noTreatmentRisk: string;
  leastIntensiveRationale: string;
  timingRationale: string;
  clinicalPurpose: string;
  responsibleSpecialty: string;
  bodyRegion: string;
  laterality: string;
  conditionSeverity: string;
  conditionChronicity: string;
  currentClinicalStatus: string;
  conditionTrajectory: string;
  causalRelationshipStatus: string;
  clinicalPathway: string;
  clinicalPathwayStage: string | null;
  objectiveEvidenceSummary: string | null;
  subjectiveEvidenceSummary: string | null;
  functionalBasisSummary: string | null;
  priorTreatmentSummary: string | null;
  treatmentResponseSummary: string | null;
  treatingRecordSupportSummary: string | null;
  literatureSynthesis: string;
  alternativesConsidered: { alternative: string; rationale: string }[];
  supportingGuidelineAssessments: { title: string; claim: string }[];
  missingEvidenceRequests: string[];
  /** Defence challenges the report prints; recorded so they cannot re-derive. */
  potentialChallenges: string[];
  /** The documented limitation this care addresses, as recorded. */
  functionalBasis: { domain: string; limitation: string; source: string | null; quantified: boolean; relationship: string } | null;
  /** Clinical-confidence line the report prints. */
  confidenceLevel: string;
  confidenceLevelExplanation: string;
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
  /** The probability determination — material, versioned, hashed. */
  probabilityBasis: ProbabilityBasis;
  /** Every quantity and pricing input that can change dollars. */
  projectionBasis: ProjectionBasis;
  /** The exported specification table exactly as it stood when recorded. */
  specification: SpecificationBasis;
  /** The material/evidentiary conclusions the panel and report display. */
  assessmentBasis: MaterialAssessment | null;
  /** Evidentiary material the report must print without re-deriving it. */
  contradictions: string[];
  /** Citation identity for the literature the report renders. */
  literature: { title: string; journal: string | null; year: string | null; authors: string | null; pmid: string | null; doi: string | null; studyType: string; supports: string; limitations: string | null }[];
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
    // The classification and which factors are present are material. The
    // statement is prose generated FROM them, so rewording it is stylistic and
    // must not stale an approval.
    probability: [
      input.probabilityBasis.classification,
      ...input.probabilityBasis.factors.map((f) => `${f.label}=${f.present}`).sort(),
    ],
    // Every input that can move a dollar or change the care claim. The KINDS
    // above say where a quantity came from; these say what it IS.
    projection: [
      input.projectionBasis.frequencyPerYear, input.projectionBasis.frequencyUnit,
      input.projectionBasis.durationYears, input.projectionBasis.durationClass, input.projectionBasis.isLifetime,
      input.projectionBasis.unitCost, input.projectionBasis.pricingSourceCategory, input.projectionBasis.pricingSourceId,
      input.projectionBasis.pricedAt, input.projectionBasis.horizonYears,
      input.projectionBasis.discountRate, input.projectionBasis.medicalInflation, input.projectionBasis.geographicFactor,
    ],
    // The exported specification table. Every one of these prints on the face
    // of the report as a statement about this recommendation, so a change to
    // any of them is a change to what the document asserts.
    specification: [
      input.specification.service, input.specification.supportingDiagnosis, input.specification.responsibleSpecialty,
      input.specification.frequencyText, input.specification.durationText, input.specification.lifetimeQuantity,
      input.specification.cptCode, input.specification.unitCost, input.specification.lifetimeCost,
      input.specification.presentValue, input.specification.physicianStatus, input.specification.recordSupported,
      input.specification.contingencyOnly, input.specification.startTrigger, input.specification.prerequisite,
      input.specification.earliestTiming, input.specification.replacesService,
    ],
    // The material conclusions. Key-sorted so a field ADDED to the interface
    // changes the hash (the old basis genuinely no longer describes the new
    // claim set) while re-serialising an unchanged one does not.
    assessment: input.assessmentBasis
      ? Object.entries(input.assessmentBasis as unknown as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      : null,
    // Evidentiary material the report prints. Recorded so the report never has
    // to re-derive it, and hashed so it cannot drift unnoticed.
    contradictions: [...input.contradictions].sort(),
    literature: input.literature.map((l) => `${l.pmid ?? l.doi ?? l.title}|${l.supports}`).sort(),
    missing: [...input.missingPremises].sort(),
  };
  return `${BASIS_VERSION}:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").slice(0, 32)}`;
}

/** Assemble the basis for one item from its dossier and its persisted class. */
/**
 * Frequency and duration as the report prints them.
 *
 * These lived privately in report.ts, so the basis could only have recorded a
 * second formatting of the same numbers — and two formatters drift. One
 * definition, used by the recorder and the renderer alike.
 */
export function freqText(i: { frequencyPerYear: number; isLifetime: boolean; durationYears: number | null }): string {
  if (!i.isLifetime && (i.durationYears ?? 0) <= 0) return "one-time";
  return `${i.frequencyPerYear}× per year`;
}

export function durationText(i: { isLifetime: boolean; durationYears: number | null }, life: number): string {
  if (i.isLifetime) return `Lifetime (${life.toFixed(1)} yrs)`;
  if ((i.durationYears ?? 0) <= 0) return "One-time";
  return `${i.durationYears} year${i.durationYears === 1 ? "" : "s"}`;
}

export function buildBasis(
  item: DossierItem & { id?: string | null; lineageId?: string | null; supportClass?: string | null; supportReason?: string | null; pricedAt?: Date | string | null },
  dossier: RecommendationDossier,
  /**
   * The case's projection assumptions. Optional so a caller with none states
   * that explicitly and gets nulls, rather than a fabricated horizon — but
   * every production caller supplies them, because a lifetime figure computed
   * at 3% and one computed at 5% are different claims.
   */
  assumptions?: { lifeExpectancyYears?: number | null; discountRate?: number | null; medicalInflation?: number | null; geographicFactor?: number | null; pricedAt?: string | null; conditionName?: string | null } | null,
  /**
   * The material conclusions of the clinical reasoning for this item.
   *
   * Supplied by the caller rather than computed here, because the reasoning
   * engine imports this module and the dependency cannot run both ways. Every
   * production caller goes through `assembleBasis`, which derives it the one
   * way — so a witness rebuilt for staleness and the basis recorded at
   * generation cannot disagree about how it was produced.
   *
   * Null is honest, not a default: it records that no assessment was available,
   * and a consumer that needs one must treat the basis as unusable rather than
   * quietly re-deriving.
   */
  assessment?: MaterialAssessment | null,
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

  // Pricing provenance, categorised. A fee schedule, a cost survey and a vendor
  // quote are different kinds of authority, and none of them is a fact about
  // this patient — which is why they are recorded apart from the chart amounts.
  const src = String(item.pricingSource ?? "");
  const pricingSourceCategory: ProjectionBasis["pricingSourceCategory"] =
    /fee schedule|medicare|cms|cpt/i.test(src) ? "FEE_SCHEDULE"
    : /survey|genworth|fair ?health|costhelper/i.test(src) ? "SURVEY"
    : /vendor|quote|dme|rs medical|tenspros|rinella/i.test(src) ? "VENDOR"
    : /record|chart|billed/i.test(src) ? "CASE_RECORD"
    : src ? "UNKNOWN" : "UNKNOWN";

  const durationClass: ProjectionBasis["durationClass"] = item.isLifetime
    ? "lifetime"
    : (item.durationYears ?? 0) <= 1 ? "one_time" : "defined_course";

  const projectionBasis: ProjectionBasis = {
    frequencyPerYear: item.frequencyPerYear ?? null,
    frequencyUnit: "per_year",
    durationYears: item.durationYears ?? null,
    durationClass,
    isLifetime: !!item.isLifetime,
    unitCost: item.unitCost ?? null,
    pricingSourceCategory,
    pricingSourceId: item.pricingSource ?? null,
    pricedAt: assumptions?.pricedAt ?? null,
    horizonYears: item.isLifetime ? assumptions?.lifeExpectancyYears ?? null : item.durationYears ?? null,
    discountRate: assumptions?.discountRate ?? null,
    medicalInflation: assumptions?.medicalInflation ?? null,
    geographicFactor: assumptions?.geographicFactor ?? null,
  };

  const probabilityBasis: ProbabilityBasis = {
    classification: dossier.probability.classification,
    statement: dossier.probability.statement,
    factors: dossier.probability.factors.map((f) => ({ label: f.label, present: f.present })),
  };

  // The specification table as it stands at the moment of record. Derived here
  // rather than at export so the exported grid and the recorded basis are the
  // same object, not two readings that happen to agree.
  const years = item.isLifetime ? assumptions?.lifeExpectancyYears ?? 0 : item.durationYears ?? 0;
  const freq = item.frequencyPerYear ?? 0;
  const lifetimeQuantity = Math.round(freq * Math.max(0, years)) || (years === 0 ? 1 : 0);
  const it2 = item as unknown as {
    service: string; specialty?: string | null; cptCode?: string | null; lifetimeCost?: number | null;
    presentValue?: number | null; physicianStatus?: string | null; contingencyOnly?: boolean | null;
    startTrigger?: string | null; prerequisite?: string | null; earliestTiming?: string | null; replacesService?: string | null;
  };
  const specification: SpecificationBasis = {
    service: String(it2.service ?? ""),
    supportingDiagnosis: assumptions?.conditionName ?? null,
    responsibleSpecialty: it2.specialty ?? null,
    frequencyText: freqText({ frequencyPerYear: freq, isLifetime: !!item.isLifetime, durationYears: item.durationYears ?? null }),
    durationText: durationText({ isLifetime: !!item.isLifetime, durationYears: item.durationYears ?? null }, assumptions?.lifeExpectancyYears ?? 0),
    lifetimeQuantity,
    cptCode: it2.cptCode ?? null,
    unitCost: item.unitCost ?? null,
    lifetimeCost: it2.lifetimeCost ?? null,
    presentValue: it2.presentValue ?? null,
    physicianStatus: String(it2.physicianStatus ?? "PENDING"),
    recordSupported: itemIsSupported(item as { supportClass?: string | null }),
    contingencyOnly: !!it2.contingencyOnly,
    startTrigger: it2.startTrigger ?? null,
    prerequisite: it2.prerequisite ?? null,
    earliestTiming: it2.earliestTiming ?? null,
    replacesService: it2.replacesService ?? null,
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
    probabilityBasis,
    projectionBasis,
    specification,
    assessmentBasis: assessment ?? null,
    contradictions: dossier.contradictoryEvidence.map((c) => String(c).replace(/\s+/g, " ").trim()),
    literature: dossier.literature.map((l) => ({
      title: l.title, journal: l.journal ?? null, year: l.year ?? null, authors: l.authors ?? null,
      pmid: l.pmid ?? null, doi: l.doi ?? null, studyType: l.studyType, supports: l.supports, limitations: l.limitations ?? null,
    })),
    missingPremises: dossier.unknowns.map((u) => String(u)),
  };
  return {
    ...core,
    necessityNarrative: dossier.medicalNecessity,
    producerVersion: BASIS_VERSION,
    basisHash: basisHash(core),
  };
}

/**
 * The hashable core of a basis.
 *
 * One definition, because every caller that needed to re-hash a modified basis
 * was hand-assembling this object — so each new material field silently left
 * those call sites hashing an older shape until the compiler caught them.
 */
export const hashableCore = (b: BasisRecord): Omit<BasisRecord, "basisHash" | "necessityNarrative" | "producerVersion"> => ({
  futureCareItemId: b.futureCareItemId,
  lineageId: b.lineageId,
  interventionId: b.interventionId,
  serviceFamily: b.serviceFamily,
  conditionId: b.conditionId,
  bodyRegion: b.bodyRegion,
  spinalLevels: b.spinalLevels,
  laterality: b.laterality,
  supportClass: b.supportClass,
  supportReason: b.supportReason,
  acceptedEvidence: b.acceptedEvidence,
  evidenceProvenance: b.evidenceProvenance,
  claimBasis: b.claimBasis,
  probabilityBasis: b.probabilityBasis,
  projectionBasis: b.projectionBasis,
  specification: b.specification,
  assessmentBasis: b.assessmentBasis,
  contradictions: b.contradictions,
  literature: b.literature,
  missingPremises: b.missingPremises,
});

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
