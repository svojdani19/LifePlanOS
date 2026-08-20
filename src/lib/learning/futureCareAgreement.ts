// ─────────────────────────────────────────────────────────────────────────────
// How close is the generated plan to the plan a professional published?
//
// The chronology already has this (`planAgreement.ts`), separating coverage
// from extraction from emphasis so a number says which layer to fix. Future
// care had nothing equivalent — the gold harness read every current
// FutureCareItem on the source case, INCLUDING the 37 imported from the
// published plan itself, and scored the answer key against itself.
//
// Two rules make this honest:
//
//   BLIND. The candidate set is the generator's own output only: no reference
//   imports, no physician additions, no post-review modifications. Whoever
//   calls this is responsible for that snapshot, and `assertBlind` will refuse
//   a contaminated one rather than quietly scoring it.
//
//   CANONICAL IDENTITY. Matching is by resolved intervention plus anatomy, not
//   by word overlap. Overlap scored "Lumbar ESI" against "Cervical ESI" as a
//   hit (0.75 shared words) and missed "TKA" against "Total knee arthroplasty"
//   entirely — wrong in both directions at once.
//
// A published item the records could not support is still a MISS worth
// reporting, but it is a different kind of miss: it may be teaching the system
// which care to CONSIDER rather than exposing a support defect. The caller
// adjudicates; this module reports.
// ─────────────────────────────────────────────────────────────────────────────

import { bundleKey, resolveIntervention, type InterventionId, type ServiceFamily } from "@/lib/engine/serviceOntology";

export interface ScoredItem {
  service: string;
  category?: string | null;
  frequencyPerYear?: number | null;
  durationYears?: number | null;
  isLifetime?: boolean;
  presentValue?: number | null;
  /** Generated items only: what put it in the plan. */
  origin?: string | null;
  physicianStatus?: string | null;
}

export type MatchKind =
  /** One generated item, one published item. */
  | "EXACT"
  /** Several generated lines collapse onto one published concept (add-ons). */
  | "BUNDLED"
  /** One generated line covers several published lines. */
  | "SPLIT";

export interface Matched {
  kind: MatchKind;
  intervention: InterventionId;
  family: ServiceFamily;
  generated: ScoredItem[];
  published: ScoredItem[];
  /** Parameter agreement, computed on the bundle's totals. */
  frequencyAgrees: boolean | null;
  durationAgrees: boolean | null;
  lifetimeAgrees: boolean | null;
}

export interface AgreementResult {
  matched: Matched[];
  /** Published concepts the generator never proposed. */
  missed: { intervention: InterventionId; family: ServiceFamily; items: ScoredItem[]; publishedPV: number }[];
  /** Generated concepts absent from the published plan — candidates for adjudication. */
  unexpected: { intervention: InterventionId; family: ServiceFamily; items: ScoredItem[]; generatedPV: number }[];
  precision: number;
  recall: number;
  f1: number;
  /** Recall weighted by the published plan's dollars, not by line count. */
  dollarWeightedRecall: number;
  /** Of matched bundles, the share whose frequency/duration agree. */
  frequencyAgreement: number;
  durationAgreement: number;
  lifetimeAgreement: number;
  /** Recall within each service family — where the gaps actually are. */
  familyRecall: { family: ServiceFamily; found: number; published: number }[];
  publishedPV: number;
  generatedPV: number;
}

/** Within 25% — the tolerance the existing gold scorer already uses. */
const within25 = (expected: number, actual: number): boolean =>
  expected === 0 ? actual === 0 : Math.abs(actual - expected) <= 0.25 * Math.abs(expected);

const pv = (xs: ScoredItem[]) => xs.reduce((a, x) => a + (x.presentValue ?? 0), 0);

/**
 * Refuse a contaminated candidate set.
 *
 * The whole failure this module exists to prevent is scoring the answer key
 * against itself, so it fails loudly rather than reporting a flattering number.
 */
export function assertBlind(generated: readonly ScoredItem[]): void {
  const leaked = generated.filter(
    (g) => g.origin === "GOLD_IMPORT" || g.origin === "PHYSICIAN_ADDED" || g.origin === "PLANNER_ADDED" ||
      g.physicianStatus === "APPROVED" || g.physicianStatus === "MODIFIED",
  );
  if (leaked.length) {
    throw new Error(
      `Blind evaluation refused: ${leaked.length} candidate item(s) are not generator output ` +
        `(${[...new Set(leaked.map((l) => l.origin ?? l.physicianStatus))].join(", ")}). ` +
        `Score the frozen pre-review generator snapshot, not the reviewed plan.`,
    );
  }
}

export function scoreFutureCareAgreement(generated: readonly ScoredItem[], published: readonly ScoredItem[]): AgreementResult {
  assertBlind(generated);

  const group = (xs: readonly ScoredItem[]) => {
    const m = new Map<string, ScoredItem[]>();
    for (const x of xs) {
      if (resolveIntervention(x).id === "UNCLASSIFIED") continue;
      const k = bundleKey(x);
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  };
  const g = group(generated);
  const p = group(published);

  const matched: AgreementResult["matched"] = [];
  const missed: AgreementResult["missed"] = [];
  const unexpected: AgreementResult["unexpected"] = [];

  for (const [key, pubItems] of p) {
    const genItems = g.get(key);
    const r = resolveIntervention(pubItems[0]);
    if (!genItems) {
      missed.push({ intervention: r.id, family: r.family, items: pubItems, publishedPV: pv(pubItems) });
      continue;
    }
    const kind: MatchKind = genItems.length > 1 && pubItems.length === 1 ? "BUNDLED" : pubItems.length > 1 && genItems.length === 1 ? "SPLIT" : "EXACT";
    // Parameters are compared on the bundle, because a planner's single line
    // and a generator's base-plus-add-on describe the same course of care.
    const gf = genItems.reduce((a, x) => a + (x.frequencyPerYear ?? 0), 0);
    const pf = pubItems.reduce((a, x) => a + (x.frequencyPerYear ?? 0), 0);
    const gd = Math.max(...genItems.map((x) => x.durationYears ?? 0));
    const pd = Math.max(...pubItems.map((x) => x.durationYears ?? 0));
    matched.push({
      kind,
      intervention: r.id,
      family: r.family,
      generated: genItems,
      published: pubItems,
      frequencyAgrees: pf > 0 || gf > 0 ? within25(pf, gf) : null,
      durationAgrees: pd > 0 || gd > 0 ? within25(pd, gd) : null,
      lifetimeAgrees: genItems.some((x) => x.isLifetime) === pubItems.some((x) => x.isLifetime),
    });
  }
  for (const [key, genItems] of g) {
    if (p.has(key)) continue;
    const r = resolveIntervention(genItems[0]);
    unexpected.push({ intervention: r.id, family: r.family, items: genItems, generatedPV: pv(genItems) });
  }

  const found = matched.length;
  const precision = found + unexpected.length ? found / (found + unexpected.length) : 0;
  const recall = found + missed.length ? found / (found + missed.length) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const publishedPV = pv([...published]);
  const foundPV = matched.reduce((a, m) => a + pv(m.published), 0);

  const rate = (xs: (boolean | null)[]) => {
    const known = xs.filter((x) => x !== null) as boolean[];
    return known.length ? known.filter(Boolean).length / known.length : 0;
  };

  const families = new Map<ServiceFamily, { found: number; published: number }>();
  for (const m of matched) {
    const e = families.get(m.family) ?? { found: 0, published: 0 };
    families.set(m.family, { found: e.found + 1, published: e.published + 1 });
  }
  for (const m of missed) {
    const e = families.get(m.family) ?? { found: 0, published: 0 };
    families.set(m.family, { found: e.found, published: e.published + 1 });
  }

  return {
    matched,
    missed,
    unexpected,
    precision,
    recall,
    f1,
    dollarWeightedRecall: publishedPV > 0 ? foundPV / publishedPV : 0,
    frequencyAgreement: rate(matched.map((m) => m.frequencyAgrees)),
    durationAgreement: rate(matched.map((m) => m.durationAgrees)),
    lifetimeAgreement: rate(matched.map((m) => m.lifetimeAgrees)),
    familyRecall: [...families.entries()].map(([family, v]) => ({ family, ...v })).sort((a, b) => b.published - a.published),
    publishedPV,
    generatedPV: pv([...generated]),
  };
}
