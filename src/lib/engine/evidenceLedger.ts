// ─────────────────────────────────────────────────────────────────────────────
// Does this evidence support THIS service's THIS claim?
//
// The old question was "does this evidence concern the diagnosis" —
// `eventPertains()` matching a chronology event by body region or by any word
// of the diagnosis name. That is a good ANATOMY gate and it is not a relevance
// gate. Physical therapy, an MRI, an injection, a medication and a fusion for
// one lumbar diagnosis all passed it identically, so the panel for each showed
// the same findings and implied each was supported by them.
//
// Two things are separated here that were previously one:
//
//   ANATOMY — is this the right body part? (already solid: region, spinal
//   level, laterality, joint sub-structure — reused unchanged.)
//
//   SERVICE COMPATIBILITY — does a finding of this KIND bear on a service of
//   this KIND, for the claim being made? An imaging study supports the
//   necessity of imaging and the planning of surgery; it does not by itself
//   support how often a medication should be taken.
//
// And each surviving row records WHICH claim it supports and in which
// DIRECTION, because "no evidence for" and "evidence against" are different
// facts and were being shown as the same one.
// ─────────────────────────────────────────────────────────────────────────────

import { assertionSupportsClaim, classifyAssertion, type AssertionProfile } from "@/lib/engine/assertionClassifier";

export const EVIDENCE_LEDGER_VERSION = "2026-08-18.semantic";

/** What a piece of evidence is being offered to establish. */
export type EvidenceClaim =
  /** That this intervention is appropriate for this patient at all. */
  | "NECESSITY"
  /** How often it is needed. */
  | "FREQUENCY"
  /** For how long. */
  | "DURATION"
  /** That a functional deficit this service addresses is documented. */
  | "FUNCTIONAL_NEED"
  /** What was already tried, and what happened. */
  | "PRIOR_TREATMENT"
  /** What it costs. */
  | "COST";

export const EVIDENCE_CLAIMS: readonly EvidenceClaim[] = [
  "NECESSITY",
  "FREQUENCY",
  "DURATION",
  "FUNCTIONAL_NEED",
  "PRIOR_TREATMENT",
  "COST",
];

/** Which way it cuts. Absence of support is neither of these — it is silence. */
export type EvidenceStance = "SUPPORTS" | "OPPOSES" | "CONTEXT";

/** How strong the source is, reusing the causation grading vocabulary. */
export type LedgerStrength = "DIAGNOSIS" | "OBJECTIVE" | "HISTORY" | "REPORTED" | "GUIDELINE" | "LITERATURE";

/**
 * The kind of clinical thing a service IS — coarse on purpose. Compatibility
 * is judged between kinds, not between service names, so a new service name
 * inherits sane behaviour instead of falling through a lookup.
 */
export type ServiceKind =
  | "IMAGING"
  | "SURGERY"
  | "INJECTION"
  | "THERAPY"
  | "MEDICATION"
  | "EVALUATION"
  | "EQUIPMENT"
  | "ATTENDANT_CARE"
  | "OTHER";

const KIND_BY_CATEGORY: Record<string, ServiceKind> = {
  IMAGING: "IMAGING",
  LABS: "IMAGING",
  ORTHOPEDIC_SURGERY: "SURGERY",
  NEUROSURGERY: "SURGERY",
  FUTURE_SURGERY: "SURGERY",
  REVISION_SURGERY: "SURGERY",
  INJECTION: "INJECTION",
  PAIN_MANAGEMENT: "INJECTION",
  PHYSICAL_THERAPY: "THERAPY",
  OCCUPATIONAL_THERAPY: "THERAPY",
  SPEECH_THERAPY: "THERAPY",
  COGNITIVE_THERAPY: "THERAPY",
  PSYCH: "THERAPY",
  MEDICATION: "MEDICATION",
  PHYSICIAN_VISIT: "EVALUATION",
  SPECIALIST_VISIT: "EVALUATION",
  PRIMARY_CARE: "EVALUATION",
  NEUROLOGY: "EVALUATION",
  PMR: "EVALUATION",
  DME: "EQUIPMENT",
  MOBILITY_AID: "EQUIPMENT",
  HOME_MODIFICATION: "EQUIPMENT",
  ORTHOTICS_PROSTHETICS: "EQUIPMENT",
  ATTENDANT_CARE: "ATTENDANT_CARE",
  SKILLED_NURSING: "ATTENDANT_CARE",
};

/**
 * Service-name fallbacks for a row whose category says nothing useful.
 *
 * Every noun here is written plural-tolerant. It matters more than it looks:
 * "Injections 3 times per year" did not match `\binjection\b`, because the
 * closing boundary fell between the "n" and the "s" — so a record stating an
 * injection cadence classified as OTHER, and the service match that grounds a
 * frequency claim silently failed.
 */
const KIND_BY_NAME: [RegExp, ServiceKind][] = [
  [/\b(mri|ct\b|x-?rays?|radiographs?|ultrasounds?|imaging|scans?)\b/i, "IMAGING"],
  [/\b(fusions?|arthroplast(?:y|ies)|replacements?|decompressions?|laminectom(?:y|ies)|discectom(?:y|ies)|surger|operative)\b/i, "SURGERY"],
  [/\b(injections?|epidurals?|blocks?|ablations?|rhizotom(?:y|ies)|infusions?)\b/i, "INJECTION"],
  [/\b(therap(?:y|ies)|rehabilitation|rehab|conditioning|restoration)\b/i, "THERAPY"],
  [/\b(medications?|drugs?|analgesics?|opioids?|gabapentin|pharmac)\b/i, "MEDICATION"],
  [/\b(visits?|consultations?|evaluations?|follow-?ups?|assessments?)\b/i, "EVALUATION"],
  [/\b(wheelchairs?|walkers?|braces?|orthoses|orthosis|prosthes|equipment|units?|supplies)\b/i, "EQUIPMENT"],
  [/\b(attendant|caregivers?|nursing|aides?|home health)\b/i, "ATTENDANT_CARE"],
];

export function serviceKindOf(item: { service: string; category?: string | null }): ServiceKind {
  const byCategory = KIND_BY_CATEGORY[(item.category ?? "").toUpperCase()];
  if (byCategory) return byCategory;
  for (const [re, kind] of KIND_BY_NAME) if (re.test(item.service)) return kind;
  return "OTHER";
}

/**
 * Which evidence strengths can establish which claim, for which service kind.
 *
 * The rules are deliberately conservative — an entry missing here means "this
 * source cannot establish that claim", which understates rather than
 * overstates. Two that matter:
 *
 *   • NOTHING except a GUIDELINE, a record-stated cadence or a physician
 *     establishes FREQUENCY or DURATION. An imaging study proves a finding; it
 *     says nothing about how often to repeat it.
 *
 *   • A REPORTED symptom can establish a FUNCTIONAL_NEED for any service, but
 *     never the NECESSITY of surgery, imaging or an injection. A patient's
 *     account is good evidence of a deficit and poor evidence of pathology.
 */
const COMPATIBLE: Record<EvidenceClaim, Partial<Record<ServiceKind, readonly LedgerStrength[]>>> = {
  NECESSITY: {
    IMAGING: ["DIAGNOSIS", "OBJECTIVE", "GUIDELINE", "LITERATURE"],
    SURGERY: ["DIAGNOSIS", "OBJECTIVE", "GUIDELINE", "LITERATURE"],
    INJECTION: ["DIAGNOSIS", "OBJECTIVE", "GUIDELINE", "LITERATURE"],
    THERAPY: ["DIAGNOSIS", "OBJECTIVE", "REPORTED", "GUIDELINE", "LITERATURE"],
    MEDICATION: ["DIAGNOSIS", "OBJECTIVE", "REPORTED", "GUIDELINE", "LITERATURE"],
    EVALUATION: ["DIAGNOSIS", "OBJECTIVE", "GUIDELINE", "LITERATURE"],
    EQUIPMENT: ["DIAGNOSIS", "OBJECTIVE", "REPORTED", "GUIDELINE", "LITERATURE"],
    ATTENDANT_CARE: ["DIAGNOSIS", "OBJECTIVE", "REPORTED", "GUIDELINE", "LITERATURE"],
    OTHER: ["DIAGNOSIS", "OBJECTIVE", "GUIDELINE", "LITERATURE"],
  },
  // A cadence has to be stated by something that states cadences.
  FREQUENCY: {
    IMAGING: ["GUIDELINE", "LITERATURE"],
    SURGERY: ["GUIDELINE", "LITERATURE"],
    INJECTION: ["GUIDELINE", "LITERATURE"],
    THERAPY: ["GUIDELINE", "LITERATURE"],
    MEDICATION: ["GUIDELINE", "LITERATURE"],
    EVALUATION: ["GUIDELINE", "LITERATURE"],
    EQUIPMENT: ["GUIDELINE", "LITERATURE"],
    ATTENDANT_CARE: ["GUIDELINE", "LITERATURE"],
    OTHER: ["GUIDELINE", "LITERATURE"],
  },
  DURATION: {
    IMAGING: ["GUIDELINE", "LITERATURE"],
    SURGERY: ["GUIDELINE", "LITERATURE"],
    INJECTION: ["GUIDELINE", "LITERATURE"],
    THERAPY: ["GUIDELINE", "LITERATURE"],
    MEDICATION: ["GUIDELINE", "LITERATURE"],
    EVALUATION: ["GUIDELINE", "LITERATURE"],
    EQUIPMENT: ["GUIDELINE", "LITERATURE"],
    ATTENDANT_CARE: ["GUIDELINE", "LITERATURE"],
    OTHER: ["GUIDELINE", "LITERATURE"],
  },
  // A documented functional deficit bears on every service — including
  // surgery, where impaired function is a primary indication. An arthroplasty
  // is offered BECAUSE the knee gives out on stairs, and patient-reported
  // function is standard input to that decision (KOOS, WOMAC, Oxford).
  //
  // An earlier draft of this table excluded REPORTED for surgery, reasoning
  // that a patient's account should not drive an operation. That confused two
  // claims: a report is good evidence of a DEFICIT and poor evidence of
  // PATHOLOGY. NECESSITY above already refuses REPORTED for surgery, imaging
  // and injections, which is where the guarantee belongs; deleting the
  // functional evidence as well removed something clinically load-bearing.
  FUNCTIONAL_NEED: {
    THERAPY: ["OBJECTIVE", "REPORTED"],
    EQUIPMENT: ["OBJECTIVE", "REPORTED"],
    ATTENDANT_CARE: ["OBJECTIVE", "REPORTED"],
    EVALUATION: ["OBJECTIVE", "REPORTED"],
    SURGERY: ["OBJECTIVE", "REPORTED"],
    INJECTION: ["OBJECTIVE", "REPORTED"],
    MEDICATION: ["OBJECTIVE", "REPORTED"],
    IMAGING: ["OBJECTIVE"],
    OTHER: ["OBJECTIVE", "REPORTED"],
  },
  PRIOR_TREATMENT: {
    IMAGING: ["OBJECTIVE", "HISTORY"],
    SURGERY: ["OBJECTIVE", "HISTORY"],
    INJECTION: ["OBJECTIVE", "HISTORY"],
    THERAPY: ["OBJECTIVE", "HISTORY"],
    MEDICATION: ["OBJECTIVE", "HISTORY"],
    EVALUATION: ["OBJECTIVE", "HISTORY"],
    EQUIPMENT: ["OBJECTIVE", "HISTORY"],
    ATTENDANT_CARE: ["OBJECTIVE", "HISTORY"],
    OTHER: ["OBJECTIVE", "HISTORY"],
  },
  COST: {},
};

/**
 * May a source of this strength establish this claim for this service?
 *
 * This is the gate that did not exist. Anatomy is checked separately and
 * first — passing this without passing that means the evidence is the right
 * KIND about the wrong BODY PART.
 */
export function supportsClaim(kind: ServiceKind, claim: EvidenceClaim, strength: LedgerStrength): boolean {
  const allowed = COMPATIBLE[claim][kind];
  return !!allowed && allowed.includes(strength);
}

/** Every claim a source of this strength could establish for this service. */
export function claimsSupportedBy(kind: ServiceKind, strength: LedgerStrength): EvidenceClaim[] {
  return EVIDENCE_CLAIMS.filter((claim) => supportsClaim(kind, claim, strength));
}

export interface LedgerRow {
  futureCareItemId: string;
  conditionId: string | null;
  claim: EvidenceClaim;
  stance: EvidenceStance;
  strength: LedgerStrength;
  sourceKind: "RECORD_CLAIM" | "CHRONOLOGY_EVENT" | "GUIDELINE" | "LITERATURE" | "INTERVIEW" | "PHYSICIAN";
  sourceDocumentId: string | null;
  encounterId: string | null;
  chronologyEventId: string | null;
  page: number | null;
  field: string | null;
  quote: string;
  recordedOn: Date | null;
  sourceFingerprint: string | null;
  /**
   * True when `quote` is the record's own words. Chronology narrative fields
   * are the extraction's PROSE about an encounter, not an excerpt from it, and
   * a report that presents the two identically misattributes the second.
   */
  verbatim: boolean;
  producerVersion: string;
}

export interface CandidateSource {
  strength: LedgerStrength;
  sourceKind: LedgerRow["sourceKind"];
  quote: string;
  sourceDocumentId?: string | null;
  encounterId?: string | null;
  chronologyEventId?: string | null;
  page?: number | null;
  field?: string | null;
  recordedOn?: Date | null;
  sourceFingerprint?: string | null;
  /** True when `quote` is verbatim from the record. Defaults to false. */
  verbatim?: boolean;
  /** True when the source's own text argues AGAINST the recommendation. */
  opposes?: boolean;
  /** Set by the caller when the source failed the anatomy gate. */
  anatomyOk?: boolean;
  /**
   * Assertions the caller knows structurally — a parsed guideline duration
   * claim, say. Overrides the text classifier, which is a reader of English
   * and therefore the weaker witness.
   */
  asserts?: Partial<AssertionProfile>;
}

/**
 * Build the ledger rows for ONE recommendation from its candidate sources.
 *
 * A candidate can produce several rows — an examination finding may establish
 * both a functional need and what prior treatment achieved — but only for the
 * claims its strength can actually carry. A candidate that establishes nothing
 * for this service produces no rows at all, which is the point: it used to be
 * displayed anyway.
 */
/**
 * The most evidence worth persisting for one claim about one recommendation.
 *
 * Persisting every candidate produced 17,208 rows on the reference case — up
 * to 384 for a single item — because the candidate pool is the whole pertinent
 * chronology and each entry can answer three claims. That is a cross-join, not
 * a ledger: nobody reads 384 rows, and storing them implies a precision the
 * selection does not have.
 *
 * The cap is on what is KEPT, ranked strongest-first, and what it drops is
 * reported rather than silently discarded.
 */
export const MAX_ROWS_PER_CLAIM = 12;

export interface LedgerBuild {
  rows: LedgerRow[];
  /** How many qualifying rows the cap excluded, per claim. Never silent. */
  dropped: number;
}

export function buildLedgerForItem(
  item: { id: string; service: string; category?: string | null; conditionId?: string | null },
  candidates: readonly CandidateSource[],
): LedgerRow[] {
  return buildLedgerWithCap(item, candidates).rows;
}

/** As above, reporting what the cap excluded. */
export function buildLedgerWithCap(
  item: { id: string; service: string; category?: string | null; conditionId?: string | null },
  candidates: readonly CandidateSource[],
): LedgerBuild {
  const all = buildAllRows(item, candidates);
  const byClaim = new Map<EvidenceClaim, LedgerRow[]>();
  for (const r of all) byClaim.set(r.claim, [...(byClaim.get(r.claim) ?? []), r]);

  const rows: LedgerRow[] = [];
  let dropped = 0;
  for (const [, group] of byClaim) {
    const ranked = rankForDisplay(group);
    rows.push(...ranked.slice(0, MAX_ROWS_PER_CLAIM));
    dropped += Math.max(0, ranked.length - MAX_ROWS_PER_CLAIM);
  }
  return { rows, dropped };
}

function buildAllRows(
  item: { id: string; service: string; category?: string | null; conditionId?: string | null },
  candidates: readonly CandidateSource[],
): LedgerRow[] {
  const kind = serviceKindOf(item);
  const rows: LedgerRow[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    // Anatomy first. The right kind of finding about the wrong body part is
    // still the wrong finding.
    if (c.anatomyOk === false) continue;
    if (!c.quote.trim()) continue;

    // SEMANTIC GATE. `claimsSupportedBy` asks whether a source of this
    // strength MAY establish a claim for this service. It cannot ask whether
    // this source SAYS anything about it — so an MRI finding carried necessity,
    // frequency and duration alike, and the reference case showed 698 rows
    // under each of three claims: one pool of quotes, filed three times.
    const asserted = classifyAssertion({ quote: c.quote, field: c.field, asserts: c.asserts });
    for (const claim of claimsSupportedBy(kind, c.strength)) {
      // Right kind of source, and it actually speaks to this. Silence produces
      // no row — not an OPPOSES row, and not a row implying support.
      if (!assertionSupportsClaim(asserted, claim)) continue;
      // One row per (claim, source) — the same quote answering the same claim
      // twice is one piece of evidence.
      const key = `${claim}|${c.sourceKind}|${c.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        futureCareItemId: item.id,
        conditionId: item.conditionId ?? null,
        claim,
        // Opposition is recorded as opposition. An absence of support is not
        // opposition and produces no row.
        stance: c.opposes ? "OPPOSES" : "SUPPORTS",
        strength: c.strength,
        sourceKind: c.sourceKind,
        sourceDocumentId: c.sourceDocumentId ?? null,
        encounterId: c.encounterId ?? null,
        chronologyEventId: c.chronologyEventId ?? null,
        page: c.page ?? null,
        field: c.field ?? null,
        quote: c.quote,
        recordedOn: c.recordedOn ?? null,
        sourceFingerprint: c.sourceFingerprint ?? null,
        verbatim: c.verbatim ?? false,
        producerVersion: EVIDENCE_LEDGER_VERSION,
      });
    }
  }
  return rows;
}

const STRENGTH_RANK: Record<LedgerStrength, number> = {
  DIAGNOSIS: 0,
  OBJECTIVE: 1,
  GUIDELINE: 2,
  LITERATURE: 3,
  HISTORY: 4,
  REPORTED: 5,
};

/**
 * Display order: what opposes first (a reviewer must not have to scroll for
 * it), then by how strong the source is, then most recent first.
 */
export function rankForDisplay<T extends { stance: EvidenceStance; strength: LedgerStrength; recordedOn?: Date | string | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.stance !== b.stance) return a.stance === "OPPOSES" ? -1 : b.stance === "OPPOSES" ? 1 : 0;
    if (a.strength !== b.strength) return STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
    return time(b.recordedOn) - time(a.recordedOn);
  });
}

/**
 * A date that may have crossed a serialization boundary.
 *
 * The persisted ledger reaches the panel as JSON, where a DateTime is a
 * string — so calling `.getTime()` on it threw and took the whole case page
 * down. Rows built in memory still carry real Dates, so this helper accepts
 * both rather than requiring every caller to remember which it holds.
 */
function time(v: Date | string | null | undefined): number {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}
