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
  const mapping = mapRecommendationToCondition(item as RecInput, [...conditions]);
  const mapped = (conditions.find((c) => c.id === mapping.conditionId) ?? null) as DossierCondition | null;
  const persisted = (conditions.find((c) => c.id === (item.conditionId ?? null)) ?? null) as DossierCondition | null;

  const mappedRegion = bodyRegion(`${item.service} ${mapped?.name ?? ""}`);
  const usePersisted = persisted != null && mappedRegion === "general" && bodyRegion(persisted.name) !== "general";
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
