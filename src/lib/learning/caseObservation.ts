// ─────────────────────────────────────────────────────────────────────────────
// What a case teaches WITHOUT a published plan beside it.
//
// Most cases will never have one. A published Life Care Plan is the end of a
// months-long professional engagement, and a program that only learns from
// cases that already have one would learn from a handful and ignore the rest of
// the practice.
//
// So the two halves of learning are kept separate by what they can honestly
// claim. A published plan is the only thing that can say what SHOULD have been
// said — it is ground truth, and `emphasisLearning.ts` is where it is used.
// Every case, plan or no plan, can say what CAN be said: which fields our
// extraction actually produces for which kind of document, which clauses of the
// profile ever fire, and how often the profile fails to compose anything at all
// and the summary falls back.
//
// That second half needs no ground truth and is not a lesser signal. A clause
// that never fires is spending a slot of a three-clause summary on nothing. A
// kind of record that falls back more often than it composes has a profile that
// does not fit the documents. And when the two halves are put together they
// answer the question neither can alone: the planner says this about this kind
// of record, and our pipeline almost never produces it — which is not an
// emphasis problem to be re-ordered, but a gap to go and extract.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";
import type { ClaimField } from "@/lib/llm/recordExtraction";
import type { EmphasisProfile } from "@/lib/llm/summaryEmphasis";
import { chooseSummaryClauses, isBoilerplate, isIntakeRecital, isNonSubstantive } from "@/lib/llm/summaryShape";
import type { Proposal } from "@/lib/learning/emphasisLearning";

/** One extracted encounter, as much of it as observation needs. */
export interface ObservedEncounter {
  analysisClass: AnalysisClass | null;
  claims: { field: string; value: string }[];
}

export interface FieldYield {
  field: string;
  /** Encounters of this kind carrying a usable claim in the field. */
  withField: number;
  /** Share of the kind's encounters that do. */
  yield: number;
}

export interface ClauseRealization {
  fields: readonly string[];
  /** What the profile believes about the clause. */
  share: number;
  /** Encounters where the clause had a claim to draw on. */
  fired: number;
  /** Encounters where it survived the three-clause cap into the summary. */
  selected: number;
  fireRate: number;
  selectRate: number;
}

export interface KindObservation {
  kind: AnalysisClass;
  encounters: number;
  /** Encounters where the profile composed a summary. */
  composed: number;
  /** Encounters where nothing was composed and the caller had to fall back. */
  fellBack: number;
  /**
   * Of those, the ones with no profile for the kind at all.
   *
   * This is usually correct rather than broken. A class with a single field —
   * unclassified evidence has only `documentContent` — has no shape to impose,
   * and the fallback path states that one fact with a more generous length than
   * a clause of a three-clause summary would allow. Counting it as a failure
   * sent me looking for a defect that was a design working as intended.
   */
  noProfile: number;
  /**
   * Of those, the ones where a profile EXISTS and not one of its clauses could
   * draw on anything. This is the real misfit: the program holds a belief about
   * what this kind of record says and our extraction produces something else.
   */
  profileMissed: number;
  /** Mean clauses per composed summary — below the cap means starved. */
  meanClauses: number;
  fieldYield: FieldYield[];
  clauses: ClauseRealization[];
}

export type CaseObservation = Partial<Record<AnalysisClass, KindObservation>>;

/** The filter composition itself applies, so yield measures what is USABLE. */
const usable = (value: string) =>
  value.trim().length > 2 && !isNonSubstantive(value) && !isBoilerplate(value) && !isIntakeRecital(value);

/**
 * Measure what a case's own records can support, under a given profile.
 *
 * No ground truth is consulted and none is needed: every number here is a fact
 * about our own output.
 */
export function observeCase(
  encounters: readonly ObservedEncounter[],
  profileFor: (kind: AnalysisClass) => EmphasisProfile | null,
): CaseObservation {
  const acc = new Map<
    AnalysisClass,
    {
      encounters: number;
      composed: number;
      noProfile: number;
      clauseTotal: number;
      fields: Map<string, number>;
      clauses: Map<string, { fields: readonly string[]; share: number; fired: number; selected: number }>;
    }
  >();

  for (const e of encounters) {
    const kind = (e.analysisClass ?? "CLINICAL_ENCOUNTER") as AnalysisClass;
    const k = acc.get(kind) ?? { encounters: 0, composed: 0, noProfile: 0, clauseTotal: 0, fields: new Map(), clauses: new Map() };
    acc.set(kind, k);
    k.encounters += 1;

    const present = new Set(e.claims.filter((c) => usable(c.value)).map((c) => c.field));
    for (const f of present) k.fields.set(f, (k.fields.get(f) ?? 0) + 1);

    const profile = profileFor(kind);
    if (!profile) {
      k.noProfile += 1;
      continue;
    }

    const chosen = chooseSummaryClauses(kind, e.claims, profile);
    if (chosen.length) {
      k.composed += 1;
      k.clauseTotal += chosen.length;
    }
    const selectedFields = new Set(chosen.map((c) => c.field));
    for (const clause of profile.clauses) {
      const key = clause.fields.join("|");
      const entry = k.clauses.get(key) ?? { fields: clause.fields, share: clause.share, fired: 0, selected: 0 };
      // The clause "fired" when any of its fields had something usable to say —
      // whether or not it then survived the cap.
      if (clause.fields.some((f) => present.has(f))) entry.fired += 1;
      if (clause.fields.some((f) => selectedFields.has(f))) entry.selected += 1;
      k.clauses.set(key, entry);
    }
  }

  const out: CaseObservation = {};
  for (const [kind, k] of acc) {
    out[kind] = {
      kind,
      encounters: k.encounters,
      composed: k.composed,
      fellBack: k.encounters - k.composed,
      noProfile: k.noProfile,
      profileMissed: k.encounters - k.composed - k.noProfile,
      meanClauses: k.composed ? round(k.clauseTotal / k.composed) : 0,
      fieldYield: [...k.fields.entries()]
        .map(([field, withField]) => ({ field, withField, yield: round(withField / k.encounters) }))
        .sort((a, b) => b.yield - a.yield),
      clauses: [...k.clauses.values()]
        .map((c) => ({
          fields: c.fields,
          share: c.share,
          fired: c.fired,
          selected: c.selected,
          fireRate: round(c.fired / k.encounters),
          selectRate: round(c.selected / k.encounters),
        }))
        .sort((a, b) => b.fireRate - a.fireRate),
    };
  }
  return out;
}

/** Add up observations across every case, with or without a published plan. */
export function mergeObservations(observations: readonly CaseObservation[]): CaseObservation {
  const merged: CaseObservation = {};
  for (const obs of observations) {
    for (const [kindKey, o] of Object.entries(obs)) {
      const kind = kindKey as AnalysisClass;
      if (!o) continue;
      const prior = merged[kind];
      if (!prior) {
        merged[kind] = { ...o, fieldYield: [...o.fieldYield], clauses: [...o.clauses] };
        continue;
      }
      const encounters = prior.encounters + o.encounters;
      const composed = prior.composed + o.composed;
      merged[kind] = {
        kind,
        encounters,
        composed,
        fellBack: prior.fellBack + o.fellBack,
        noProfile: prior.noProfile + o.noProfile,
        profileMissed: prior.profileMissed + o.profileMissed,
        meanClauses: composed
          ? round((prior.meanClauses * prior.composed + o.meanClauses * o.composed) / composed)
          : 0,
        fieldYield: sumBy(
          [...prior.fieldYield, ...o.fieldYield],
          (f) => f.field,
          (a, b) => ({ field: a.field, withField: a.withField + b.withField, yield: 0 }),
        ).map((f) => ({ ...f, yield: round(f.withField / encounters) })).sort((a, b) => b.yield - a.yield),
        clauses: sumBy(
          [...prior.clauses, ...o.clauses],
          (c) => c.fields.join("|"),
          (a, b) => ({ ...a, fired: a.fired + b.fired, selected: a.selected + b.selected }),
        ).map((c) => ({
          ...c,
          fireRate: round(c.fired / encounters),
          selectRate: round(c.selected / encounters),
        })).sort((a, b) => b.fireRate - a.fireRate),
      };
    }
  }
  return merged;
}

export interface EmphasisGap {
  kind: AnalysisClass;
  fields: readonly ClaimField[];
  /** How often the planner writes this clause. */
  plannerShare: number;
  /** How often our extraction gives us anything to write it from. */
  ourYield: number;
}

/**
 * Where the published plans and our own output disagree about what is even
 * available — the join between the two halves of learning.
 *
 * A clause the planner writes in most entries that our pipeline can fill in few
 * is not something to re-order a summary around. It is a fact we are not
 * extracting, and it names the next piece of work precisely.
 */
export function findEmphasisGaps(
  proposal: Proposal,
  observed: CaseObservation,
  opts: { minPlannerShare?: number; maxYield?: number } = {},
): EmphasisGap[] {
  const minPlannerShare = opts.minPlannerShare ?? 0.5;
  const maxYield = opts.maxYield ?? 0.25;
  const gaps: EmphasisGap[] = [];

  for (const [kindKey, profile] of Object.entries(proposal.profiles)) {
    const kind = kindKey as AnalysisClass;
    if (!profile) continue;
    const obs = observed[kind];
    if (!obs) continue;
    for (const clause of profile.clauses) {
      if (clause.share < minPlannerShare) continue;
      const best = Math.max(
        0,
        ...clause.fields.map((f) => obs.fieldYield.find((y) => y.field === f)?.yield ?? 0),
      );
      if (best <= maxYield) {
        gaps.push({ kind, fields: clause.fields, plannerShare: clause.share, ourYield: best });
      }
    }
  }
  return gaps.sort((a, b) => b.plannerShare - a.plannerShare - (b.ourYield - a.ourYield));
}

// ── Checking a case that has no plan to check it against ─────────────────────
//
// A published plan is how we know a case was chronicled well. Most cases will
// never have one, and the program has to be as good on those — which means more
// than behaving the same way. It means being able to say when something has
// gone wrong on a case nobody can grade.
//
// It can, because a case is never the only case. The cases that DO have plans
// establish what normal looks like: how often composition finds nothing, how
// many clauses a summary carries, what each field yields for each kind of
// record. A new case is then checked against that distribution. This does not
// prove a case is right — nothing without ground truth can — but it reliably
// catches the ways a case goes wrong in practice: a document set that OCR'd
// badly, a record kind our extraction handles poorly, a profile that does not
// fit the documents in front of it.

export interface KindNorm {
  kind: AnalysisClass;
  /** Cases contributing to this norm. */
  cases: number;
  medianMisfitRate: number;
  medianMeanClauses: number;
  /** Median yield per field across cases. */
  medianYield: Record<string, number>;
}

export type Norms = Partial<Record<AnalysisClass, KindNorm>>;

/** A norm needs this many cases before deviation from it means anything. */
export const MIN_CASES_FOR_NORM = 3;

/** What normal looks like, learned from cases already observed. */
export function deriveNorms(observations: readonly CaseObservation[]): Norms {
  const byKind = new Map<AnalysisClass, KindObservation[]>();
  for (const obs of observations) {
    for (const [kindKey, o] of Object.entries(obs)) {
      if (!o || !o.encounters) continue;
      const kind = kindKey as AnalysisClass;
      byKind.set(kind, [...(byKind.get(kind) ?? []), o]);
    }
  }

  const norms: Norms = {};
  for (const [kind, list] of byKind) {
    if (list.length < MIN_CASES_FOR_NORM) continue;
    const fields = new Set(list.flatMap((o) => o.fieldYield.map((f) => f.field)));
    const medianYield: Record<string, number> = {};
    for (const field of fields) {
      // A case that never produced the field counts as a zero, not as absent —
      // otherwise a field that only one case ever yields looks universal.
      medianYield[field] = median(list.map((o) => o.fieldYield.find((f) => f.field === field)?.yield ?? 0));
    }
    norms[kind] = {
      kind,
      cases: list.length,
      medianMisfitRate: median(list.map((o) => o.profileMissed / o.encounters)),
      medianMeanClauses: median(list.map((o) => o.meanClauses)),
      medianYield,
    };
  }
  return norms;
}

export interface Anomaly {
  kind: AnalysisClass;
  measure: string;
  value: number;
  expected: number;
  detail: string;
}

/**
 * Where a case departs from what cases of its kind normally look like.
 *
 * Thresholds are deliberately loose. This is a screen that decides where a
 * reviewer looks first, not a verdict — a case genuinely can hold records
 * unlike any seen before, and calling that a defect would train a reviewer to
 * ignore the whole report.
 */
export function checkAgainstNorms(observation: CaseObservation, norms: Norms, minEncounters = 10): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [kindKey, o] of Object.entries(observation)) {
    const kind = kindKey as AnalysisClass;
    const norm = norms[kind];
    // Without a norm, or with too few records, there is nothing to say. Saying
    // it anyway is how a screen becomes noise.
    if (!o || !norm || o.encounters < minEncounters) continue;

    const misfit = o.profileMissed / o.encounters;
    if (misfit > norm.medianMisfitRate + 0.2) {
      out.push({
        kind,
        measure: "composition misfit",
        value: round(misfit),
        expected: round(norm.medianMisfitRate),
        detail: `${o.profileMissed} of ${o.encounters} records produced no summary; typically ${pctish(norm.medianMisfitRate)}`,
      });
    }

    if (o.meanClauses < norm.medianMeanClauses - 0.5) {
      out.push({
        kind,
        measure: "summary thinness",
        value: o.meanClauses,
        expected: norm.medianMeanClauses,
        detail: `summaries average ${o.meanClauses} clauses against a usual ${norm.medianMeanClauses} — records may have extracted poorly`,
      });
    }

    for (const [field, expected] of Object.entries(norm.medianYield)) {
      // Only fields that normally arrive can be conspicuous by their absence.
      if (expected < 0.3) continue;
      const actual = o.fieldYield.find((f) => f.field === field)?.yield ?? 0;
      if (actual < expected / 2) {
        out.push({
          kind,
          measure: `missing ${field}`,
          value: actual,
          expected: round(expected),
          detail: `${field} appears in ${pctish(actual)} of these records; usually ${pctish(expected)}`,
        });
      }
    }
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};
const pctish = (n: number) => `${Math.round(n * 100)}%`;

/** Profile clauses that never had anything to say, across every case observed. */
export function findDeadClauses(observed: CaseObservation): { kind: AnalysisClass; fields: readonly string[]; encounters: number }[] {
  const dead: { kind: AnalysisClass; fields: readonly string[]; encounters: number }[] = [];
  for (const [kindKey, o] of Object.entries(observed)) {
    const kind = kindKey as AnalysisClass;
    if (!o || o.encounters < 20) continue; // too few to call anything dead
    for (const c of o.clauses) if (c.fired === 0) dead.push({ kind, fields: c.fields, encounters: o.encounters });
  }
  return dead;
}

function sumBy<T>(items: T[], key: (t: T) => string, combine: (a: T, b: T) => T): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const prior = map.get(k);
    map.set(k, prior ? combine(prior, item) : item);
  }
  return [...map.values()];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
