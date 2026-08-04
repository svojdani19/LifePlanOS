// ─────────────────────────────────────────────────────────────────────────────
// Lifetime duration support — ONE deterministic answer to one narrow question:
// "Is the LIFETIME duration of this recommendation independently supported by
// clinical evidence, and if so, by what?"
//
// Core discipline (Lifetime-Honesty sprint):
//   • `isLifetime` is a PROJECTION HORIZON — an instruction to the cost engine
//     about the period to project over. It is NEVER clinical evidence that a
//     condition is chronic, permanent, or progressive, and it never raises
//     chronicity, trajectory, evidence sufficiency, confidence, probability,
//     record support, or validation status. Evidence flows evidence→projection,
//     never projection→clinical facts.
//   • A generic objective finding (an MRI proving the injury exists) documents
//     the INJURY — it is not evidence about DURATION and never counts here.
//   • A guideline documents MEDICAL NECESSITY. It supports the DURATION only
//     through a verified structured duration claim (supportsDuration +
//     durationType + claim text, service-matched when service-specific) —
//     never merely because it matches the diagnosis/region/intervention or
//     sits high on the evidence hierarchy.
//   • Physician approval of the plan item is professional ADOPTION under the
//     existing review policy. It is not treating-record evidence, it does not
//     convert a condition to documented-chronic, and it never invents a
//     prognosis. An ATTRIBUTED professional duration rationale (a note or an
//     interview opinion that actually speaks to duration) is a distinct,
//     citable professional-opinion basis.
//
// Pure and deterministic — no network, no model, no fabrication — so every
// engine (reasoning, dossier, findings, narratives) consults the SAME verdict
// instead of ad-hoc `isLifetime` inferences.
// ─────────────────────────────────────────────────────────────────────────────

export type LifetimeSupportStatus =
  | "NOT_APPLICABLE" // the item is not a lifetime projection — duration support is not at issue
  | "SUPPORTED_BY_RECORD"
  | "SUPPORTED_BY_GUIDELINE"
  | "SUPPORTED_BY_PROFESSIONAL_OPINION"
  | "MULTIPLE_SUPPORTS"
  | "ASSUMPTION_PENDING_REVIEW" // no independent basis yet; professional review outstanding
  | "INSUFFICIENT"; // reviewed (or rejected) with no independent basis on file

export type LifetimeBasisKind = "record_chronicity" | "guideline_natural_history" | "professional_duration_opinion";

// ── Guideline duration claims (Guideline-Honesty hardening) ──────────────────
// A guideline is diagnosis-keyed evidence of MEDICAL NECESSITY. It becomes
// duration evidence ONLY when it carries a verified, structured duration claim.
// Matching the diagnosis/body region/intervention, supporting general medical
// necessity, or sitting high on the evidence hierarchy NEVER establishes a
// lifetime duration by itself.

/** What kind of duration-relevant statement the guideline actually makes. */
export type GuidelineDurationType =
  | "natural_history"
  | "chronic_recurrence"
  | "permanence"
  | "progressive_course"
  | "long_term_surveillance"
  | "indefinite_treatment"
  | "lifetime_replacement"
  | "continuing_utilization";

/** The structured duration claim carried by ONE guideline entry. Built ONLY at
 *  the deterministic construction sites (explicit per-entry source metadata, or
 *  the conservative detector over the guidance TEXT) — never manufactured from
 *  a title. */
export interface GuidelineDurationClaim {
  /** The guideline actually asserts something about duration. */
  supportsDuration: boolean;
  /** The duration-relevant claim text (the sentence that says so). */
  durationClaim?: string;
  durationType?: GuidelineDurationType;
  /** Identifies the guideline (title / registry id) for attribution. */
  sourceId: string;
  /** Edition/year when known. */
  sourceVersion?: string;
  /** Verbatim guidance text the claim was derived from. */
  quote?: string;
  /** Population/condition scope stated by the source, when structured. */
  applicability?: string;
  limitations?: string;
  /** The duration claim applies only to a specific service; when set, the
   *  claim counts only if the item's service matches `applicability`. */
  serviceSpecific?: boolean;
  /** The guidance contains language CONTRADICTING a long/lifetime duration
   *  (self-limited course, time-limited use, long-term use not recommended…). */
  contradictsDuration?: boolean;
}

/** One guideline entry as passed into `assessLifetimeSupport`. Entries MUST
 *  already have passed the upstream diagnosis/anatomy gates (condition
 *  compatibility) at the construction site; an entry without a `duration`
 *  claim still supports medical necessity elsewhere but never duration. */
export interface LifetimeGuidelineEvidence {
  text: string;
  source?: string | null;
  duration?: GuidelineDurationClaim;
}

/** One independent basis for a lifetime duration, with its provenance. */
export interface LifetimeSupportBasis {
  kind: LifetimeBasisKind;
  /** The evidence text (diagnosis language, quote, guideline, or attributed opinion). */
  text: string;
  /** Source reference when available (filename/page, guideline label, provider name). */
  source: string | null;
}

export interface LifetimeSupportResult {
  status: LifetimeSupportStatus;
  /** True only when at least one INDEPENDENT clinical basis exists. Professional
   *  adoption (a bare approval flag) never sets this. */
  clinicallySupported: boolean;
  /** The reviewing physician has adopted the item (APPROVED/MODIFIED) under the
   *  existing review policy. Adoption is a workflow fact, not clinical evidence. */
  professionalAdoption: boolean;
  /** Every independent basis found, with source refs where available. */
  bases: LifetimeSupportBasis[];
  /** Honest caveats — what the evidence does NOT establish. */
  uncertaintyNotes: string[];
  /** Duration-specific professional review is still outstanding. */
  professionalReviewRequired: boolean;
  /** Whether the item may enter FINALIZED totals per the EXISTING inclusion
   *  policy: independent clinical support, or explicit professional adoption.
   *  (Unsupported lifetime scenarios remain calculated and disclosed either
   *  way — they are never silently dropped, and never silently "supported".) */
  mayEnterFinalizedTotals: boolean;
  /** Deterministic summary for material-change fingerprints: a change in the
   *  duration-support evidence or an attributed duration rationale changes it. */
  fingerprint: string;
}

// ── Deterministic language gates ─────────────────────────────────────────────

// Explicit chronicity / permanence / progression language on the CONDITION —
// diagnosis entities that are chronic by their documented nature, or prognosis
// language that states permanence. Deliberately narrow: it must SAY so.
const CHRONICITY_RE =
  /\bchronic\b|\bpermanent(?:ly)?\b|\bpermanence\b|\bdegenerative?\b|\bdegeneration\b|\bprogressive\b|\blifelong\b|\bend-?stage\b|\bosteoarthritis\b|\bpost-?traumatic arthritis\b|\bparaplegia\b|\bquadriplegia\b|\btetraplegia\b|\bamputation\b|\bspinal cord injury\b|\bwill not (?:improve|resolve)\b|\bexpected to persist\b|\bmaximum medical improvement\b/i;

// Language that actually speaks to DURATION in a professional statement — a
// note that never mentions duration is not a duration opinion.
const DURATION_OPINION_RE =
  /\blifetime\b|\blife[- ]?long\b|\bfor life\b|\blife expectancy\b|\bremainder of (?:his|her|their) life\b|\bpermanent(?:ly)?\b|\bindefinite(?:ly)?\b|\bongoing\b|\blong[- ]term\b|\bchronic\b/i;

// Conservative deterministic detector over guidance TEXT (never the title):
// each pattern maps a duration-relevant claim to its type. Order matters —
// the first match wins, and the more specific phrases come first.
const DURATION_TYPE_DETECTORS: [GuidelineDurationType, RegExp][] = [
  ["natural_history", /\bnatural history\b/i],
  ["long_term_surveillance", /\b(?:lifelong|life[- ]long|long[- ]term|indefinite)\s+(?:\w+\s+){0,2}?surveillance\b|\bsurveillance\b[^.;]{0,50}\b(?:lifelong|life[- ]long|for life|indefinitely|long[- ]term)/i],
  ["lifetime_replacement", /\blifetime replacement\b|\breplacement\b[^.;]{0,50}\b(?:every \d|within the (?:patient'?s )?lifetime)|\brevision\b[^.;]{0,50}\b(?:expected|anticipated|likely)\b/i],
  ["chronic_recurrence", /\bchronic(?:ally)?\b[^.;]{0,60}\brecurren|\brecurren(?:t|ce)\b[^.;]{0,60}\bchronic/i],
  ["permanence", /\bpermanen(?:t|tly|ce)\b/i],
  ["progressive_course", /\bprogressiv(?:e|ely)\b|\bprogression\b/i],
  ["continuing_utilization", /\bcontinu(?:ing|ed)\s+utilization\b/i],
  ["indefinite_treatment", /\bindefinite(?:ly)?\b|\blifelong\b|\blife[- ]long\b|\bfor life\b/i],
];

// Guidance language that CONTRADICTS a long/lifetime duration. Conservative:
// it must actually say so.
const CONTRADICTS_DURATION_RE =
  /\bself[- ]limit(?:ed|ing)\b|\btime[- ]limited\b|\bexpected to resolve\b|\bresolves?\s+(?:spontaneously|without)\b|\b(?:not|no longer)\s+(?:recommended|indicated|supported)\b[^.;]{0,50}\b(?:long[- ]term|beyond|indefinite|lifetime|chronic)|\b(?:long[- ]term|indefinite|lifetime|chronic)\b[^.;]{0,60}\b(?:is |are )?not\s+(?:recommended|indicated|supported)\b|\bno (?:evidence|role|benefit)\s+(?:for|of|in)\b[^.;]{0,50}\b(?:long[- ]term|lifetime|indefinite|continued|chronic)|\bshould be (?:discontinued|tapered|stopped)\b/i;

/** The sentence of `text` that carries the match — the citable claim. */
function claimSentence(text: string, re: RegExp): string {
  const sentence = text.split(/(?<=[.!?;])\s+/).find((s) => re.test(s));
  return (sentence ?? text).trim();
}

/**
 * Deterministically derive the structured duration claim for one stored
 * guideline entry at a construction site. Policy:
 *   1. Explicit per-entry metadata (a structured `duration` object on the
 *      stored guideline) passes through, normalized — the source said so.
 *   2. Otherwise, the conservative detector runs over the guidance TEXT
 *      (the quote). The TITLE is never consulted — a generic
 *      treatment-efficacy guideline keeps supporting medical necessity
 *      elsewhere but never gains a duration claim from its name.
 *   3. Contradicting duration language flags `contradictsDuration`; when the
 *      same entry both claims and contradicts, the contradiction wins for
 *      that entry (supportsDuration: false).
 * Returns undefined when the entry says nothing about duration.
 */
export function deriveGuidelineDurationClaim(g: {
  title?: string | null;
  year?: string | null;
  quote?: string | null;
  duration?: unknown;
}): GuidelineDurationClaim | undefined {
  // (1) Explicit structured metadata from the source — pass through, normalized.
  const explicit = g.duration as Partial<GuidelineDurationClaim> | null | undefined;
  if (explicit && typeof explicit === "object" && typeof explicit.supportsDuration === "boolean") {
    return {
      ...explicit,
      supportsDuration: explicit.supportsDuration,
      sourceId: explicit.sourceId ?? g.title ?? "clinical guideline",
      sourceVersion: explicit.sourceVersion ?? g.year ?? undefined,
      quote: explicit.quote ?? g.quote ?? undefined,
    };
  }
  // (2) Conservative detector over the guidance TEXT only. No quote → no claim.
  const text = g.quote?.trim();
  if (!text) return undefined;
  const contradicts = CONTRADICTS_DURATION_RE.test(text);
  const hit = DURATION_TYPE_DETECTORS.find(([, re]) => re.test(text));
  if (!hit && !contradicts) return undefined;
  const sourceId = g.title ?? "clinical guideline";
  if (contradicts) {
    return { supportsDuration: false, contradictsDuration: true, sourceId, sourceVersion: g.year ?? undefined, quote: text, durationClaim: claimSentence(text, CONTRADICTS_DURATION_RE) };
  }
  const [durationType, re] = hit!;
  return { supportsDuration: true, durationType, sourceId, sourceVersion: g.year ?? undefined, quote: text, durationClaim: claimSentence(text, re) };
}

// Words too generic to establish a service match on their own.
const SERVICE_STOPWORDS = new Set(["the", "a", "an", "of", "for", "and", "or", "to", "in", "with", "care", "therapy", "treatment", "management", "program", "service", "services", "visit", "visits"]);

/** Whether a service-specific duration claim's stated scope matches the item's
 *  service — a shared meaningful token (naively de-pluralized, stopwords
 *  removed). Deterministic and conservative: no scope or no overlap → no match. */
export function guidelineServiceMatches(applicability: string, service: string): boolean {
  const tok = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").map((w) => w.replace(/s$/, "")).filter((w) => w.length >= 4 && !SERVICE_STOPWORDS.has(w));
  const scope = new Set(tok(applicability));
  const svc = tok(service);
  return scope.size > 0 && svc.some((w) => scope.has(w));
}

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ── Inputs (structural; satisfied by the existing engine objects) ────────────

export interface LifetimeConditionInput {
  name?: string | null;
  objectiveEvidence?: string | null;
  reasoning?: string | null;
  supportingRecords?: string | null;
  evidenceSources?: unknown; // [{ filename?, page?, quote? }]
}

export interface LifetimeSupportInput {
  /** The projection horizon flag — used ONLY to decide applicability. */
  isLifetime: boolean;
  condition?: LifetimeConditionInput | null;
  /** Diagnosis-keyed clinical guidance that already passed the anatomy/diagnosis
   *  gates (e.g. the dossier's guideline bucket) — that upstream gate is the
   *  condition-compatibility precondition for every entry here. Keyed to the
   *  DIAGNOSIS — never to the item's duration: only an entry carrying a
   *  verified `duration` claim can ever support the lifetime duration. */
  guidelineEvidence?: LifetimeGuidelineEvidence[];
  /** The item's service — consulted only to check service-specific claims. */
  service?: string | null;
  /** Attributed treating/consulting-provider statements (e.g. interview
   *  opinions), each with its attribution. */
  providerOpinions?: { text: string; providerName?: string | null }[];
  /** The reviewing physician's stored note on this item, if any. */
  physicianNote?: string | null;
  physicianStatus?: string | null;
  /** Count of generic objective findings (imaging/exam) — reported honestly as
   *  NOT duration support when chronicity language is absent. */
  objectiveFindingCount?: number;
}

// ── Basis extraction ─────────────────────────────────────────────────────────

function quotesOf(condition: LifetimeConditionInput | null | undefined): { filename?: string; page?: number | null; quote?: string }[] {
  return condition && Array.isArray(condition.evidenceSources)
    ? (condition.evidenceSources as { filename?: string; page?: number | null; quote?: string }[])
    : [];
}

/** Whether the condition itself is anchored in the record (any source-linked
 *  evidence). A bare asserted diagnosis label with no record anchor cannot,
 *  alone, establish a lifetime duration. */
function conditionAnchored(condition: LifetimeConditionInput | null | undefined): boolean {
  if (!condition) return false;
  return quotesOf(condition).length > 0 || !!condition.objectiveEvidence || !!condition.supportingRecords;
}

/** Independent record-chronicity bases: explicit chronic/permanent/progressive
 *  language in a source-linked quote, or on an anchored documented diagnosis. */
function recordChronicityBases(condition: LifetimeConditionInput | null | undefined): LifetimeSupportBasis[] {
  if (!condition) return [];
  const out: LifetimeSupportBasis[] = [];
  // 1) Source-linked prognosis/chronicity language — directly citable.
  for (const s of quotesOf(condition)) {
    if (s.quote && CHRONICITY_RE.test(s.quote)) {
      out.push({ kind: "record_chronicity", text: s.quote, source: `${s.filename ?? "record"}${s.page ? `, p. ${s.page}` : ""}` });
    }
  }
  // 2) Chronicity language on the documented condition itself (diagnosis name /
  //    objective evidence / causation reasoning) — but ONLY when the condition
  //    is anchored in the record. An unanchored label is an assertion.
  if (conditionAnchored(condition)) {
    const fields: [string, string | null | undefined][] = [
      ["documented diagnosis", condition.name],
      ["documented objective condition evidence", condition.objectiveEvidence],
      ["causation analysis", condition.reasoning],
    ];
    for (const [label, text] of fields) {
      if (text && CHRONICITY_RE.test(text)) {
        out.push({ kind: "record_chronicity", text, source: label });
        break; // one condition-level basis is enough; quotes above carry the rest
      }
    }
  }
  return out;
}

/** Convenience gate for narrative builders: is there ANY independent documented
 *  chronicity evidence on this condition? (Never satisfied by `isLifetime`.) */
export function hasDocumentedChronicity(condition: LifetimeConditionInput | null | undefined): boolean {
  return recordChronicityBases(condition).length > 0;
}

// ── The verdict ──────────────────────────────────────────────────────────────

export function assessLifetimeSupport(input: LifetimeSupportInput): LifetimeSupportResult {
  const adopted = input.physicianStatus === "APPROVED" || input.physicianStatus === "MODIFIED";

  if (!input.isLifetime) {
    return {
      status: "NOT_APPLICABLE",
      clinicallySupported: false,
      professionalAdoption: adopted,
      bases: [],
      uncertaintyNotes: [],
      professionalReviewRequired: false,
      mayEnterFinalizedTotals: true, // lifetime-duration support imposes no constraint on non-lifetime items
      fingerprint: "NOT_APPLICABLE",
    };
  }

  const bases: LifetimeSupportBasis[] = [];
  const uncertaintyNotes: string[] = [];

  // (1) Independent record evidence of chronicity/permanence.
  bases.push(...recordChronicityBases(input.condition));

  // (2) Diagnosis-keyed clinical guidance — counts ONLY on a verified duration
  //     claim. The entry must (a) carry `duration.supportsDuration`, (b) name a
  //     `durationType`, (c) hold actual claim text (durationClaim or quote),
  //     (d) have passed the upstream diagnosis/anatomy gate (the input
  //     contract for `guidelineEvidence`), and (e) if service-specific, match
  //     the item's service. A guideline that merely matches the diagnosis,
  //     supports general medical necessity, or ranks high on the evidence
  //     hierarchy NEVER lands here.
  const guidelineEntries = input.guidelineEvidence ?? [];
  const contradicting = guidelineEntries.filter((g) => g.duration?.contradictsDuration === true);
  const guidelineBases: LifetimeSupportBasis[] = [];
  for (const g of guidelineEntries) {
    const d = g.duration;
    if (!d?.supportsDuration || !d.durationType) continue;
    if (d.contradictsDuration) continue; // a self-contradicting entry never supports on its own text
    const claimText = d.durationClaim ?? d.quote;
    if (!claimText) continue;
    if (d.serviceSpecific && !(input.service && d.applicability && guidelineServiceMatches(d.applicability, input.service))) continue;
    guidelineBases.push({
      kind: "guideline_natural_history",
      text: claimText,
      source: `${d.sourceId}${d.sourceVersion ? ` (${d.sourceVersion})` : ""}`,
    });
  }
  bases.push(...guidelineBases);

  // (3) An ATTRIBUTED professional duration rationale — a statement that
  //     actually speaks to duration, credited to its author. A bare approval
  //     flag is adoption, not an opinion, and never lands here.
  if (input.physicianNote && DURATION_OPINION_RE.test(input.physicianNote)) {
    bases.push({ kind: "professional_duration_opinion", text: input.physicianNote, source: "reviewing physician (attributed duration rationale)" });
  }
  for (const p of input.providerOpinions ?? []) {
    if (DURATION_OPINION_RE.test(p.text)) {
      bases.push({ kind: "professional_duration_opinion", text: p.text, source: p.providerName ? `${p.providerName} (attributed professional opinion)` : "treating provider (attributed professional opinion)" });
    }
  }

  // Contradictory-duration policy: a contradicting guideline for this item is
  // ALWAYS surfaced in uncertaintyNotes. Guideline-based duration support is
  // never silently kept over a contradiction — it is WITHDRAWN unless another
  // independent (non-guideline) basis stands; when such a basis exists, the
  // guideline basis is retained but the conflict remains disclosed for the
  // reviewer to reconcile.
  if (contradicting.length > 0) {
    const ids = [...new Set(contradicting.map((g) => g.duration?.sourceId ?? g.source ?? "cited guidance"))].join("; ");
    const hasNonGuidelineBasis = bases.some((b) => b.kind !== "guideline_natural_history");
    if (guidelineBases.length > 0 && !hasNonGuidelineBasis) {
      for (const gb of guidelineBases) bases.splice(bases.indexOf(gb), 1);
      uncertaintyNotes.push(`Cited clinical guidance contains contradictory duration language (${ids}); guideline-based duration support is withdrawn pending reconciliation, and no other independent basis is on file.`);
    } else {
      uncertaintyNotes.push(`Cited clinical guidance contains contradictory duration language (${ids}); the conflict is disclosed for reconciliation at professional review${hasNonGuidelineBasis ? " and the duration conclusion also rests on independent non-guideline support" : ""}.`);
    }
  }

  const kinds = [...new Set(bases.map((b) => b.kind))].sort();
  const clinicallySupported = bases.length > 0;

  let status: LifetimeSupportStatus;
  if (kinds.length >= 2) status = "MULTIPLE_SUPPORTS";
  else if (kinds[0] === "record_chronicity") status = "SUPPORTED_BY_RECORD";
  else if (kinds[0] === "guideline_natural_history") status = "SUPPORTED_BY_GUIDELINE";
  else if (kinds[0] === "professional_duration_opinion") status = "SUPPORTED_BY_PROFESSIONAL_OPINION";
  else status = input.physicianStatus && input.physicianStatus !== "PENDING" ? "INSUFFICIENT" : "ASSUMPTION_PENDING_REVIEW";

  if (!clinicallySupported) {
    uncertaintyNotes.push("No independent clinical evidence establishes a lifetime duration; the remaining-lifetime scenario is a projection assumption, not an established prognosis.");
    if ((input.objectiveFindingCount ?? 0) > 0) {
      uncertaintyNotes.push("Objective findings document the injury but do not themselves establish that care will be required for life.");
    }
    if (adopted) {
      uncertaintyNotes.push("Physician approval is professional adoption of the plan item under review policy; it is not treating-record evidence of chronicity or permanence.");
    }
  } else if (kinds.length === 1 && kinds[0] === "professional_duration_opinion") {
    uncertaintyNotes.push("The lifetime duration rests on an attributed professional opinion; corroborating record or guideline evidence would strengthen it.");
  }

  return {
    status,
    clinicallySupported,
    professionalAdoption: adopted,
    bases,
    uncertaintyNotes,
    professionalReviewRequired: !adopted,
    // EXISTING inclusion policy preserved: independent support OR explicit
    // professional adoption lifts the finalized-totals block; neither path is
    // ever inferred from `isLifetime` itself.
    mayEnterFinalizedTotals: clinicallySupported || adopted,
    fingerprint: `${status}|${kinds.join(",")}|${fnv(bases.map((b) => `${b.kind}:${b.text}`).join("‖"))}|${fnv(input.physicianNote ?? "")}|${fnv(contradicting.map((g) => g.duration?.sourceId ?? "").join("‖"))}`,
  };
}

// ── Shared narrative fragments ───────────────────────────────────────────────

const KIND_LABEL: Record<LifetimeBasisKind, string> = {
  record_chronicity: "documented chronicity in the condition record",
  guideline_natural_history: "diagnosis-keyed clinical guidance",
  professional_duration_opinion: "an attributed professional duration opinion",
};

/** Human-readable independent basis, with the first source ref per kind —
 *  e.g. "documented chronicity in the condition record (mri.pdf, p. 4) and
 *  diagnosis-keyed clinical guidance (…)". Empty string when unsupported. */
export function describeLifetimeBasis(result: LifetimeSupportResult): string {
  const seen = new Map<LifetimeBasisKind, LifetimeSupportBasis>();
  for (const b of result.bases) if (!seen.has(b.kind)) seen.set(b.kind, b);
  const parts = [...seen.values()].map((b) => `${KIND_LABEL[b.kind]}${b.source ? ` (${b.source})` : ""}`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
