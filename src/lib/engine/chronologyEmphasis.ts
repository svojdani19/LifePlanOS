// ─────────────────────────────────────────────────────────────────────────────
// Chronology emphasis profile — LEARNED FROM A PROFESSIONAL EXEMPLAR.
//
// Derived 2026-08-04 from a systematic analysis of a corpus reference case's
// professionally published Life Care Plan (the McHenry exemplar): how a
// physician life-care planner selects, expands, compresses, and annotates
// medical-record encounters in the Records and Chronology sections. Only the
// GENERALIZABLE selection/emphasis rules were carried over — no case content.
//
// The exemplar's core philosophy, now encoded here:
//   • COVERAGE OVER OMISSION — every clinically documented encounter is
//     represented; compression is achieved by entry LENGTH, not by dropping
//     records. Routine interval visits collapse to a short stereotyped line;
//     milestone encounters get full detail.
//   • An encounter is EXPANDED when it carries any expansion signal: a first
//     visit with a provider, a new/changed diagnosis, imaging reviewed or
//     ordered, treatment escalation (new prescription, injection/surgery
//     recommendation), a procedure, work-status/causation/disability content,
//     a quantified treatment-response milestone, or a discharge/disposition.
//   • Imaging survives NEAR-VERBATIM — levels, laterality, millimeter
//     measurements, nerve-root/cord involvement, acuity markers, and hardware
//     status are never paraphrased away.
//   • Longitudinal devices matter: treatment response is quantified at the
//     follow-up ("80% relief", "no relief"), post-operative encounters are
//     anchored "N weeks status post [procedure]", and care gaps are surfaced,
//     never silently bridged.
//   • The reviewer's voice stays out — neutral past-tense reporting only.
//
// Everything here is pure and deterministic: text in → verdicts out.
// ─────────────────────────────────────────────────────────────────────────────

import type { EncounterData } from "@/lib/engine/chronology";

export interface ExpansionVerdict {
  expanded: boolean;
  /** Which exemplar signals fired (stable codes, for scoring + audit). */
  signals: string[];
}

// Treatment-escalation language: a NEW prescription, an interventional
// recommendation, or a surgical recommendation inside the plan/treatment text.
const ESCALATION_RE =
  /\b(?:recommend(?:ed|s)?|scheduled?|plan(?:ned)? for|proceed with|candidate for|referred? (?:to|for))\b[^.\n]{0,80}\b(?:injection|epidural|ablation|radiofrequency|block|surgery|surgical|fusion|discectomy|arthroscop|stimulator|implant)\b|\bstart(?:ed)?\b[^.\n]{0,40}\b(?:mg|tablet|capsule)\b|\bnew prescription\b/i;

// Quantified response milestone: percent relief, resolution, failure, flare.
const RESPONSE_RE =
  /\b(?:\d{1,3}\s*%\s*(?:relief|improvement|improved|better))|\b(?:complete|significant|marked|no|minimal|little)\s+(?:relief|improvement)\b|\bresolved\b|\bflare[- ]?up\b|\bfailed (?:to respond|conservative)\b/i;

// Causation / medico-legal statements the exemplar always preserves.
const CAUSATION_RE =
  /\bcausally related\b|\bcaused by\b|\bas a result of the\b|\bexacerbat(?:ed|ion)\b|\baggravat(?:ed|ion)\b|\bpermanent (?:disability|impairment|restriction)\b|\bmaximum medical improvement\b|\bMMI\b/i;

/**
 * The exemplar's expansion test (§6 of the profile): does this encounter earn
 * a full-detail entry, or does it compress to the short interval form?
 * `firstVisitWithProvider` and `newDiagnosis` are longitudinal facts the
 * caller computes across the whole record set.
 */
export function expansionVerdict(
  enc: EncounterData,
  body: string,
  opts: {
    eventType: string;
    firstVisitWithProvider?: boolean;
    newDiagnosis?: boolean;
  },
): ExpansionVerdict {
  const signals: string[] = [];
  const planText = `${enc.treatment ?? ""} ${enc.procedure ?? ""}`;
  if (opts.firstVisitWithProvider) signals.push("first-visit");
  if (opts.newDiagnosis) signals.push("new-diagnosis");
  if (enc.imagingFindings || /\bwas performed and reviewed\b/i.test(body)) signals.push("imaging");
  if (enc.procedure || opts.eventType === "SURGERY") signals.push("procedure");
  if (ESCALATION_RE.test(planText) || ESCALATION_RE.test(body)) signals.push("escalation");
  if (enc.workStatus || enc.impairmentRating || CAUSATION_RE.test(body)) signals.push("medicolegal");
  if (RESPONSE_RE.test(enc.subjective ?? "") || RESPONSE_RE.test(body)) signals.push("response");
  if (enc.disposition || opts.eventType === "ER_VISIT" || opts.eventType === "HOSPITALIZATION" || opts.eventType === "COMPLICATION") signals.push("disposition");
  return { expanded: signals.length > 0, signals };
}

/**
 * The compressed interval-visit line (§5): repetition itself documents the
 * treatment course — date, what continued, and the assessment fragment.
 * Neutral, short, still cited.
 */
export function compressedSummary(enc: EncounterData, recordType: string): string {
  const assessment = firstFragment(enc.diagnosis);
  const response = firstFragment(enc.subjective && RESPONSE_RE.test(enc.subjective) ? enc.subjective : null);
  const treated = firstFragment(enc.treatment);
  const parts = [
    `Interval ${recordType.toLowerCase().replace(/record|report/g, "").trim() || "clinical"} visit`,
    response ? `— ${lc(response)}` : null,
    assessment ? `— assessment unchanged: ${lc(assessment)}` : null,
    treated ? `— treatment continued (${lc(treated)})` : "— treatment continued",
  ].filter(Boolean);
  return `${parts.join(" ")}.`.replace(/\.\.+$/, ".");
}

/**
 * Imaging impression, near-verbatim (§3): keep level tokens (C5-C6/L4-L5),
 * laterality, millimeter measurements, root/cord involvement, and acuity
 * markers. Trims to a bounded length WITHOUT cutting through a level clause.
 */
export function imagingImpression(raw: string, maxLen = 320): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  // Cut at the last clause boundary (; or .) before the cap so a disc level
  // or measurement is never truncated mid-token.
  const slice = text.slice(0, maxLen);
  const cut = Math.max(slice.lastIndexOf("; "), slice.lastIndexOf(". "));
  return (cut > maxLen * 0.5 ? slice.slice(0, cut + 1) : slice).trim() + " …";
}

/** Does this imaging text carry the details that must never be dropped? */
export function hasImagingSpecifics(text: string): boolean {
  return /\b[CTL]\d{1,2}\s*[-–]\s*[CTLS]?\d{1,2}\b|\b\d+(?:\.\d+)?\s*mm\b|nerve root|cord|stenosis|foramin/i.test(text);
}

/** Quantified treatment-response phrase from a follow-up, if present (§10). */
export function responseMilestone(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(RESPONSE_RE);
  if (!m) return null;
  // Return the containing clause, bounded.
  const idx = text.indexOf(m[0]);
  const start = Math.max(0, text.lastIndexOf(".", idx) + 1);
  const end = text.indexOf(".", idx);
  return text.slice(start, end === -1 ? Math.min(text.length, idx + 90) : end).replace(/\s+/g, " ").trim();
}

/** "N weeks/months status post [procedure]" anchor for a follow-up (§11). */
export function statusPostAnchor(eventDate: Date, surgery: { date: Date; label: string } | null): string | null {
  if (!surgery) return null;
  const days = Math.round((eventDate.getTime() - surgery.date.getTime()) / 86_400_000);
  if (days < 3 || days > 400) return null; // outside the exemplar's anchoring window
  const span = days < 70 ? `${Math.max(1, Math.round(days / 7))} week${Math.round(days / 7) === 1 ? "" : "s"}` : `${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? "" : "s"}`;
  return `${span} status post ${lc(surgery.label)}`;
}

/** Care-gap note when consecutive documented encounters sit far apart (§12). */
export function careGapNote(prevDate: Date, nextDate: Date, thresholdDays = 90): string | null {
  const days = Math.round((nextDate.getTime() - prevDate.getTime()) / 86_400_000);
  if (days < thresholdDays) return null;
  const months = Math.round(days / 30);
  return `Care gap: no documented treatment for approximately ${months} month${months === 1 ? "" : "s"} preceding this encounter.`;
}

/** Normalized diagnosis-list key for "new or changed assessment" tracking (§4). */
export function diagnosisKey(diagnosis: string | null): string | null {
  if (!diagnosis) return null;
  const key = diagnosis
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .join(" ");
  return key || null;
}

// Exemplar §7 — content that never appears in the professional's chronology:
// consent/patient-education recitals, claim-form field labels, provider-list
// boilerplate, scheduling/administrative fragments. A sentence matching these
// can never serve as a finding, summary, or quote.
const BOILERPLATE_RE =
  /you have the right|risks?(?:,| and) (?:benefits|alternatives)|informed consent|patient education|during your .{0,40}(?:injection|procedure), your doctor|physicians? providing care|relate a-?l to service line|nature of illness or injury|assignment of benefits|financial responsibility|time (?:start|finished)\s*:|transfusion related injury|risks? include|complications? (?:may|can) include|authorization|please (?:arrive|bring|call)|billing (?:questions|inquiries)|this form|signature on file/i;

export function isBoilerplate(s: string): boolean {
  return BOILERPLATE_RE.test(s);
}

/** Does a candidate status-post label actually name a procedure? Anchors are
 *  only ever attached to real surgical labels — never to a stray form phrase
 *  that got classified as a surgery event. */
export function looksLikeProcedureLabel(s: string): boolean {
  return /ectomy|plasty|fusion|decompression|fixation|repair|arthroscop|replacement|graft|laminectomy|stimulator|amputation|reduction|release|revision|implant/i.test(s) && !isBoilerplate(s);
}

const firstFragment = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const frag = s.replace(/\s+/g, " ").trim().split(/(?<=[a-z0-9])\.\s/)[0];
  return frag.length > 90 ? frag.slice(0, 89).trim() + "…" : frag;
};
const lc = (s: string) => (s.length > 1 && /[a-z]/.test(s.slice(1)) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
