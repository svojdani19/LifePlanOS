// ─────────────────────────────────────────────────────────────────────────────
// Learning what to emphasise, from plans a professional actually published.
//
// `summaryEmphasis.ts` holds what the program currently believes about which
// clauses a chronology entry should carry. This module is how that belief is
// FORMED: give it parsed published plans and it measures what the planner did,
// then proposes a profile in the same shape the program consumes.
//
// Three measurements, because they answer different questions:
//
//   • SHARE — how often the planner includes a clause at all. The honest
//     measure of what they consider worth saying about that kind of record.
//   • POSITION — mean ordinal position among the entries that include it.
//     Narrative order; it decides how the kept clauses read.
//   • COMPRESSION — among entries where the planner wrote exactly ONE clause,
//     how often it was this one. A one-line summary IS the compressed form, so
//     this decides what leads.
//
// A proposal is not an adoption. Nothing here writes to the profile the program
// runs on: a candidate is measured against held-out plans first (see
// `planAgreement.ts`), and adopting it is a code change a person commits. A
// medico-legal opinion engine that silently rewrites its own judgement between
// runs could not be explained on a witness stand, and would not deserve to be.
// ─────────────────────────────────────────────────────────────────────────────

import { PROFILES, type AnalysisClass } from "@/lib/documents/analysisClass";
import type { ClaimField } from "@/lib/llm/recordExtraction";
import type { EmphasisClause, EmphasisProfile } from "@/lib/llm/summaryEmphasis";
import type { PublishedEntry } from "@/lib/learning/publishedPlan";

export interface ClauseStat {
  label: string;
  /** Entries of this kind that carried the clause. */
  count: number;
  /** Share of the kind's labelled entries carrying it. */
  share: number;
  /** Mean ordinal position among entries that carried it. */
  meanPosition: number;
  /** Share of the kind's SINGLE-clause entries that kept this clause. */
  soloShare: number;
}

export interface KindStat {
  entries: number;
  /** Entries carrying at least one labelled clause — the measurable ones. */
  labelled: number;
  /** Entries the planner compressed to exactly one clause. */
  solo: number;
  clauses: ClauseStat[];
}

/**
 * The planner's vocabulary, mapped onto the fields our extraction produces.
 *
 * This is the one bridging judgement in the module and it is deliberately
 * explicit: a plan says "Plan:", we hold `recommendations` and `treatment`, and
 * deciding those are the same clause is a decision, not a measurement. Where a
 * label has no faithful field it maps to nothing and is reported as unmapped —
 * a real finding about a gap in our schema, not something to paper over.
 */
export const LABEL_FIELDS: Record<string, readonly ClaimField[]> = {
  subjective: ["subjective"],
  exam: ["objectiveFindings"],
  assessment: ["assessment"],
  plan: ["recommendations", "treatment"],
  "diagnostic studies": ["diagnosticStudies"],
  findings: ["diagnosticStudies"],
  impression: ["impression"],
  procedure: ["procedure"],
  "procedure performed": ["procedure"],
  // The agent given DURING a procedure. Our `medications` is the patient's
  // medication LIST and does not mean this; only `anesthesia` does.
  "medication used": ["anesthesia"],
  treatment: ["treatment"],
  disposition: ["disposition"],
  condition: ["functionalStatus"],
  testimony: ["testimony"],
  admission: ["admission"],
};

/** How a clause reads when it does not lead. */
const PREFIX: Record<string, string> = {
  subjective: "reported: ",
  exam: "exam: ",
  assessment: "assessment: ",
  plan: "plan: ",
  "diagnostic studies": "studies: ",
  findings: "findings: ",
  impression: "impression: ",
  procedure: "procedure: ",
  "procedure performed": "procedure: ",
  "medication used": "agent: ",
  treatment: "care: ",
  disposition: "disposition: ",
};

/** A kind needs this many labelled entries before its shape is worth trusting. */
export const MIN_ENTRIES_FOR_PROFILE = 12;

/** Measure what the planner did, per kind of record. */
export function measureEmphasis(entries: readonly PublishedEntry[]): Partial<Record<AnalysisClass, KindStat>> {
  const acc = new Map<AnalysisClass, { entries: number; labelled: number; solo: number; byLabel: Map<string, { count: number; posSum: number; soloCount: number }> }>();

  for (const e of entries) {
    const k = acc.get(e.kind) ?? { entries: 0, labelled: 0, solo: 0, byLabel: new Map() };
    acc.set(e.kind, k);
    k.entries += 1;
    if (!e.clauses.length) continue;
    k.labelled += 1;
    const isSolo = e.clauses.length === 1;
    if (isSolo) k.solo += 1;
    e.clauses.forEach((clause, pos) => {
      const s = k.byLabel.get(clause.label) ?? { count: 0, posSum: 0, soloCount: 0 };
      s.count += 1;
      s.posSum += pos;
      if (isSolo) s.soloCount += 1;
      k.byLabel.set(clause.label, s);
    });
  }

  const out: Partial<Record<AnalysisClass, KindStat>> = {};
  for (const [kind, k] of acc) {
    // A clause has to recur to count as part of this kind's shape; a single
    // appearance is one planner's one sentence, not a pattern.
    const floor = Math.max(2, k.labelled * 0.08);
    out[kind] = {
      entries: k.entries,
      labelled: k.labelled,
      solo: k.solo,
      clauses: [...k.byLabel.entries()]
        .filter(([, s]) => s.count >= floor)
        .map(([label, s]) => ({
          label,
          count: s.count,
          share: round(s.count / Math.max(1, k.labelled)),
          meanPosition: round(s.posSum / s.count),
          soloShare: round(s.soloCount / Math.max(1, k.solo)),
        }))
        .sort((a, b) => a.meanPosition - b.meanPosition),
    };
  }
  return out;
}

export interface Proposal {
  profiles: Partial<Record<AnalysisClass, EmphasisProfile>>;
  /** Clauses the planner writes that no field of ours expresses at all. */
  unmapped: { kind: AnalysisClass; label: string; share: number }[];
  /**
   * Clauses we DO have a field for, which this kind of document is not allowed
   * to express. A different finding from `unmapped` and a more interesting one:
   * the planner writes an assessment inside a procedure entry, and our
   * OPERATIVE vocabulary forbids one. Either they are taking a liberty or our
   * vocabulary is too narrow — and only a human can say which.
   */
  outsideVocabulary: { kind: AnalysisClass; label: string; share: number; fields: readonly ClaimField[] }[];
  /** Kinds seen but held back for want of evidence. */
  insufficient: { kind: AnalysisClass; labelled: number }[];
}

/**
 * Turn measurements into a candidate profile.
 *
 * Reading order is the planner's narrative order, with ONE exception that the
 * measurements themselves justify: the clause they keep when they keep only one
 * leads, because a one-line summary is the compressed form of an entry.
 */
export function proposeProfile(stats: Partial<Record<AnalysisClass, KindStat>>): Proposal {
  const profiles: Proposal["profiles"] = {};
  const unmapped: Proposal["unmapped"] = [];
  const outsideVocabulary: Proposal["outsideVocabulary"] = [];
  const insufficient: Proposal["insufficient"] = [];

  for (const [kindKey, stat] of Object.entries(stats)) {
    const kind = kindKey as AnalysisClass;
    if (!stat) continue;
    if (stat.labelled < MIN_ENTRIES_FOR_PROFILE) {
      insufficient.push({ kind, labelled: stat.labelled });
      continue;
    }

    const allowed = new Set<string>(PROFILES[kind]?.fields ?? []);
    const usable: (ClauseStat & { fields: readonly ClaimField[] })[] = [];
    const claimed = new Set<string>();
    for (const c of stat.clauses) {
      const known = LABEL_FIELDS[c.label];
      if (!known?.length) {
        unmapped.push({ kind, label: c.label, share: c.share });
        continue;
      }
      const mapped = known.filter((f) => allowed.has(f));
      if (!mapped.length) {
        outsideVocabulary.push({ kind, label: c.label, share: c.share, fields: known });
        continue;
      }
      // Two of the planner's labels can mean one clause of ours ("Procedure
      // performed:" and "Procedure:"). A second clause over the same field can
      // never fire — the first consumes the claim — so it would spend a slot of
      // a three-clause summary on nothing.
      const signature = mapped.join("|");
      if (claimed.has(signature)) continue;
      claimed.add(signature);
      usable.push({ ...c, fields: mapped });
    }
    if (!usable.length) continue;

    // The compression clause leads. With no compressed entries to learn from,
    // the clause the planner puts first most often does.
    const lead = [...usable].sort(
      (a, b) => b.soloShare - a.soloShare || a.meanPosition - b.meanPosition || b.share - a.share,
    )[0];
    const rest = usable.filter((c) => c !== lead).sort((a, b) => a.meanPosition - b.meanPosition);

    const toClause = (c: (typeof usable)[number]): EmphasisClause => ({
      fields: c.fields,
      prefix: PREFIX[c.label] ?? `${c.label}: `,
      share: c.share,
    });

    profiles[kind] = {
      basis: "published-corpus",
      observed: stat.labelled,
      clauses: [lead, ...rest].map(toClause),
    };
  }

  return { profiles, unmapped, outsideVocabulary, insufficient };
}

/**
 * What a candidate should look like before anyone adopts it.
 *
 * A derived profile only knows what the published plans could show it, and some
 * of what the program must get right is invisible there BY CONSTRUCTION. A
 * planner gives a procedure its own chronology entry, so no encounter entry
 * ever labels one — derive from that and the clause vanishes, and a visit where
 * an injection was performed stops saying so. Clauses the incumbent marks
 * `carried`, and any clause over a field the candidate does not cover, are
 * therefore kept; kinds the corpus never chronicles keep their profile whole.
 *
 * What this CANNOT preserve is the field order inside a clause — that our
 * therapy "care:" clause prefers the modality delivered over the course
 * advised is a judgement the planner's single "Plan:" paragraph cannot express
 * either way. Adoption stays a human diff for exactly that reason.
 */
export function mergeForAdoption(
  candidate: Partial<Record<AnalysisClass, EmphasisProfile>>,
  incumbent: Partial<Record<AnalysisClass, EmphasisProfile>>,
): Partial<Record<AnalysisClass, EmphasisProfile>> {
  const merged: Partial<Record<AnalysisClass, EmphasisProfile>> = { ...incumbent };
  for (const [kindKey, proposed] of Object.entries(candidate)) {
    const kind = kindKey as AnalysisClass;
    if (!proposed) continue;
    const prior = incumbent[kind];
    if (!prior) {
      merged[kind] = proposed;
      continue;
    }
    // Where a measured clause and an existing one are about the same thing,
    // the measurement supplies the WEIGHT and the existing clause supplies the
    // fields and wording. The corpus is the authority on what matters and in
    // what order; which of our fields best says it stays a human's call, and
    // that call is what a bare derivation would silently undo.
    const spoken = new Set<EmphasisClause>();
    const clauses = proposed.clauses.map((candidate) => {
      const overlap = prior.clauses.find(
        (p) => !spoken.has(p) && p.fields.some((f) => candidate.fields.includes(f)),
      );
      if (!overlap) return candidate;
      spoken.add(overlap);
      return { ...overlap, share: candidate.share };
    });
    // Anything the corpus had no opportunity to speak about is kept as it was.
    const untouched = prior.clauses.filter((p) => !spoken.has(p));
    merged[kind] = { ...proposed, clauses: [...clauses, ...untouched] };
  }
  return merged;
}

/**
 * Render a proposal as the TypeScript that `summaryEmphasis.ts` holds.
 *
 * This is the last step of the loop and deliberately the least clever one: a
 * validated proposal comes out as source a person reads, diffs against what the
 * program believes today, and commits. The program can therefore improve itself
 * on every new case that arrives with a published plan — but the improvement
 * lands as a reviewed change with the evidence beside it, not as a profile that
 * quietly differs from the one that produced last month's opinion.
 */
export function renderEmphasisSource(proposal: Proposal, provenance: string): string {
  const lines: string[] = [
    "// GENERATED by the learning harness — review before adopting.",
    `// ${provenance}`,
    "//",
    "// Emitted as compiling source, not as a snippet: a candidate that does not",
    "// typecheck is a candidate nobody can evaluate.",
    `import type { AnalysisClass } from "@/lib/documents/analysisClass";`,
    `import type { EmphasisProfile } from "@/lib/llm/summaryEmphasis";`,
    "",
    "// Each share is the fraction of that kind's labelled entries carrying the",
    "// clause. Reading order is the planner's, except that the clause they keep",
    "// when they keep only one leads.",
    "export const LEARNED_EMPHASIS: Partial<Record<AnalysisClass, EmphasisProfile>> = {",
  ];
  for (const [kind, profile] of Object.entries(proposal.profiles)) {
    if (!profile) continue;
    lines.push(`  ${kind}: {`);
    // Never restate a hand-shaped profile as a measured one. The distinction is
    // the whole point of recording a basis.
    lines.push(`    basis: ${JSON.stringify(profile.basis)},`);
    lines.push(`    observed: ${profile.observed},`);
    lines.push("    clauses: [");
    for (const c of profile.clauses) {
      const fields = c.fields.map((f) => `"${f}"`).join(", ");
      const carried = c.carried ? ", carried: true" : "";
      lines.push(`      { fields: [${fields}], prefix: ${JSON.stringify(c.prefix)}, share: ${c.share}${carried} },`);
    }
    lines.push("    ],");
    lines.push("  },");
  }
  lines.push("};");
  if (proposal.unmapped.length) {
    lines.push("");
    lines.push("// Clauses the planner writes that no field of ours expresses:");
    for (const u of proposal.unmapped) lines.push(`//   ${u.kind}: ${u.label} (in ${(u.share * 100).toFixed(0)}%)`);
  }
  if (proposal.outsideVocabulary.length) {
    lines.push("");
    lines.push("// Clauses we have a field for, which this kind of document may not express:");
    for (const o of proposal.outsideVocabulary) {
      lines.push(`//   ${o.kind}: ${o.label} → ${o.fields.join("/")} (in ${(o.share * 100).toFixed(0)}%)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
