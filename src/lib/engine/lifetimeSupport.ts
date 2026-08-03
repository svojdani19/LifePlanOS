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
   *  gates (e.g. the dossier's guideline bucket). Keyed to the DIAGNOSIS — never
   *  to the item's duration. */
  guidelineEvidence?: { text: string; source?: string | null }[];
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

  // (1) Independent record evidence of chronicity/permanence.
  bases.push(...recordChronicityBases(input.condition));

  // (2) Diagnosis-keyed clinical guidance / natural history (already gated to
  //     the diagnosis and anatomy upstream).
  for (const g of input.guidelineEvidence ?? []) {
    bases.push({ kind: "guideline_natural_history", text: g.text, source: g.source ?? "clinical guidance" });
  }

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

  const kinds = [...new Set(bases.map((b) => b.kind))].sort();
  const clinicallySupported = bases.length > 0;

  let status: LifetimeSupportStatus;
  if (kinds.length >= 2) status = "MULTIPLE_SUPPORTS";
  else if (kinds[0] === "record_chronicity") status = "SUPPORTED_BY_RECORD";
  else if (kinds[0] === "guideline_natural_history") status = "SUPPORTED_BY_GUIDELINE";
  else if (kinds[0] === "professional_duration_opinion") status = "SUPPORTED_BY_PROFESSIONAL_OPINION";
  else status = input.physicianStatus && input.physicianStatus !== "PENDING" ? "INSUFFICIENT" : "ASSUMPTION_PENDING_REVIEW";

  const uncertaintyNotes: string[] = [];
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
    fingerprint: `${status}|${kinds.join(",")}|${fnv(bases.map((b) => `${b.kind}:${b.text}`).join("‖"))}|${fnv(input.physicianNote ?? "")}`,
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
