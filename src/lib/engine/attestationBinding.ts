// ─────────────────────────────────────────────────────────────────────────────
// Attestation ↔ clinical-evidence binding (versioned clinical fingerprint).
//
// An attestation signed under this module is bound to the EXACT clinical
// evidence the physician reviewed: a canonical, versioned SHA-256 fingerprint
// per covered recommendation, aggregated into Attestation.clinicalFingerprint,
// with the per-item fingerprints riding inside the stored scope entries.
// Any later change to the underlying clinical material — a quotation, a
// contradicting record, a source document's content, the chronology, an
// interview finding, a citation or guideline, an assumption, a conflict flag,
// a material unknown — changes the fingerprint and fail-closes verification.
//
// WHAT THE FINGERPRINT COVERS (per recommendation, one sub-hash per category):
//   recommendation   — item id + lineageId + version/updated marker; frequency
//                      per year, duration years, isLifetime; staged-care
//                      triggers (startTrigger, prerequisite, contingencyOnly);
//                      item-level probability
//   assessment       — ClinicalReasoningAssessment id, methodology version
//                      (generatedByModel), lifecycle status, evidence-
//                      sufficiency verdict (+ score), probability
//                      classification
//   duration         — duration-support fingerprint material: durationClass +
//                      persisted durationRationale text (which carries the
//                      lifetime-duration-support verdict and its basis)
//   evidence         — classified evidence items (source/page/date/provider/
//                      epistemic + text hash); supporting quotations with
//                      document ids + page locators (condition evidenceSources);
//                      contradicting/weakening evidence; condition evidence
//                      identity (id, name, relatedness)
//   documents        — referenced source documents' content identity
//                      (documentId, pageCount, extracted-text hash)
//   chronology       — chronology events used in reasoning (ids + dates +
//                      description hashes)
//   interviews       — material interview findings (id, category, text/quote
//                      hashes, date)
//   providerOpinions — physicianNote / attributed professional notes
//   citations        — literature (title/year/pmid) + guideline identities
//   assumptions      — clinical assumptions (self-critique assumptions)
//   contradictions   — conflict flags across the recommendation set
//   unknowns         — material unknowns + missing-evidence requests
//
// EXPLICITLY EXCLUDED (display/derived-only — a change here MUST NOT change
// the fingerprint):
//   • narrative summary paragraphs: objectiveEvidenceSummary,
//     subjectiveEvidenceSummary, functionalBasisSummary, priorTreatmentSummary,
//     treatmentResponseSummary, treatingRecordSupportSummary,
//     literatureSynthesis, residualUncertainty, confidenceExplanation
//   • display labels and formatting (PROBABILITY_LABEL etc.), UI ordering
//   • physicianSummary (auto-paraphrase), relevanceScore, confidence integers
//   • financial fields (unitCost, annualCost, presentValue, lifetimeCost,
//     low/high, pricingSource/pricedAt/pricingDetail) — those are pinned by
//     the existing attestation scope + contentHash, not by the CLINICAL
//     fingerprint
//
// Canonicalization: recursively key-sorted objects; arrays sorted by their
// canonical JSON encoding (order-independent). SHA-256 hex, prefixed with the
// version tag ("cfp-1:"). This is NOT the 32-bit FNV used by materialHash.
//
// Fail closed: a legacy attestation (null fingerprint / bindingVersion) can
// never authorize a new final; it remains readable as history.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { prisma } from "@/lib/db";

export const CLINICAL_FINGERPRINT_VERSION = "cfp-1";

/** Opinion-scope codes an attestation's signed statement can cover. */
export const OPINION_SCOPES = [
  "FUTURE_CARE_MEDICAL_NECESSITY",
  "FREQUENCY_AND_DURATION",
  "CAUSATION",
  "PROGNOSIS",
  "LIFE_EXPECTANCY",
  "FINANCIAL_ASSUMPTIONS",
] as const;
export type OpinionScope = (typeof OPINION_SCOPES)[number];

/** What the EXISTING physician item-attestation statement actually asserts:
 *  necessity at the stated frequency and duration. It does NOT state causation
 *  conclusions, prognosis, life expectancy, or financial assumptions. */
export const DEFAULT_ATTESTATION_OPINION_SCOPES: OpinionScope[] = [
  "FUTURE_CARE_MEDICAL_NECESSITY",
  "FREQUENCY_AND_DURATION",
];

// ── Canonical JSON + hashing ─────────────────────────────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Short content hash for free-text fields embedded in the fingerprint input —
 *  keeps the canonical form small and PHI-minimized while remaining sensitive
 *  to any text change. */
export const textHash = (s: string | null | undefined): string | null =>
  s == null ? null : sha256(s);

/** Recursively key-sorted, array-canonicalized JSON. Arrays are sorted by the
 *  canonical encoding of their elements so element ORDER never matters. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).sort().join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

// ── Fingerprint input (one per recommendation) ───────────────────────────────

export interface FingerprintQuotation {
  documentId: string | null;
  page: number | null;
  quoteHash: string | null;
}

export interface ClinicalFingerprintInput {
  recommendation: {
    id: string;
    lineageId: string | null;
    /** Version/updated marker for the specific item row (version + createdAt). */
    updatedMarker: string;
    probability: string;
    frequencyPerYear: number;
    durationYears: number | null;
    isLifetime: boolean;
    startTrigger: string | null;
    prerequisite: string | null;
    contingencyOnly: boolean;
  };
  assessment: {
    id: string | null;
    methodologyVersion: string | null;
    lifecycleStatus: string | null;
    evidenceSufficient: boolean | null;
    evidenceSufficiencyScore: number | null;
    probabilityClassification: string | null;
  };
  duration: {
    durationClass: string | null;
    /** Persisted duration-support fingerprint material (durationRationale text
     *  hash — no structured durationSupport column exists). */
    durationRationaleHash: string | null;
  };
  evidence: {
    /** Classified evidence items: identity + epistemic class + text hash. */
    items: {
      category: string | null;
      source: string | null;
      page: number | null;
      date: string | null;
      provider: string | null;
      objective: boolean | null;
      epistemic: string | null;
      textHash: string | null;
    }[];
    /** Supporting quotations w/ document ids + page locators. */
    supportingQuotations: FingerprintQuotation[];
    /** Contradicting/weakening evidence (structure hashed as-is). */
    contradicting: unknown[];
    /** Condition evidence identity. */
    conditions: { id: string; name: string; relatedness: string | null }[];
  };
  documents: { documentId: string; pageCount: number | null; contentHash: string | null }[];
  chronology: { id: string; date: string | null; descriptionHash: string | null }[];
  interviews: {
    id: string;
    category: string | null;
    textHash: string | null;
    quoteHash: string | null;
    date: string | null;
  }[];
  providerOpinions: { source: string; textHash: string | null }[];
  citations: {
    literature: { title: string | null; year: number | string | null; pmid: string | null }[];
    guidelines: { title: string | null; claim: string | null }[];
  };
  assumptions: string[];
  contradictions: unknown[];
  unknowns: unknown[];
}

export type FingerprintCategory = keyof ClinicalFingerprintInput;

/** One sub-hash per top-level category — diffable, so an audit event can name
 *  exactly WHICH category of clinical material changed. */
export function computeCategorySubHashes(input: ClinicalFingerprintInput): Record<FingerprintCategory, string> {
  const out = {} as Record<FingerprintCategory, string>;
  for (const key of Object.keys(input).sort() as FingerprintCategory[]) {
    out[key] = sha256(canonicalJson(input[key]));
  }
  return out;
}

/** Canonical (recursively key-sorted, arrays canonically ordered) JSON →
 *  SHA-256 hex, prefixed with the fingerprint version ("cfp-1:"). */
export function computeClinicalFingerprint(input: ClinicalFingerprintInput): string {
  const categories = computeCategorySubHashes(input);
  return (
    CLINICAL_FINGERPRINT_VERSION +
    ":" +
    sha256(canonicalJson({ version: CLINICAL_FINGERPRINT_VERSION, categories }))
  );
}

/** The category names whose sub-hashes differ between two fingerprint inputs. */
export function diffFingerprintCategories(a: ClinicalFingerprintInput, b: ClinicalFingerprintInput): FingerprintCategory[] {
  const ha = computeCategorySubHashes(a);
  const hb = computeCategorySubHashes(b);
  return (Object.keys(ha) as FingerprintCategory[]).filter((k) => ha[k] !== hb[k]).sort();
}

/** Order-independent aggregate over the covered items' per-recommendation
 *  fingerprints — stored on Attestation.clinicalFingerprint at signing. */
export function aggregateClinicalFingerprint(perItem: { itemId: string; clinicalFingerprint: string }[]): string {
  const canonical = canonicalJson(perItem.map((p) => ({ itemId: p.itemId, fp: p.clinicalFingerprint })));
  return CLINICAL_FINGERPRINT_VERSION + ":" + sha256(canonical);
}

// ── Binding state (pure builder + prisma loader) ─────────────────────────────

export interface ClinicalBindingState {
  assessmentId: string | null;
  assessmentStatus: string | null;
  superseded: boolean;
  evidenceSufficient: boolean | null;
  probability: string;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  clinicalFingerprint: string;
}

// Row shapes — structural, satisfied by the Prisma rows the loader selects and
// by plain objects in tests (pure core needs no database).
export interface BindingItemRow {
  id: string;
  lineageId: string | null;
  version: number;
  createdAt: Date | string;
  probability: string;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  startTrigger?: string | null;
  prerequisite?: string | null;
  contingencyOnly?: boolean | null;
  conditionId?: string | null;
  physicianNote?: string | null;
  citation?: unknown;
}

export interface BindingAssessmentRow {
  id: string;
  recommendationId: string;
  status: string;
  generatedByModel?: string | null;
  createdAt?: Date | string;
  probabilityClassification?: string | null;
  durationClass?: string | null;
  durationRationale?: string | null;
  evidenceItems?: unknown;
  weakeningEvidence?: unknown;
  evidenceSufficiency?: unknown;
  supportingDiagnosisIds?: unknown;
  supportingLiteratureAssessments?: unknown;
  supportingGuidelineAssessments?: unknown;
  selfCritique?: unknown;
  conflictFlags?: unknown;
  unknowns?: unknown;
  missingEvidenceRequests?: unknown;
}

export interface BindingConditionRow {
  id: string;
  name: string;
  relatedness?: string | null;
  evidenceSources?: unknown; // [{ documentId?, filename?, page?, quote? }]
}

export interface BindingChronologyRow {
  id: string;
  eventDate: Date | string;
  summary?: string | null;
  diagnosis?: string | null;
  treatment?: string | null;
  sourceQuote?: string | null;
  imagingFindings?: string | null;
  sourceDocumentId?: string | null;
}

export interface BindingInterviewRow {
  id: string;
  category?: string | null;
  text: string;
  quote?: string | null;
  interviewDate?: Date | string | null;
  conditionId?: string | null;
  futureCareItemId?: string | null;
}

export interface BindingDocumentRow {
  id: string;
  pageCount?: number | null;
  extractedText?: string | null;
}

export interface BindingRows {
  items: BindingItemRow[];
  assessments: BindingAssessmentRow[];
  conditions: BindingConditionRow[];
  chronology: BindingChronologyRow[];
  interviews: BindingInterviewRow[];
  documents: BindingDocumentRow[];
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === "string" ? d : d.toISOString();
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const NEEDS_REVIEW_STATUSES = new Set(["NEEDS_REVIEW", "NEEDS_REASONING_REVIEW", "PENDING", "PROCESSING"]);
const INVALID_STATUSES = new Set(["INVALID", "ERROR"]);

/** Current assessment per recommendation: the newest non-superseded row, else
 *  (superseded-only lineage) the newest superseded row flagged as such. */
function currentAssessmentFor(recommendationId: string, assessments: BindingAssessmentRow[]): { row: BindingAssessmentRow | null; superseded: boolean } {
  const mine = assessments.filter((a) => a.recommendationId === recommendationId);
  if (!mine.length) return { row: null, superseded: false };
  const time = (a: BindingAssessmentRow) => new Date(a.createdAt ?? 0).getTime();
  const live = mine.filter((a) => a.status !== "SUPERSEDED").sort((a, b) => time(b) - time(a));
  if (live.length) return { row: live[0], superseded: false };
  const newest = [...mine].sort((a, b) => time(b) - time(a))[0];
  return { row: newest, superseded: true };
}

function evidenceSufficientOf(assessment: BindingAssessmentRow | null): { verdict: boolean | null; score: number | null } {
  const es = assessment?.evidenceSufficiency as { sufficient?: unknown; score?: unknown } | null | undefined;
  if (!es || typeof es !== "object") return { verdict: null, score: null };
  return {
    verdict: typeof es.sufficient === "boolean" ? es.sufficient : null,
    score: num(es.score),
  };
}

/** Assemble the fingerprint input for ONE recommendation from raw rows. Pure. */
export function buildFingerprintInputForRecommendation(item: BindingItemRow, rows: BindingRows): ClinicalFingerprintInput {
  const { row: assessment } = currentAssessmentFor(item.id, rows.assessments);
  const es = evidenceSufficientOf(assessment);

  // Conditions in play: the assessment's supporting diagnoses, falling back to
  // the item's own linked condition when no assessment exists yet.
  const diagIds = new Set(asArray(assessment?.supportingDiagnosisIds).filter((v): v is string => typeof v === "string"));
  if (!diagIds.size && item.conditionId) diagIds.add(item.conditionId);
  const conditions = rows.conditions.filter((c) => diagIds.has(c.id));

  const supportingQuotations: FingerprintQuotation[] = conditions.flatMap((c) =>
    asArray(c.evidenceSources).map((s) => {
      const src = (s ?? {}) as { documentId?: unknown; page?: unknown; quote?: unknown };
      return { documentId: str(src.documentId), page: num(src.page), quoteHash: textHash(str(src.quote)) };
    }),
  );

  // Referenced source documents: condition evidence sources + chronology.
  const referencedDocIds = new Set<string>();
  for (const q of supportingQuotations) if (q.documentId) referencedDocIds.add(q.documentId);
  for (const ev of rows.chronology) if (ev.sourceDocumentId) referencedDocIds.add(ev.sourceDocumentId);
  const documents = rows.documents
    .filter((d) => referencedDocIds.has(d.id))
    .map((d) => ({ documentId: d.id, pageCount: d.pageCount ?? null, contentHash: textHash(d.extractedText) }));

  // Interview findings material to this recommendation: linked to the item,
  // linked to a supporting diagnosis, or case-general (unlinked).
  const interviews = rows.interviews
    .filter((f) => f.futureCareItemId === item.id || (f.conditionId != null && diagIds.has(f.conditionId)) || (f.futureCareItemId == null && f.conditionId == null))
    .map((f) => ({ id: f.id, category: f.category ?? null, textHash: textHash(f.text), quoteHash: textHash(f.quote ?? null), date: iso(f.interviewDate ?? null) }));

  const selfCritique = (assessment?.selfCritique ?? null) as { assumptions?: unknown } | null;
  const literature = [
    ...asArray(item.citation).map((c) => {
      const cit = (c ?? {}) as { title?: unknown; year?: unknown; pmid?: unknown };
      return { title: str(cit.title), year: (num(cit.year) ?? str(cit.year)) as number | string | null, pmid: str(cit.pmid) };
    }),
    ...asArray(assessment?.supportingLiteratureAssessments).map((l) => {
      const lit = (l ?? {}) as { title?: unknown; year?: unknown; pmid?: unknown };
      return { title: str(lit.title), year: (num(lit.year) ?? str(lit.year)) as number | string | null, pmid: str(lit.pmid) };
    }),
  ];

  return {
    recommendation: {
      id: item.id,
      lineageId: item.lineageId ?? null,
      updatedMarker: `${item.version}:${iso(item.createdAt) ?? ""}`,
      probability: item.probability,
      frequencyPerYear: item.frequencyPerYear,
      durationYears: item.durationYears,
      isLifetime: item.isLifetime,
      startTrigger: item.startTrigger ?? null,
      prerequisite: item.prerequisite ?? null,
      contingencyOnly: item.contingencyOnly ?? false,
    },
    assessment: {
      id: assessment?.id ?? null,
      methodologyVersion: assessment?.generatedByModel ?? null,
      lifecycleStatus: assessment?.status ?? null,
      evidenceSufficient: es.verdict,
      evidenceSufficiencyScore: es.score,
      probabilityClassification: assessment?.probabilityClassification ?? null,
    },
    duration: {
      durationClass: assessment?.durationClass ?? null,
      durationRationaleHash: textHash(assessment?.durationRationale ?? null),
    },
    evidence: {
      items: asArray(assessment?.evidenceItems).map((e) => {
        const ev = (e ?? {}) as Record<string, unknown>;
        return {
          category: str(ev.category),
          source: str(ev.source),
          page: num(ev.page),
          date: str(ev.date),
          provider: str(ev.provider),
          objective: typeof ev.objective === "boolean" ? ev.objective : null,
          epistemic: str(ev.epistemic),
          textHash: textHash(str(ev.text)),
        };
      }),
      supportingQuotations,
      contradicting: asArray(assessment?.weakeningEvidence),
      conditions: conditions.map((c) => ({ id: c.id, name: c.name, relatedness: c.relatedness ?? null })),
    },
    documents,
    chronology: rows.chronology.map((ev) => ({
      id: ev.id,
      date: iso(ev.eventDate),
      descriptionHash: textHash([ev.summary ?? "", ev.diagnosis ?? "", ev.treatment ?? "", ev.imagingFindings ?? "", ev.sourceQuote ?? ""].join("|")),
    })),
    interviews,
    providerOpinions: item.physicianNote != null && item.physicianNote !== "" ? [{ source: "physician_item_note", textHash: textHash(item.physicianNote) }] : [],
    citations: {
      literature,
      guidelines: asArray(assessment?.supportingGuidelineAssessments).map((g) => {
        const gl = (g ?? {}) as { title?: unknown; claim?: unknown };
        return { title: str(gl.title), claim: str(gl.claim) };
      }),
    },
    assumptions: asArray(selfCritique?.assumptions).filter((a): a is string => typeof a === "string"),
    contradictions: asArray(assessment?.conflictFlags),
    unknowns: [...asArray(assessment?.unknowns), ...asArray(assessment?.missingEvidenceRequests)],
  };
}

/** Pure: the full binding state map for a case's current recommendations. */
export function buildClinicalBindingState(rows: BindingRows): Map<string, ClinicalBindingState> {
  const out = new Map<string, ClinicalBindingState>();
  for (const item of rows.items) {
    const { row: assessment, superseded } = currentAssessmentFor(item.id, rows.assessments);
    const es = evidenceSufficientOf(assessment);
    const input = buildFingerprintInputForRecommendation(item, rows);
    out.set(item.id, {
      assessmentId: assessment?.id ?? null,
      assessmentStatus: assessment?.status ?? null,
      superseded,
      evidenceSufficient: es.verdict,
      probability: item.probability,
      frequencyPerYear: item.frequencyPerYear,
      durationYears: item.durationYears,
      isLifetime: item.isLifetime,
      clinicalFingerprint: computeClinicalFingerprint(input),
    });
  }
  return out;
}

/** Load the current clinical binding state for a case (server side). Returns
 *  an empty map when the case is not in the firm — callers fail closed. */
export async function loadClinicalBindingState(firmId: string, caseId: string): Promise<Map<string, ClinicalBindingState>> {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId }, select: { id: true } });
  if (!kase) return new Map();

  const [items, assessments, conditions, chronology, interviews] = await Promise.all([
    prisma.futureCareItem.findMany({
      where: { caseId, supersededAt: null },
      select: {
        id: true, lineageId: true, version: true, createdAt: true, probability: true,
        frequencyPerYear: true, durationYears: true, isLifetime: true, startTrigger: true,
        prerequisite: true, contingencyOnly: true, conditionId: true, physicianNote: true, citation: true,
      },
    }),
    prisma.clinicalReasoningAssessment.findMany({
      where: { caseId, firmId },
      select: {
        id: true, recommendationId: true, status: true, generatedByModel: true, createdAt: true,
        probabilityClassification: true, durationClass: true, durationRationale: true,
        evidenceItems: true, weakeningEvidence: true, evidenceSufficiency: true,
        supportingDiagnosisIds: true, supportingLiteratureAssessments: true,
        supportingGuidelineAssessments: true, selfCritique: true, conflictFlags: true,
        unknowns: true, missingEvidenceRequests: true,
      },
    }),
    prisma.condition.findMany({ where: { caseId }, select: { id: true, name: true, relatedness: true, evidenceSources: true } }),
    prisma.chronologyEvent.findMany({
      where: { caseId },
      select: { id: true, eventDate: true, summary: true, diagnosis: true, treatment: true, sourceQuote: true, imagingFindings: true, sourceDocumentId: true },
    }),
    prisma.interviewFinding.findMany({
      where: { caseId },
      select: { id: true, category: true, text: true, quote: true, interviewDate: true, conditionId: true, futureCareItemId: true },
    }),
  ]);

  // Only documents actually referenced by evidence sources or chronology.
  const referenced = new Set<string>();
  for (const c of conditions) for (const s of asArray(c.evidenceSources)) {
    const docId = str((s as { documentId?: unknown } | null)?.documentId);
    if (docId) referenced.add(docId);
  }
  for (const ev of chronology) if (ev.sourceDocumentId) referenced.add(ev.sourceDocumentId);
  const documents = referenced.size
    ? await prisma.document.findMany({ where: { id: { in: [...referenced] }, caseId }, select: { id: true, pageCount: true, extractedText: true } })
    : [];

  return buildClinicalBindingState({
    items: items as BindingItemRow[],
    assessments: assessments as BindingAssessmentRow[],
    conditions: conditions as BindingConditionRow[],
    chronology: chronology as BindingChronologyRow[],
    interviews: interviews as BindingInterviewRow[],
    documents: documents as BindingDocumentRow[],
  });
}

// ── Verification (fail-closed, PHI-free reason codes) ────────────────────────

export type ClinicalBindingReason =
  | "ATTESTATION_UNVERSIONED"
  | "CLINICAL_FINGERPRINT_MISMATCH"
  | "ASSESSMENT_NEEDS_REVIEW"
  | "ASSESSMENT_INVALID"
  | "ASSESSMENT_SUPERSEDED"
  | "ASSESSMENT_MISSING"
  | "EVIDENCE_INSUFFICIENT";

export interface ClinicalBindingVerification {
  ok: boolean;
  reasons: string[];
}

/**
 * Does the attestation's clinical binding still hold against the CURRENT
 * clinical state? Fail closed:
 *   • a legacy attestation (null fingerprint/version) NEVER authorizes a new
 *     final (ATTESTATION_UNVERSIONED) — it stays readable as history;
 *   • every covered item must have a current, non-superseded assessment that
 *     is neither awaiting review nor invalid, with sufficient evidence;
 *   • the per-item fingerprints pinned in the scope AND the stored aggregate
 *     must match the state recomputed now.
 */
export function verifyAttestationClinicalBinding(
  att: { clinicalFingerprint: string | null; bindingVersion: string | null; scope: unknown },
  state: Map<string, ClinicalBindingState>,
  coveredItemIds: string[],
): ClinicalBindingVerification {
  if (!att.clinicalFingerprint || !att.bindingVersion) {
    return { ok: false, reasons: ["ATTESTATION_UNVERSIONED"] };
  }
  const reasons = new Set<ClinicalBindingReason>();

  // Per-item fingerprints pinned inside the stored scope entries at signing.
  const pinnedByItem = new Map<string, string | null>();
  for (const entry of asArray(att.scope)) {
    const e = (entry ?? {}) as { itemId?: unknown; clinicalFingerprint?: unknown };
    if (typeof e.itemId === "string") pinnedByItem.set(e.itemId, str(e.clinicalFingerprint));
  }

  for (const itemId of coveredItemIds) {
    const st = state.get(itemId);
    if (!st) {
      reasons.add("ASSESSMENT_MISSING");
      continue;
    }
    if (st.superseded) reasons.add("ASSESSMENT_SUPERSEDED");
    if (!st.assessmentId) reasons.add("ASSESSMENT_MISSING");
    else {
      const status = st.assessmentStatus ?? "";
      if (NEEDS_REVIEW_STATUSES.has(status)) reasons.add("ASSESSMENT_NEEDS_REVIEW");
      if (INVALID_STATUSES.has(status)) reasons.add("ASSESSMENT_INVALID");
    }
    if (st.evidenceSufficient === false) reasons.add("EVIDENCE_INSUFFICIENT");
    const pinned = pinnedByItem.get(itemId);
    if (pinned != null && pinned !== st.clinicalFingerprint) reasons.add("CLINICAL_FINGERPRINT_MISMATCH");
  }

  // Aggregate: recompute over the covered set's CURRENT fingerprints and
  // require equality with the stored aggregate.
  const aggregate = aggregateClinicalFingerprint(
    coveredItemIds.map((itemId) => ({ itemId, clinicalFingerprint: state.get(itemId)?.clinicalFingerprint ?? "" })),
  );
  if (aggregate !== att.clinicalFingerprint) reasons.add("CLINICAL_FINGERPRINT_MISMATCH");

  return { ok: reasons.size === 0, reasons: [...reasons].sort() };
}

// ── Assessment-row category diff (for supersession audit events) ─────────────

/** Assessment-derived slice of the fingerprint categories, built from a stored
 *  (or about-to-be-stored) assessment row. Volatile identifiers (row id,
 *  timestamps) are deliberately excluded — this powers the "what category of
 *  clinical material changed" audit label on supersession, not the binding
 *  fingerprint itself. */
function assessmentRowFingerprintInput(row: Partial<BindingAssessmentRow>): ClinicalFingerprintInput {
  const es = evidenceSufficientOf((row as BindingAssessmentRow) ?? null);
  const selfCritique = (row.selfCritique ?? null) as { assumptions?: unknown } | null;
  return {
    recommendation: {
      id: "", lineageId: null, updatedMarker: "", probability: "", frequencyPerYear: 0,
      durationYears: null, isLifetime: false, startTrigger: null, prerequisite: null, contingencyOnly: false,
    },
    assessment: {
      id: null,
      methodologyVersion: row.generatedByModel ?? null,
      // Lifecycle status is a WORKFLOW fact (forced NEEDS_REVIEW on
      // supersession, SUPERSEDED on the prior row) — including it here would
      // flag "assessment" on every supersession regardless of what actually
      // changed. The audit diff names changed clinical material only.
      lifecycleStatus: null,
      evidenceSufficient: es.verdict,
      evidenceSufficiencyScore: es.score,
      probabilityClassification: row.probabilityClassification ?? null,
    },
    duration: {
      durationClass: row.durationClass ?? null,
      durationRationaleHash: textHash(row.durationRationale ?? null),
    },
    evidence: {
      items: asArray(row.evidenceItems).map((e) => {
        const ev = (e ?? {}) as Record<string, unknown>;
        return {
          category: str(ev.category), source: str(ev.source), page: num(ev.page), date: str(ev.date),
          provider: str(ev.provider), objective: typeof ev.objective === "boolean" ? ev.objective : null,
          epistemic: str(ev.epistemic), textHash: textHash(str(ev.text)),
        };
      }),
      supportingQuotations: [],
      contradicting: asArray(row.weakeningEvidence),
      conditions: asArray(row.supportingDiagnosisIds)
        .filter((v): v is string => typeof v === "string")
        .map((id) => ({ id, name: "", relatedness: null })),
    },
    documents: [],
    chronology: [],
    interviews: [],
    providerOpinions: [],
    citations: {
      literature: asArray(row.supportingLiteratureAssessments).map((l) => {
        const lit = (l ?? {}) as { title?: unknown; year?: unknown; pmid?: unknown };
        return { title: str(lit.title), year: (num(lit.year) ?? str(lit.year)) as number | string | null, pmid: str(lit.pmid) };
      }),
      guidelines: asArray(row.supportingGuidelineAssessments).map((g) => {
        const gl = (g ?? {}) as { title?: unknown; claim?: unknown };
        return { title: str(gl.title), claim: str(gl.claim) };
      }),
    },
    assumptions: asArray(selfCritique?.assumptions).filter((a): a is string => typeof a === "string"),
    contradictions: asArray(row.conflictFlags),
    unknowns: [...asArray(row.unknowns), ...asArray(row.missingEvidenceRequests)],
  };
}

/** Which fingerprint categories changed between a superseded assessment row
 *  and its replacement. PHI-free: returns category NAMES only. */
export function diffAssessmentFingerprintCategories(
  prior: Partial<BindingAssessmentRow>,
  next: Partial<BindingAssessmentRow>,
): FingerprintCategory[] {
  return diffFingerprintCategories(assessmentRowFingerprintInput(prior), assessmentRowFingerprintInput(next));
}
