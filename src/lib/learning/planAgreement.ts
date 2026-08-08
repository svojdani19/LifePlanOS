// ─────────────────────────────────────────────────────────────────────────────
// How close is the program to the plan a professional published?
//
// Without a number, "the summaries got better" is an opinion. This module turns
// a published plan and the program's own output for the same case into four
// measurements, each answering a question a different layer is responsible for:
//
//   • DATE RECALL — of the dates the planner chronicled, how many does the
//     program have an entry for? This is coverage, and it is the ingestion
//     layer's responsibility.
//   • EXTRACTION RECALL — of the clinically salient terms in the planner's
//     entry, how many appear anywhere in the claims we extracted for that date?
//     This asks whether we captured the fact AT ALL.
//   • SUMMARY RECALL — how many of those terms reached the one-line summary?
//     This asks whether we surfaced the RIGHT facts, and it is what the
//     emphasis profile governs.
//   • LEAD AGREEMENT — did the program lead the entry with the same kind of
//     clause the planner led with?
//
// Separating extraction recall from summary recall is the point. A term the
// planner used that we never extracted is an extraction defect; a term we
// extracted but left out of the summary is an emphasis defect. One number for
// both would say something got worse without saying which thing to fix.
// ─────────────────────────────────────────────────────────────────────────────

import { LABEL_FIELDS } from "@/lib/learning/emphasisLearning";
import type { PublishedEntry } from "@/lib/learning/publishedPlan";

/** One dated entry as the program produced it. */
export interface ProgramEntry {
  isoDate: string;
  /** The field the program's summary led with, if it composed one. */
  leadField: string | null;
  /** The rendered one-line summary. */
  summary: string;
  /** Every validated claim value for the encounter, for extraction recall. */
  claimText: string;
}

export interface AgreementScore {
  publishedEntries: number;
  programEntries: number;
  publishedDates: number;
  matchedDates: number;
  /** Share of the planner's chronicled dates the program also has. */
  dateRecall: number;
  /** Dates the program has that the planner did not chronicle. */
  unmatchedProgramDates: number;
  /** Salient terms the planner used that appear in our claims. */
  extractionRecall: number;
  /** Salient terms the planner used that reached our summary. */
  summaryRecall: number;
  /**
   * Of the terms OUR summary spends its space on, how many the planner also
   * used for that date.
   *
   * Recall alone is unfair to a bounded summary and always will be: the
   * planner's entry runs to paragraphs and ours is one line of three clauses,
   * so it cannot contain most of what they wrote however well it is chosen.
   * Precision asks the question a one-line summary can actually be held to —
   * is what we chose to say the kind of thing the professional said? — and it
   * is the measure the emphasis profile is accountable to.
   */
  summaryPrecision: number;
  /** Matched dates where a lead clause could be compared at all. */
  leadComparable: number;
  /** Of those, how often the program led with the clause the planner did. */
  leadAgreement: number;
}

// Words that carry no clinical weight. Deliberately short: the point is to
// strip grammar, not to curate a medical vocabulary — curating one would decide
// in advance what counts as important, which is the very thing being measured.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "was", "were", "that", "this", "from", "have", "has", "had", "his", "her", "their",
  "patient", "reported", "reports", "noted", "states", "stated", "also", "been", "which", "there", "would", "could",
  "will", "any", "all", "not", "but", "are", "his", "she", "him", "they", "them", "who", "how", "per", "due",
  "into", "onto", "over", "under", "after", "before", "during", "while", "when", "then", "than", "upon", "each",
  "some", "such", "same", "other", "including", "include", "included", "well", "left", "right", "both",
  "continue", "continued", "advised", "instructed", "recommended", "performed", "following", "further",
]);

/**
 * The terms in a passage a reviewer would call substantive.
 *
 * Anatomic level tokens (C5-C6, L4-L5) are kept whole — they are the single
 * most load-bearing detail in a spine record and splitting them on the hyphen
 * would throw the level away.
 */
export function salientTerms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const level of lower.matchAll(/\b[ctls]\d{1,2}\s*[-–]\s*[ctls]?\d{1,2}\b/g)) {
    out.add(level[0].replace(/\s+/g, ""));
  }
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

const overlap = (want: Set<string>, have: Set<string>): { hit: number; total: number } => {
  let hit = 0;
  for (const t of want) if (have.has(t)) hit += 1;
  return { hit, total: want.size };
};

/**
 * Score the program's chronology for one case against the plan published for
 * that same case.
 *
 * Matching is by date. A planner may chronicle several encounters on one date
 * and the program merges same-day records differently, so the comparison is
 * made per DATE rather than per entry, and a lead clause counts as agreeing if
 * it matches any of the entries the planner wrote for that date.
 */
export function scoreAgreement(published: readonly PublishedEntry[], program: readonly ProgramEntry[]): AgreementScore {
  const publishedByDate = new Map<string, PublishedEntry[]>();
  for (const e of published) {
    if (!e.isoDate) continue;
    const list = publishedByDate.get(e.isoDate) ?? [];
    list.push(e);
    publishedByDate.set(e.isoDate, list);
  }
  const programByDate = new Map<string, ProgramEntry[]>();
  for (const p of program) {
    const list = programByDate.get(p.isoDate) ?? [];
    list.push(p);
    programByDate.set(p.isoDate, list);
  }

  let matchedDates = 0;
  let extractionHit = 0;
  let extractionTotal = 0;
  let summaryHit = 0;
  let summaryTotal = 0;
  let precisionHit = 0;
  let precisionTotal = 0;
  let leadComparable = 0;
  let leadAgreed = 0;

  for (const [date, entries] of publishedByDate) {
    const ours = programByDate.get(date);
    if (!ours?.length) continue;
    matchedDates += 1;

    const wanted = salientTerms(entries.flatMap((e) => e.clauses.map((c) => c.text)).join(" "));
    const claimTerms = salientTerms(ours.map((o) => o.claimText).join(" "));
    const summaryTerms = salientTerms(ours.map((o) => o.summary).join(" "));
    const ext = overlap(wanted, claimTerms);
    const sum = overlap(wanted, summaryTerms);
    extractionHit += ext.hit;
    extractionTotal += ext.total;
    summaryHit += sum.hit;
    summaryTotal += sum.total;
    const prec = overlap(summaryTerms, wanted);
    precisionHit += prec.hit;
    precisionTotal += prec.total;

    // What the planner led this date with, expressed in our field vocabulary.
    const theirLeadFields = new Set<string>();
    for (const e of entries) {
      const label = e.clauses[0]?.label;
      if (label) for (const f of LABEL_FIELDS[label] ?? []) theirLeadFields.add(f);
    }
    const ourLeads = ours.map((o) => o.leadField).filter((f): f is string => Boolean(f));
    if (theirLeadFields.size && ourLeads.length) {
      leadComparable += 1;
      if (ourLeads.some((f) => theirLeadFields.has(f))) leadAgreed += 1;
    }
  }

  let unmatchedProgramDates = 0;
  for (const date of programByDate.keys()) if (!publishedByDate.has(date)) unmatchedProgramDates += 1;

  return {
    publishedEntries: published.length,
    programEntries: program.length,
    publishedDates: publishedByDate.size,
    matchedDates,
    dateRecall: ratio(matchedDates, publishedByDate.size),
    unmatchedProgramDates,
    extractionRecall: ratio(extractionHit, extractionTotal),
    summaryRecall: ratio(summaryHit, summaryTotal),
    summaryPrecision: ratio(precisionHit, precisionTotal),
    leadComparable,
    leadAgreement: ratio(leadAgreed, leadComparable),
  };
}

const ratio = (hit: number, total: number) => (total === 0 ? 0 : Math.round((hit / total) * 1000) / 1000);
