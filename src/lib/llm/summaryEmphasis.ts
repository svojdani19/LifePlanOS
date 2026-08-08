// ─────────────────────────────────────────────────────────────────────────────
// What a reviewer puts in a chronology entry — LEARNED FROM THE PUBLISHED PLANS.
//
// The clause shapes this file replaces were written by hand. They were a
// reasonable guess at what a life-care planner considers worth reading, and on
// two points out of three the guess was right — but it was still a guess, and
// the corpus can be asked directly.
//
// Derived 2026-08-08 from the five professionally published Life Care Plans in
// the reference corpus: 557 dated chronology entries, 248 of which carry the
// planner's own labelled clauses ("Subjective:", "Exam:", "Assessment:",
// "Plan:", "Findings:", "Impressions:", "Procedure performed:"). The derivation
// script parses those labels, folds radiology sub-headings into the findings
// clause they belong to, and measures three things per kind of record:
//
//   • SHARE — how often the planner includes this clause at all. This is the
//     honest measure of what they consider worth saying about that kind of
//     record, and it decides which clauses earn a place in a bounded summary.
//   • POSITION — the mean ordinal position of the clause among those included.
//     This is narrative order, and it decides how the kept clauses READ.
//   • COMPRESSION — among entries where the planner wrote exactly ONE clause,
//     how often it was this one. A one-line summary IS the compressed form, so
//     the clause a planner keeps when they keep only one leads ours.
//
// Only aggregate structure was carried over — clause names, counts, positions.
// No case content is in this file. The derivation is reproducible from
// `uploads/corpus-tmp/derive-summary-emphasis.mjs` (gitignored, as the reports
// it reads are real patient records).
//
// What the corpus actually settled, against the hand-written shapes:
//
//   • THE PRESENTING COMPLAINT LEADS AN ENCOUNTER. The hand shape dropped
//     `subjective` entirely and led with the assessment. The planner opens with
//     it in 91% of encounter entries, always in first position, and keeps it in
//     63% of the entries compressed to a single clause. It is now the lead.
//   • A STUDY LEADS WITH ITS IMPRESSION — confirmed, not assumed. The planner
//     writes findings first and the impression last when there is room for a
//     full entry, which argued against the hand rule; but of the study entries
//     compressed to one clause, 75% kept the impression and none kept the
//     findings alone. Compression is what a summary does, so the impression
//     leads and the findings follow it.
//   • AN OPERATION LEADS WITH THE PROCEDURE — confirmed: every single-clause
//     procedure entry in the corpus kept the procedure. The corpus also shows a
//     clause the hand shape had no slot for at all: the AGENT ADMINISTERED
//     ("Medication used:", 44% of procedure entries) — for an injection that is
//     most of what distinguishes one procedure from the next.
//
// Where the corpus is silent, the hand shape stands and says so: `basis:
// "hand-shaped"`. Five published plans are a real but narrow sample — they
// contain no billing entries, no deposition entries and no pathology entries,
// because a planner chronicles care rather than paperwork. Those kinds keep
// their hand ordering rather than being fitted to evidence that does not exist.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";
import type { ClaimField } from "@/lib/llm/recordExtraction";

export interface EmphasisClause {
  /**
   * The extraction fields that express this clause, in preference order. One
   * clause of the planner's can arrive under more than one field name — their
   * "Plan:" is our `recommendations` when the record states what was advised
   * and our `treatment` when it states what was given.
   */
  fields: readonly ClaimField[];
  /** Printed before the clause when it does not lead the summary. */
  prefix: string;
  /**
   * Share of the published entries of this kind that carried the clause.
   * Zero means the corpus never labelled it — the clause is retained from the
   * hand shape and yields to any measured clause competing for the same slot.
   */
  share: number;
  /**
   * Set when the weight was reasoned across from a different kind of entry
   * rather than measured on this one. It keeps a carried-over judgement from
   * reading as a measurement — the distinction this whole file exists to make.
   */
  carried?: true;
}

export interface EmphasisProfile {
  /** Whether this ordering was measured against the published plans. */
  basis: "published-corpus" | "hand-shaped";
  /** Published entries of this kind carrying labelled clauses. */
  observed: number;
  /**
   * The clauses in READING order — the compression clause first, then the
   * planner's own narrative order. Selection among them is by `share`, so this
   * array is the order a summary reads, not a priority list.
   */
  clauses: readonly EmphasisClause[];
}

const CORPUS = "published-corpus" as const;
const HAND = "hand-shaped" as const;

export const SUMMARY_EMPHASIS: Partial<Record<AnalysisClass, EmphasisProfile>> = {
  // 164 published encounter entries. Reading order is the planner's own:
  // subjective (share .91, position 0.00) → exam (.51, 0.95) → assessment
  // (.81, 1.56) → plan (.89, 2.65) → studies (.24, 2.87). Under a three-clause
  // cap the shares select subjective, plan and assessment, which read as the
  // S/A/P a reviewer reconstructs a course of care from.
  CLINICAL_ENCOUNTER: {
    basis: CORPUS,
    observed: 164,
    clauses: [
      { fields: ["subjective"], prefix: "reported: ", share: 0.91 },
      { fields: ["objectiveFindings"], prefix: "exam: ", share: 0.51 },
      { fields: ["assessment"], prefix: "assessment: ", share: 0.81 },
      { fields: ["recommendations", "treatment"], prefix: "plan: ", share: 0.89 },
      { fields: ["diagnosticStudies"], prefix: "studies: ", share: 0.24 },
      // CARRIED OVER, not measured. The published plans never label a procedure
      // inside a visit — but that is because the planner gives a procedure its
      // OWN chronology entry, where it leads every compressed entry there is.
      // That is evidence a documented procedure is the salient event of the
      // day, not evidence it is unimportant, so it ranks with the assessment.
      // Measured directly it would surely score higher; it is held level with
      // the assessment rather than guessed upward.
      { fields: ["procedure"], prefix: "procedure: ", share: 0.81, carried: true },
      { fields: ["disposition"], prefix: "disposition: ", share: 0 },
    ],
  },

  // 44 published study entries. The planner writes findings (.73) then
  // impression (.86); but of the eight compressed to one clause, six kept the
  // impression and none kept the findings. A summary compresses, so the
  // impression leads and the findings follow.
  DIAGNOSTIC_STUDY: {
    basis: CORPUS,
    observed: 44,
    clauses: [
      { fields: ["impression"], prefix: "impression: ", share: 0.86 },
      { fields: ["diagnosticStudies"], prefix: "findings: ", share: 0.73 },
      { fields: ["comparison"], prefix: "compared with: ", share: 0 },
      // No slot for the technique line: the planner records what a study showed
      // and never how it was acquired, and admitting it only pushed a real
      // finding out of a full summary.
    ],
  },

  // 17 published therapy entries: subjective (.94, always first) → plan (1.00)
  // → exam (.24) → assessment (.24). The planner's therapy "Subjective:" IS the
  // response narrative — how the patient reports responding since the last
  // session — so the lead clause prefers our `responseToTreatment` where the
  // record states it as such, and falls back to `subjective`.
  THERAPY_COURSE: {
    basis: CORPUS,
    observed: 17,
    clauses: [
      { fields: ["responseToTreatment", "subjective"], prefix: "response: ", share: 0.94 },
      { fields: ["objectiveFindings"], prefix: "measures: ", share: 0.24 },
      { fields: ["assessment"], prefix: "assessment: ", share: 0.24 },
      // The planner writes ONE "Plan:" paragraph for a therapy visit, and it
      // covers both the modality delivered that day and the course to continue.
      // Ours arrive as two fields, so the clause takes what was DELIVERED
      // first: "traction applied to the lumbar spine" is the substance of a
      // therapy note, where "continue current care" is the same sentence in
      // every one of them.
      { fields: ["treatment", "recommendations"], prefix: "care: ", share: 1.0 },
      { fields: ["functionalStatus"], prefix: "function: ", share: 0 },
    ],
  },

  // 23 published procedure entries, every one of which labelled a procedure,
  // and all six of the single-clause ones kept it. Thin evidence and skewed:
  // these are predominantly interventional-pain procedures, so only what the
  // corpus actually shows was adopted — the procedure lead and the agent
  // administered (.44). An open operation's findings, complications and
  // implants are never labelled in these five reports; they keep their hand
  // ordering behind the measured clauses.
  OPERATIVE: {
    basis: CORPUS,
    observed: 23,
    clauses: [
      { fields: ["procedure"], prefix: "procedure: ", share: 0.74 },
      // The corpus's "Medication used:" is the agent given DURING the
      // procedure — the injectate that distinguishes one block from the next.
      // Only `anesthesia` carries that meaning here; our `medications` is the
      // patient's medication LIST, and admitting it put a home statin where
      // the operation belonged on 22 real records. The corpus signal is real
      // and we can only honour the half of it our fields express.
      { fields: ["anesthesia"], prefix: "agent: ", share: 0.44 },
      { fields: ["postOperativeDiagnosis"], prefix: "post-op dx: ", share: 0 },
      { fields: ["operativeFindings"], prefix: "findings: ", share: 0 },
      { fields: ["complications"], prefix: "complications: ", share: 0 },
      { fields: ["implants"], prefix: "implants: ", share: 0 },
    ],
  },

  // ── Kinds the published plans do not chronicle ─────────────────────────────
  // A life-care planner's chronology covers care. It carries no billing lines,
  // no deposition entries, no insurance correspondence and no filings, so there
  // is nothing to learn from and these keep the shape they were given.
  ANESTHESIA: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["anesthesiaType"], prefix: "anesthesia: ", share: 0 },
      { fields: ["anesthesiaEvent"], prefix: "intraoperative: ", share: 0 },
      { fields: ["complications"], prefix: "complications: ", share: 0 },
    ],
  },
  PATHOLOGY_DIAGNOSTIC: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["pathologicDiagnosis"], prefix: "diagnosis: ", share: 0 },
      { fields: ["specimen"], prefix: "specimen: ", share: 0 },
      { fields: ["microscopicDescription"], prefix: "microscopic: ", share: 0 },
    ],
  },
  TESTIMONY: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["admission"], prefix: "admission: ", share: 0 },
      { fields: ["testimony"], prefix: "testimony: ", share: 0 },
      { fields: ["workStatus"], prefix: "work: ", share: 0 },
      { fields: ["functionalStatus"], prefix: "function: ", share: 0 },
    ],
  },
  EXPERT_OPINION: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["causationOpinion"], prefix: "causation opinion: ", share: 0 },
      { fields: ["opinion"], prefix: "opinion: ", share: 0 },
      { fields: ["assessment"], prefix: "stated diagnosis: ", share: 0 },
      { fields: ["recommendations"], prefix: "future care opinion: ", share: 0 },
    ],
  },
  INCIDENT: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["mechanism"], prefix: "mechanism: ", share: 0 },
      { fields: ["sceneFindings"], prefix: "scene: ", share: 0 },
      { fields: ["objectiveFindings"], prefix: "on assessment: ", share: 0 },
      { fields: ["treatment"], prefix: "treated: ", share: 0 },
    ],
  },
  FINANCIAL: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["charge"], prefix: "charge: ", share: 0 },
      { fields: ["serviceCode"], prefix: "code: ", share: 0 },
      { fields: ["billedAmount"], prefix: "amount: ", share: 0 },
      { fields: ["payer"], prefix: "payer: ", share: 0 },
    ],
  },
  EMPLOYMENT_ECONOMIC: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["employmentStatus"], prefix: "employment: ", share: 0 },
      { fields: ["earnings"], prefix: "earnings: ", share: 0 },
      { fields: ["employer"], prefix: "employer: ", share: 0 },
    ],
  },
  INSURANCE_ADMINISTRATIVE: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["claimStatus"], prefix: "claim: ", share: 0 },
      { fields: ["authorization"], prefix: "authorization: ", share: 0 },
      { fields: ["coverage"], prefix: "coverage: ", share: 0 },
    ],
  },
  LEGAL: {
    basis: HAND,
    observed: 0,
    clauses: [
      { fields: ["legalAssertion"], prefix: "asserts: ", share: 0 },
      { fields: ["reliefSought"], prefix: "relief sought: ", share: 0 },
      { fields: ["partyPosition"], prefix: "position: ", share: 0 },
    ],
  },
};

/** The emphasis profile for a kind of record, or null if it has none. */
export function emphasisFor(klass: AnalysisClass | null | undefined): EmphasisProfile | null {
  return SUMMARY_EMPHASIS[klass ?? "CLINICAL_ENCOUNTER"] ?? null;
}

/**
 * Which of the available clauses survive a cap of `max`, in reading order.
 *
 * Selection is by SHARE — how often the planner said this about this kind of
 * record — and never by the order the clauses happen to sit in. Ties hold
 * their reading order, so an unmeasured hand-shaped profile keeps exactly the
 * sequence it was written in.
 */
export function selectClauses<T extends { share: number }>(available: readonly T[], max: number): T[] {
  if (available.length <= max) return [...available];
  const kept = new Set(
    available
      .map((clause, index) => ({ clause, index }))
      .sort((a, b) => b.clause.share - a.clause.share || a.index - b.index)
      .slice(0, max)
      .map((c) => c.index),
  );
  return available.filter((_, index) => kept.has(index));
}
