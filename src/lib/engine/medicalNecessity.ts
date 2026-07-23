// ─────────────────────────────────────────────────────────────────────────────
// Medical Necessity & Clinical Evidence engine (Refactor Sprint).
//
// This replaces the standalone Standard-of-Care module. It synthesizes ALL
// available evidence for a SINGLE future-care recommendation into one coherent,
// physician-quality dossier: a medical-necessity narrative that reads like
// expert testimony (never a diagnosis restatement), a structured probability
// assessment, the challenges opposing counsel could raise, organized and
// source-traceable supporting evidence, actively-searched contradictory
// evidence, honest unknowns, and a structured clinical-confidence score.
//
// It REUSES the platform's existing clinical services rather than deleting them:
// diagnosis mapping (integrity), guideline retrieval + quotes (the former SoC
// engine, now an internal service), gated literature + relevance metadata
// (citationQuality), and page-cited record evidence. Pure and deterministic —
// no network, no fabrication — so it runs identically on the server (report)
// and the client (Future Care panel) and is fully unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

import { bodyRegion } from "./integrity";
import { citationCompatible, evidenceTier, selectPrimary, structuredConfidence, type ConfidenceLevel } from "./citationQuality";
import { specialtyLens } from "./specialtyReasoning";

// ── Inputs (structurally satisfied by the Prisma rows; kept minimal) ─────────
export interface DossierItem {
  id?: string;
  service: string;
  category?: string | null;
  specialty?: string | null;
  rationale?: string | null;
  cptCode?: string | null;
  probability?: string;
  confidence?: number;
  frequencyPerYear?: number;
  durationYears?: number | null;
  isLifetime?: boolean;
  unitCost?: number;
  lifetimeCost?: number;
  presentValue?: number;
  pricingSource?: string | null;
  physicianStatus?: string;
  physicianNote?: string | null;
  lowerCostAlternative?: string | null;
  missingSupport?: string | null;
  literatureSupport?: string | null;
  evidenceStrength?: string | null;
  startTrigger?: string | null;
  citation?: unknown;
}
// An interview finding (EPIC-011) linkable to a condition/recommendation. Only
// user-entered content — never fabricated.
export interface DossierInterview {
  subject: "PATIENT" | "PROVIDER";
  category?: string | null;
  text: string;
  quote?: string | null;
  conditionId?: string | null;
  futureCareItemId?: string | null;
  providerName?: string | null;
}
export interface DossierCondition {
  id?: string;
  name: string;
  relatedness?: string;
  objectiveEvidence?: string | null;
  evidenceSources?: unknown; // [{ filename, page, quote }]
  opposingRecords?: string | null;
  missingInfo?: string | null;
  reasoning?: string | null;
  physicianConfirmed?: boolean;
  socAnalysis?: unknown; // { guidelines: [{ title, year, quote, relevance }] }
}
export interface DossierChronoEvent {
  eventDate: Date | string;
  provider?: string | null;
  procedure?: string | null;
  treatment?: string | null;
  imagingFindings?: string | null;
  objectiveFindings?: string | null;
  functionalStatus?: string | null;
  restrictions?: string | null;
  diagnosis?: string | null;
  summary?: string;
  sourcePage?: number | null;
}
export interface DossierCase {
  subject: string; // e.g. "Ms. Trice"
  pronounPoss: string; // "her" | "his" | "the patient's"
  lifeExpectancyYears: number;
  adult: boolean;
}

// ── Output ───────────────────────────────────────────────────────────────────
export interface EvidenceItem { text: string; source?: string | null }
export interface DossierLiterature {
  title: string;
  journal?: string;
  year?: string;
  authors?: string;
  pmid?: string;
  doi?: string;
  studyType: string; // evidence-tier label
  evidenceLevel: number;
  supports: string; // exactly what recommendation it supports
  applicability: string; // applicability to THIS patient
  limitations: string | null;
  whySelected: string;
}
export interface ProbabilityAssessment {
  percentage: number;
  statement: string;
  factors: { label: string; present: boolean; detail: string }[];
}
// §12 — explicit link between a documented functional limitation and this
// recommendation. Null when no functional limitation is documented (the plan
// never claims an undocumented deficit).
export interface FunctionalLink {
  domain: string; // Mobility · Self-care/ADLs · Cognition · Pain/neurologic · Rehabilitation
  limitation: string; // the documented limitation (source-traceable)
  source: string | null;
  quantified: boolean; // numerically quantified in the record
  relationship: string; // how the limitation supports this recommendation
}
export interface RecommendationDossier {
  medicalNecessity: string; // physician narrative (never restates the diagnosis)
  probability: ProbabilityAssessment;
  potentialChallenges: string[];
  functionalLink: FunctionalLink | null;
  supportingEvidence: {
    diagnoses: EvidenceItem[];
    objectiveFindings: EvidenceItem[];
    imaging: EvidenceItem[];
    examination: EvidenceItem[];
    functionalLimitations: EvidenceItem[];
    physicianDocumentation: EvidenceItem[];
    priorTreatment: EvidenceItem[];
    guidelines: EvidenceItem[];
  };
  literature: DossierLiterature[];
  contradictoryEvidence: string[];
  unknowns: string[];
  confidence: { level: ConfidenceLevel; score: number; explanation: string; factors: string[] };
}

// ── Deterministic phrasing variation ────────────────────────────────────────
// A stable FNV-1a hash → a variant index, so the SAME recommendation always
// renders the same wording (reproducible) while DIFFERENT recommendations pick
// different phrasings (breaks the identical-template repetition the report is
// prone to). Never changes clinical content — only sentence structure/wording.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function variant<T>(seed: string, opts: T[]): T {
  return opts[hashStr(seed) % opts.length];
}
// §12 — the functional domain a recommendation serves (null when it is not a
// function-directed service, e.g. surveillance imaging or labs).
function functionalDomainOf(item: DossierItem): string | null {
  const c = (item.category ?? "").toUpperCase();
  const s = item.service.toLowerCase();
  if (["MOBILITY_AID", "ORTHOTICS_PROSTHETICS"].includes(c) || /\b(walker|wheelchair|gait|ambulat|brace|prosthes|orthos|crutch|cane)\b/.test(s)) return "Mobility";
  if (["ATTENDANT_CARE", "SKILLED_NURSING", "HOME_MODIFICATION"].includes(c) || /\b(attendant|home health|home modif|adl|self-?care|bathing|dressing|transfer)\b/.test(s)) return "Self-care / ADLs";
  if (["COGNITIVE_THERAPY", "PSYCH"].includes(c) || /\b(cognit|neuropsych|memory|attention|compensatory)\b/.test(s)) return "Cognition";
  if (["PAIN_MANAGEMENT", "INJECTION", "MEDICATION"].includes(c) || /\b(pain|radiculopath|neuralgia|neuropath)\b/.test(s)) return "Pain / neurologic";
  if (["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "SPEECH_THERAPY"].includes(c) || /\b(therapy|rehab)\b/.test(s)) return "Rehabilitation";
  return null;
}
const QUANTIFIED = /\d+\s*(?:degree|°|feet|foot|meter|metre|minute|flight|%|percent|grade|\/5|out of|pound|\blb\b|\bkg\b|hour|repetition|rep\b|week|day|\bmph\b|second)/i;

// A recommendation warranting the full multi-sentence synthesis vs. a concise
// one — high cost, lifetime/contingent, disputed, or below the probability bar.
function isComplexItem(item: DossierItem): boolean {
  return (
    (item.presentValue ?? 0) >= 75000 ||
    !!item.isLifetime ||
    !!item.lowerCostAlternative ||
    !!item.startTrigger ||
    (item.probability ?? "POSSIBLE") !== "PROBABLE" ||
    /\b(revision|future surgery|replacement|arthroplasty|fusion|reconstruction|attendant|nursing)\b/i.test(item.service)
  );
}

// ── Small text helpers (kept local; no cross-module coupling) ────────────────
const lc = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const period = (s: string) => { const t = (s || "").trim(); return t ? (/[.!?]$/.test(t) ? t : t + ".") : ""; };
const mdY = (d: Date | string) => { const x = new Date(d); return `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`; };

// A record line that is provider/metadata boilerplate, not a clinical finding.
const METADATA_LINE = /^(therapist|provider|attending|physician|examiner|surgeon|dictated|signed|reviewed|electronically|name|date|patient name|room|account|mrn)\b|,\s*(?:MD|DO|PT|DPT|RN|PA|NP)\b\s*(?:—|-|$)/i;
const SECTION_LABEL = /^(?:findings?|impression|procedure(?: performed)?|assessment|plan|technique|comparison|indication|history|subjective|objective|short-?term goals?|long-?term goals?|hpi|chief complaint|reason)\s*:?\s*/i;
// Clean a raw record fragment into a readable mid-sentence clause: strip a
// leading section label and surrounding quotes, take the first clause, trim.
function cleanClause(text: string, maxLen = 130): string {
  let s = String(text).replace(/^["“]|["”]$/g, "").replace(SECTION_LABEL, "").replace(/\s+/g, " ").trim();
  s = s.split(/(?<=[.!?;])\s+/)[0].replace(/[.;,]+$/, "").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + "…";
  return s;
}
function isCleanFinding(text: string): boolean {
  const s = String(text).replace(/^["“]|["”]$/g, "").trim();
  return s.length >= 8 && !METADATA_LINE.test(s);
}

function evidenceSourcesOf(cond: DossierCondition | null): { filename?: string; page?: number | null; quote?: string }[] {
  return cond && Array.isArray(cond.evidenceSources) ? (cond.evidenceSources as { filename?: string; page?: number | null; quote?: string }[]) : [];
}
function guidelinesOf(cond: DossierCondition | null): { title?: string; year?: string; quote?: string; relevance?: { evidenceLevel?: number; evidenceLabel?: string; whyRelevant?: string; limitations?: string | null } }[] {
  const soc = cond?.socAnalysis as { guidelines?: unknown[] } | null;
  return (soc?.guidelines ?? []) as never[];
}

// Whether a chronology event pertains to this recommendation's diagnosis/region.
function eventPertains(e: DossierChronoEvent, region: string, dxName: string): boolean {
  const hay = `${e.summary ?? ""} ${e.diagnosis ?? ""} ${e.treatment ?? ""} ${e.procedure ?? ""} ${e.imagingFindings ?? ""} ${e.objectiveFindings ?? ""} ${e.functionalStatus ?? ""} ${e.restrictions ?? ""}`.toLowerCase();
  if (region !== "general" && bodyRegion(hay) === region) return true;
  const dxWords = dxName.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return dxWords.some((w) => hay.includes(w));
}

/**
 * Synthesize the complete physician-quality dossier for one recommendation.
 */
export function buildRecommendationDossier(
  item: DossierItem,
  condition: DossierCondition | null,
  chronology: DossierChronoEvent[],
  kase: DossierCase,
  interviews: DossierInterview[] = [],
): RecommendationDossier {
  const dxName = condition?.name ?? "the injuries at issue";
  const region = bodyRegion(`${item.service} ${dxName}`);
  const sources = evidenceSourcesOf(condition);
  const guidelines = guidelinesOf(condition);
  const pertinent = chronology.filter((e) => eventPertains(e, region, dxName));
  // Interview findings for THIS recommendation. An item-specific link (a
  // futureCareItemId) is precise — it appears ONLY on that item; a
  // diagnosis-level link (conditionId only) applies to every item of that
  // diagnosis.
  const linkedInterviews = interviews.filter((iv) =>
    iv.futureCareItemId ? item.id === iv.futureCareItemId : iv.conditionId ? condition?.id === iv.conditionId : false,
  );
  const patientReports = linkedInterviews.filter((iv) => iv.subject === "PATIENT");
  const providerOpinions = linkedInterviews.filter((iv) => iv.subject === "PROVIDER");

  // ── Organized, source-traceable supporting evidence ────────────────────────
  const objectiveFindings: EvidenceItem[] = [];
  const imaging: EvidenceItem[] = [];
  const examination: EvidenceItem[] = [];
  const functionalLimitations: EvidenceItem[] = [];
  const priorTreatment: EvidenceItem[] = [];
  const physicianDocumentation: EvidenceItem[] = [];

  // ANATOMY GATE: a piece of evidence may only support this dossier when its
  // own text maps to the diagnosis's body region (or is region-neutral). This
  // is what prevents an L1 burst-fracture finding from "anchoring" a knee
  // diagnosis just because both mention "fracture". Functional status is
  // whole-person and stays ungated.
  const dxRegion = bodyRegion(`${item.service} ${dxName}`);
  const regionOk = (text: string): boolean => {
    if (dxRegion === "general") return true;
    const r = bodyRegion(text);
    return r === "general" || r === dxRegion;
  };

  if (condition?.objectiveEvidence && regionOk(condition.objectiveEvidence)) objectiveFindings.push({ text: condition.objectiveEvidence, source: "causation analysis" });
  for (const s of sources) if (s.quote && regionOk(s.quote)) objectiveFindings.push({ text: `“${s.quote}”`, source: `${s.filename ?? "record"}${s.page ? `, p. ${s.page}` : ""}` });
  for (const e of pertinent) {
    const src = `${mdY(e.eventDate)}${e.provider ? ` · ${e.provider}` : ""}${e.sourcePage ? ` (p. ${e.sourcePage})` : ""}`;
    if (e.imagingFindings && isCleanFinding(e.imagingFindings) && regionOk(e.imagingFindings)) imaging.push({ text: cleanClause(e.imagingFindings, 180), source: src });
    if (e.objectiveFindings && isCleanFinding(e.objectiveFindings) && regionOk(e.objectiveFindings)) examination.push({ text: cleanClause(e.objectiveFindings, 180), source: src });
    if (e.functionalStatus && isCleanFinding(e.functionalStatus)) functionalLimitations.push({ text: cleanClause(e.functionalStatus, 160), source: src });
    if (e.restrictions && isCleanFinding(e.restrictions)) functionalLimitations.push({ text: cleanClause(e.restrictions, 160), source: src });
    if (e.procedure && isCleanFinding(e.procedure) && regionOk(e.procedure)) priorTreatment.push({ text: cleanClause(e.procedure, 160), source: src });
    else if (e.treatment && isCleanFinding(e.treatment) && regionOk(e.treatment)) priorTreatment.push({ text: cleanClause(e.treatment, 160), source: src });
  }
  if (item.physicianStatus === "APPROVED" || item.physicianStatus === "MODIFIED") {
    physicianDocumentation.push({ text: `Reviewing physician ${item.physicianStatus === "MODIFIED" ? "approved with modification" : "approved"} this recommendation${item.physicianNote ? `: “${item.physicianNote}”` : "."}`, source: "physician review" });
  } else if (item.physicianNote) {
    physicianDocumentation.push({ text: `“${item.physicianNote}”`, source: "physician review" });
  }
  // Interview findings (EPIC-011): patient complaints → functional limitations;
  // treating-provider opinions → physician documentation. Verbatim, user-entered.
  for (const iv of patientReports) functionalLimitations.push({ text: `Patient reports ${lc(cleanClause(iv.text, 150))}${iv.quote ? ` — “${iv.quote}”` : ""}`, source: iv.category ? `patient interview · ${iv.category}` : "patient interview" });
  for (const iv of providerOpinions) physicianDocumentation.push({ text: `${iv.providerName ? `${iv.providerName}` : "Treating provider"}: ${cleanClause(iv.text, 160)}${iv.quote ? ` — “${iv.quote}”` : ""}`, source: "provider interview" });
  const guidelineEvidence: EvidenceItem[] = guidelines.filter((g) => g.title).map((g) => ({ text: `${g.quote ? `“${g.quote}” — ` : ""}${g.title}${g.year ? ` (${g.year})` : ""}`, source: g.relevance?.evidenceLabel ?? "clinical guideline" }));
  const diagnoses: EvidenceItem[] = condition ? [{ text: `${condition.name}${condition.relatedness ? ` — ${condition.relatedness.replace(/_/g, " ").toLowerCase()}` : ""}`, source: condition.reasoning ? "causation analysis" : null }] : [];

  // ── Gated, relevance-ranked literature (recommendation-centric) ─────────────
  const rawCites = (Array.isArray(item.citation) ? item.citation : item.citation ? [item.citation] : []) as {
    title?: string; journal?: string; year?: string; authors?: string; pmid?: string; doi?: string;
    relevance?: { evidenceLevel?: number; evidenceLabel?: string; whyRelevant?: string; supports?: string; limitations?: string | null };
  }[];
  const litScored = rawCites
    .filter((cc) => cc.title && citationCompatible({ title: cc.title }, { diagnosis: dxName, service: item.service, adult: kase.adult }).compatible)
    .map((cc) => {
      const tier = cc.relevance?.evidenceLevel != null ? { level: cc.relevance.evidenceLevel, label: cc.relevance.evidenceLabel ?? "Clinical study" } : evidenceTier(cc.title ?? "");
      return { cc, relevance: { evidenceLevel: tier.level, score: 0 } };
    });
  const literature: DossierLiterature[] = selectPrimary(litScored).map(({ cc, relevance }) => ({
    title: cc.title!,
    journal: cc.journal,
    year: cc.year,
    authors: cc.authors,
    pmid: cc.pmid,
    doi: cc.doi,
    studyType: cc.relevance?.evidenceLabel ?? evidenceTier(cc.title!).label,
    evidenceLevel: relevance.evidenceLevel,
    // Prefer the article's own stored claim; otherwise state what it supports.
    supports: cc.relevance?.supports?.trim() || `the medical necessity of ${lc(item.service)} for ${lc(dxName)}`,
    applicability: variant((cc.title ?? "") + item.service, [
      `${kase.subject} carries ${lc(dxName)}${region !== "general" ? ` (${region.replace(/_/g, "/")})` : ""} — the condition and population this study addresses`,
      `this study's population (${lc(dxName)}${region !== "general" ? `, ${region.replace(/_/g, "/")}` : ""}) matches ${kase.subject}'s presentation`,
      `directly applicable: ${kase.subject}'s ${lc(dxName)}${region !== "general" ? ` (${region.replace(/_/g, "/")})` : ""} is the clinical context this evidence speaks to`,
    ]),
    limitations: cc.relevance?.limitations ?? null,
    whySelected: cc.relevance?.whyRelevant ?? "recommendation-relevant and region/procedure/population compatible",
  }));
  const bestLevel = literature.length ? Math.min(...literature.map((l) => l.evidenceLevel)) : guidelineEvidence.length ? 1 : null;

  // ── Structured confidence ──────────────────────────────────────────────────
  const conf = structuredConfidence({
    recordEvidenceCount: sources.length + (condition?.objectiveEvidence ? 1 : 0),
    hasObjectiveFindings: objectiveFindings.length > 0,
    physicianSupport: item.physicianStatus === "APPROVED" || item.physicianStatus === "MODIFIED",
    guidelineSupport: guidelineEvidence.length > 0,
    bestEvidenceLevel: bestLevel,
    hasContradictoryEvidence: !!condition?.opposingRecords,
    hasMissingInfo: !!condition?.missingInfo || !!item.missingSupport,
  });

  // ── Probability assessment (structured + percentage) ───────────────────────
  const probFactors = [
    { label: "Objective findings", present: objectiveFindings.length > 0, detail: objectiveFindings.length ? "documented in the record" : "not independently documented" },
    { label: "Treatment response / course", present: priorTreatment.length > 0, detail: priorTreatment.length ? "prior treatment for this condition is documented" : "no prior treatment documented" },
    { label: "Treating-physician documentation", present: physicianDocumentation.length > 0, detail: physicianDocumentation.length ? "physician review or note on file" : "awaiting physician confirmation" },
    { label: "Guideline support", present: guidelineEvidence.length > 0, detail: guidelineEvidence.length ? "supported by cited clinical guidance" : "no on-point guideline located" },
    { label: "Expected disease progression", present: !!item.isLifetime || (item.probability === "PROBABLE"), detail: item.isLifetime ? "the condition is chronic and progressive over the lifetime" : "a defined course of care is anticipated" },
  ];
  // Percentage anchored to the medical-probability rating and modulated by the
  // count of supporting factors — transparent, never asserted beyond support.
  const base = item.probability === "PROBABLE" ? 62 : item.probability === "POSSIBLE" ? 40 : item.probability === "SPECULATIVE" ? 22 : 12;
  const percentage = Math.max(5, Math.min(95, base + probFactors.filter((f) => f.present).length * 6));
  const areIs = /s$/.test(item.service) ? "are" : "is";
  const probability: ProbabilityAssessment = {
    percentage,
    // Qualitative medical-probability statement — no arbitrary percentage in the
    // report (§12); the numeric `percentage` remains only for internal thresholding.
    statement:
      percentage >= 51
        ? variant(item.service + "prob+", [
            `On balance, ${lc(item.service)} ${areIs} more likely than not to be required, to a reasonable degree of medical probability.`,
            `To a reasonable degree of medical probability, ${lc(item.service)} ${areIs} more likely than not required.`,
            `The weight of the record places ${lc(item.service)} above the threshold of more likely than not.`,
          ])
        : variant(item.service + "prob-", [
            `${cap(lc(item.service))} ${areIs} foreseeable but, on the present record, ${areIs} not more likely than not; disclosed as a contingency rather than totaled.`,
            `On the present record ${lc(item.service)} ${areIs} a reasonable possibility but below the more-likely-than-not threshold; carried as a contingency, not totaled.`,
          ]),
    factors: probFactors,
  };

  // ── Contradictory evidence (actively searched) ─────────────────────────────
  const contradictoryEvidence: string[] = [];
  if (condition?.opposingRecords) contradictoryEvidence.push(period(condition.opposingRecords));
  for (const l of literature) if (l.evidenceLevel >= 9) contradictoryEvidence.push(`The support for this item rests partly on ${l.studyType.toLowerCase()}-level evidence (${l.title.slice(0, 70)}…), which is a weak basis and could be challenged.`);
  if (item.lowerCostAlternative) contradictoryEvidence.push(`A lower-cost alternative exists (${lc(item.lowerCostAlternative)}); an opposing expert may argue it is clinically equivalent.`);
  if (!literature.length && !guidelineEvidence.length) contradictoryEvidence.push("No published literature specific to this recommendation was located, so the frequency/duration rest on clinical judgment and the treating record.");

  // ── Unknowns (never imply certainty) ───────────────────────────────────────
  const unknowns: string[] = [];
  if (condition?.missingInfo) unknowns.push(period(condition.missingInfo));
  if (item.missingSupport) unknowns.push(period(item.missingSupport));
  if (item.isLifetime && !guidelineEvidence.length) unknowns.push("The natural history and long-term course of this condition are not fully established in the literature; the lifetime projection is a reasoned estimate.");
  if (/revision|future surgery|replacement/i.test(item.service)) unknowns.push("This item is contingent on clinical worsening; its timing cannot be predicted with precision.");
  if (!objectiveFindings.length) unknowns.push("Objective findings for this specific item are limited on the present record; further evaluation would strengthen the basis.");

  // ── Potential challenges (renamed "vulnerability") ─────────────────────────
  const potentialChallenges: string[] = [];
  if (item.physicianStatus !== "APPROVED" && item.physicianStatus !== "MODIFIED") potentialChallenges.push("Physician review is pending — an opposing expert may note the recommendation is not yet endorsed.");
  potentialChallenges.push(`Frequency (${item.frequencyPerYear ?? 1}×/yr) and ${item.isLifetime ? "lifetime duration" : `${item.durationYears ?? 1}-year duration`} are assumptions that could be contested.`);
  if (!literature.length) potentialChallenges.push("Literature specific to this recommendation is limited.");
  if (!item.cptCode) potentialChallenges.push("Cost is a non-code-specific (bundled) estimate rather than a single CPT.");
  if (item.probability !== "PROBABLE") potentialChallenges.push("The medical probability is below the more-likely-than-not threshold and is disclosed as a contingency.");
  if (!objectiveFindings.length) potentialChallenges.push("Objective evidence tying this item to the diagnosis is thin on the present record.");

  // ── Medical-necessity narrative (physician voice; NOT a diagnosis restate) ─
  let necessity = buildNecessityNarrative(item, condition, { objectiveFindings, imaging, examination, functionalLimitations, priorTreatment, guidelines: guidelineEvidence }, kase, dxName);
  // Weave the patient's own account and any treating-provider opinion.
  if (patientReports.length) necessity += ` On interview, ${kase.subject} reports ${lc(cleanClause(patientReports[0].text, 140))}, which the recommendation directly addresses.`;
  if (providerOpinions.length) necessity += ` This is consistent with the opinion of ${providerOpinions[0].providerName ?? "the treating provider"} on interview.`;

  // §12 — tie the recommendation to a DOCUMENTED functional limitation (never an
  // undocumented one). Uses the source-traceable functional-limitations bucket.
  const domain = functionalDomainOf(item);
  let functionalLink: FunctionalLink | null = null;
  if (domain && functionalLimitations.length) {
    const fl = functionalLimitations[0];
    const limText = String(fl.text).replace(/^Patient reports\s*/i, "").trim();
    functionalLink = {
      domain,
      limitation: cleanClause(limText, 160),
      source: fl.source ?? null,
      quantified: QUANTIFIED.test(limText),
      relationship: variant(item.service + "flink", [
        `The documented ${domain.toLowerCase()} limitation supports ${lc(item.service)}.`,
        `${lc(item.service)} directly addresses this documented ${domain.toLowerCase()} deficit.`,
        `This ${domain.toLowerCase()} impairment is the functional basis for ${lc(item.service)}.`,
      ]),
    };
  }

  return {
    medicalNecessity: necessity,
    probability,
    potentialChallenges,
    functionalLink,
    supportingEvidence: { diagnoses, objectiveFindings, imaging, examination, functionalLimitations, physicianDocumentation, priorTreatment, guidelines: guidelineEvidence },
    literature,
    contradictoryEvidence,
    unknowns,
    confidence: { level: conf.level, score: conf.score, explanation: buildConfidenceExplanation(conf.level, conf.factors), factors: conf.factors },
  };
}

// Compose the medical-necessity narrative as an experienced physician would —
// synthesizing the diagnosis, objective pathology, prior treatment, current
// symptoms, functional impairment, and anticipated future needs into flowing
// prose that explains WHY the care is necessary. Deterministic; every clause is
// grounded in a supplied structured fact.
function buildNecessityNarrative(
  item: DossierItem,
  condition: DossierCondition | null,
  ev: { objectiveFindings: EvidenceItem[]; imaging: EvidenceItem[]; examination: EvidenceItem[]; functionalLimitations: EvidenceItem[]; priorTreatment: EvidenceItem[]; guidelines: EvidenceItem[] },
  kase: DossierCase,
  dxName: string,
): string {
  const S = kase.subject;
  const sv = item.service;
  const areIs = /s$/.test(sv) ? "are" : "is";
  const complex = isComplexItem(item);
  const lens = specialtyLens(item.category, sv);
  const frame = variant(sv + "frame", lens.frames);
  const parts: string[] = [];

  // 1) Specialty-framed clinical observation — the objective substrate seen
  //    through the responsible specialty's lens (varied so no two open alike).
  const objective = ev.imaging[0]?.text || ev.objectiveFindings[0]?.text || ev.examination[0]?.text;
  if (objective) {
    const o = lc(cleanClause(objective, 150));
    parts.push(variant(sv + "open", [
      `${frame}, ${S}'s ${lc(dxName)} rests on a concrete finding — ${o}.`,
      `${frame}, the pertinent finding is ${o}, which anchors ${S}'s ${lc(dxName)}.`,
      `${frame}, ${lc(dxName)} is no bare label for ${S}: the record shows ${o}.`,
    ]));
  } else {
    parts.push(variant(sv + "open", [
      `${frame}, ${S} carries ${lc(dxName)} as documented in the treating record.`,
      `${frame}, ${lc(dxName)} is established on ${S}'s treating record.`,
    ]));
  }

  // 2) Function-driven connection (§5) — the care is justified by the DOCUMENTED
  //    functional cost, not by the diagnosis alone.
  const fx = ev.functionalLimitations[0] ? lc(cleanClause(String(ev.functionalLimitations[0].text).replace(/^patient reports\s*/i, ""), 130)) : null;
  if (fx) {
    parts.push(variant(sv + "fx", [
      `What makes the care necessary is functional: ${fx}.`,
      `That pathology carries a functional cost — ${fx} — and it is the cost, not the label, that drives this recommendation.`,
      `The operative issue is function: ${fx}.`,
    ]));
  }

  // 3) Prior treatment → residual impairment (complex items only).
  if (complex && ev.priorTreatment.length) {
    const tx = ev.priorTreatment.slice(0, 2).map((t) => lc(cleanClause(String(t.text), 90))).join(" and ");
    parts.push(variant(sv + "tx", [
      `${cap(kase.pronounPoss)} course has already included ${tx}, yet the impairment has not resolved.`,
      `Prior ${tx} has not returned ${S} to baseline, as the record reflects.`,
    ]));
  }

  // 4) The necessity, in the specialty's own voice (§1/§6) — its clinical goal
  //    and the forward-looking concern it manages.
  const rationale = item.rationale ? lc(cleanClause(item.rationale, 140)) : `the sequelae of ${lc(dxName)}`;
  const need = item.isLifetime
    ? `${S} will require ${lc(sv)} on a recurring basis across ${kase.pronounPoss} lifetime`
    : `${S} will require ${lc(sv)} over a defined course`;
  parts.push(variant(sv + "need", [
    `${cap(lc(sv))} ${areIs} reasonable and necessary to ${lens.goal}, with ${lens.concern} the forward concern; on that basis ${need}.`,
    `The clinical objective is ${lens.goal}: ${lc(sv)} ${areIs} reasonable and necessary to that end, managing ${lens.concern}. ${cap(need)}.`,
    `Reasonably and necessarily, ${lc(sv)} addresses ${rationale} toward ${lens.goal} while watching for ${lens.concern}; ${need}.`,
  ]));

  // 5) Synthesis close (§8) — expert-testimony integration for complex items.
  if (complex) {
    const prog = item.isLifetime ? "the condition is chronic and expected to progress" : "a defined further course is anticipated";
    parts.push(variant(sv + "syn", [
      `Taken together — the objective pathology,${fx ? " the documented functional loss," : ""} the prior treatment, and that ${prog} — this care is medically necessary to a reasonable degree of medical probability.`,
      `Integrating the diagnosis, the objective findings,${fx ? " the functional consequences," : ""} and the expected course, it is my opinion, to a reasonable degree of medical probability, that this care is required.`,
    ]));
  }

  return parts.join(" ");
}

function buildConfidenceExplanation(level: ConfidenceLevel, factors: string[]): string {
  const lead =
    level === "Very High"
      ? "Confidence is very high"
      : level === "High"
        ? "Confidence is high"
        : level === "Moderate"
          ? "Confidence is moderate"
          : level === "Low"
            ? "Confidence is low"
            : "Confidence is indeterminate";
  const reason =
    level === "Indeterminate"
      ? "there is insufficient evidence on the present record to reason from"
      : `it reflects ${factors.join(", ")}`;
  return `${lead}: ${reason}.`;
}

// ── Completeness validation (Refactor Sprint) ────────────────────────────────
export interface CompletenessFinding {
  recommendation: string;
  result: string;
  issue: string;
  severity: "Critical" | "High" | "Moderate" | "Low";
  suggestedCorrection: string;
  exportBlocking: boolean;
}

/**
 * A recommendation must not stand in the plan lacking its physician-quality
 * elements. Missing a supporting diagnosis is Critical (already blocks totals);
 * missing objective evidence, a necessity rationale, or any literature/
 * documented-absence is a review finding.
 */
export function validateRecommendationCompleteness(item: DossierItem, dossier: RecommendationDossier, hasCondition: boolean): CompletenessFinding[] {
  const out: CompletenessFinding[] = [];
  if (!hasCondition) {
    out.push({ recommendation: item.service, result: "No supporting diagnosis", issue: "The recommendation is not linked to a documented diagnosis.", severity: "Critical", suggestedCorrection: "Map it to a region-matched diagnosis or remove it.", exportBlocking: true });
  }
  if (dossier.supportingEvidence.objectiveFindings.length === 0 && dossier.supportingEvidence.imaging.length === 0 && dossier.supportingEvidence.examination.length === 0) {
    out.push({ recommendation: item.service, result: "No objective evidence", issue: "No objective findings, imaging, or examination support this recommendation on the record.", severity: "Moderate", suggestedCorrection: "Obtain objective evidence (imaging/exam/FCE) or physician confirmation.", exportBlocking: false });
  }
  if (!item.rationale && dossier.medicalNecessity.length < 40) {
    out.push({ recommendation: item.service, result: "No medical-necessity rationale", issue: "The recommendation lacks a medical-necessity explanation.", severity: "Moderate", suggestedCorrection: "Author a patient-specific necessity rationale.", exportBlocking: false });
  }
  return out;
}
