// ─────────────────────────────────────────────────────────────────────────────
// Which diagnosis is this recommendation FOR?
//
// There were two answers to that, computed in different places, and both were
// rendered in the same panel. The evidence buckets were built from the item's
// stored `conditionId`; the Clinical Reasoning block beside them ran its own
// mapper, which prefers the region-inferred condition and only falls back to
// the stored one. A TENS unit stored against a lumbar disc injury but mapped
// by service text to something else produced a panel whose reasoning argued
// about one diagnosis while the findings beneath it belonged to another.
//
// One resolver, used by both. And when the two sources genuinely disagree,
// that is reported rather than silently settled — a stored link contradicting
// the service's own anatomy is something a planner should look at, not
// something the renderer should pick a winner for.
// ─────────────────────────────────────────────────────────────────────────────

import { mapRecommendationToCondition, bodyRegion, type RecInput, type CondInput } from "@/lib/engine/integrity";
import type { DossierCondition } from "@/lib/engine/medicalNecessity";

export interface ResolvedCondition {
  /** The one condition every part of this item's panel must use. */
  condition: DossierCondition | null;
  /** Where it came from, for disclosure. */
  source: "persisted" | "mapped" | "none";
  /** Set when the stored link and the inferred mapping name different diagnoses. */
  conflict: { persistedName: string; mappedName: string; otherName: string } | null;
}

interface ItemLike {
  service: string;
  specialty?: string | null;
  conditionId?: string | null;
}

/**
 * Resolve the single condition an item's whole panel is built from.
 *
 * The preference rule is unchanged and deliberate: a region-neutral service
 * (DME, medication, generic therapy) names no anatomy, so its stored link is
 * better evidence of what it serves than a mapper that can only read the
 * service text. Everywhere else the mapper wins.
 */
export function resolveRecommendationCondition(item: ItemLike, conditions: readonly CondInput[]): ResolvedCondition {
  // CANONICAL ORDER, before anything looks at the list.
  //
  // The mapper scores each candidate and keeps the best; equally-scoring
  // candidates were settled by whichever came first, which meant by whichever
  // ORDER the caller happened to query. The case page reads conditions by
  // confidence, the generator read them unordered — so the same recommendation
  // resolved to a lumbar diagnosis in one place and a cervical one in the
  // other, and the panel's evidence and the persisted ledger were arguing
  // about different injuries. Sorting here fixes it for every caller at once
  // rather than asking twelve query sites to agree.
  const ordered = [...conditions].sort((a, b) => {
    const conf = (c: CondInput) => (typeof (c as { confidence?: number }).confidence === "number" ? (c as { confidence?: number }).confidence! : -1);
    if (conf(a) !== conf(b)) return conf(b) - conf(a);
    return a.id.localeCompare(b.id);
  });
  const mapping = mapRecommendationToCondition(item as RecInput, ordered);
  const mapped = (ordered.find((c) => c.id === mapping.conditionId) ?? null) as DossierCondition | null;
  const persisted = (ordered.find((c) => c.id === (item.conditionId ?? null)) ?? null) as DossierCondition | null;

  // Region-neutrality is a property of the SERVICE, and this asked about the
  // service WITH the mapped condition's name appended — which is never neutral
  // once a diagnosis is in the string. It happened to work while the mapper
  // returned the caller's first condition, and stopped the moment the list was
  // ordered canonically. `mapping.region` is the service's own region.
  const usePersisted = persisted != null && mapping.region === "general" && bodyRegion(persisted.name) !== "general";
  const condition = usePersisted ? persisted : (mapped ?? persisted);

  // A disagreement is only real when BOTH sources named a diagnosis and they
  // are different ones. A mapper that found nothing is not disagreeing.
  const conflict =
    persisted && mapped && persisted.id !== mapped.id
      ? {
          persistedName: persisted.name,
          mappedName: mapped.name,
          otherName: (condition?.id === persisted.id ? mapped.name : persisted.name),
        }
      : null;

  return { condition, source: condition == null ? "none" : condition.id === persisted?.id ? "persisted" : "mapped", conflict };
}
