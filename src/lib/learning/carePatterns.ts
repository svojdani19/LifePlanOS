// ─────────────────────────────────────────────────────────────────────────────
// Which KINDS of care an experienced planner considers for which kind of case.
//
// This is the half of reference learning that changes what the generator finds,
// and it is the half most likely to be done wrongly. The wrong version copies
// a published plan's line items into a new case. That is not learning — it is
// laundering one patient's plan through another's file, and the physician
// signing it would have no way to see it.
//
// What generalises is the PATTERN: for a case with a lumbar diagnosis and
// documented radicular symptoms, planners considered an epidural pathway in 4
// of 5 reference plans. That is a fact about professional practice, not about
// any patient. It licenses the generator to CONSIDER the intervention — to put
// it in front of a reviewer as a candidate — and it never supplies support for
// it. Support still has to come from this patient's own record.
//
// Two guarantees, both tested:
//
//   • a pattern records an InterventionId and a count, never a service name, a
//     frequency, a cost, or any text from a plan;
//   • a pattern can raise an item to CANDIDATE_REVIEW and can never raise it
//     past that, whatever its support in the corpus.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveIntervention, type InterventionId, type ServiceFamily } from "@/lib/engine/serviceOntology";
import type { SupportClass } from "@/lib/engine/supportClass";

/** The case features a pattern is keyed to. Coarse on purpose: a pattern that
 *  keys on too much is a memory of one case wearing a pattern's clothes. */
export interface CaseSignature {
  /** Canonical condition keys already used by the care library. */
  conditionKeys: string[];
  /** Body regions documented anywhere in the case. */
  regions: string[];
}

export interface CarePattern {
  intervention: InterventionId;
  family: ServiceFamily;
  /** The signature this pattern was observed under. */
  conditionKey: string;
  /** How many reference plans included it for that key. */
  observedIn: number;
  /** How many reference plans had that key at all. */
  outOf: number;
}

export const CARE_PATTERN_VERSION = "care-pattern-1";

/**
 * The smallest corpus a pattern may generalise from.
 *
 * Measured, not chosen for comfort: with ONE reference plan every pattern is
 * "1 of 1, 100%", and every condition key in that case inherits every item in
 * it. That is a memory of one plan wearing a pattern's clothes, and it would
 * push one patient's care list onto every case sharing a diagnosis keyword.
 *
 * Below this, `suggestedInterventions` returns nothing. The corpus currently
 * holds ONE preserved plan, so the pattern layer is deliberately inert until
 * more reference cases are generated — see docs/reference-learning.md.
 */
export const MIN_CORPUS_PLANS = 3;

export interface PatternSource {
  conditionKeys: string[];
  /** Published item SERVICES — consumed here, never stored. */
  services: { service: string; category?: string | null }[];
}

/**
 * Derive care-consideration patterns from reference plans.
 *
 * The service strings are read and discarded: what survives is an
 * InterventionId and two counts. There is nowhere in `CarePattern` to put a
 * frequency, a cost or a sentence, which is the point.
 */
export function deriveCarePatterns(sources: readonly PatternSource[]): CarePattern[] {
  const seen = new Map<string, { intervention: InterventionId; family: ServiceFamily; conditionKey: string; plans: Set<number> }>();
  const keyPlanCounts = new Map<string, Set<number>>();

  sources.forEach((src, planIndex) => {
    for (const k of src.conditionKeys) {
      keyPlanCounts.set(k, (keyPlanCounts.get(k) ?? new Set()).add(planIndex));
    }
    const interventions = new Set<string>();
    for (const s of src.services) {
      const r = resolveIntervention(s);
      if (r.id === "UNCLASSIFIED") continue;
      interventions.add(`${r.id}|${r.family}`);
    }
    for (const idf of interventions) {
      const [id, family] = idf.split("|") as [InterventionId, ServiceFamily];
      for (const k of src.conditionKeys) {
        const key = `${k}|${id}`;
        const e = seen.get(key) ?? { intervention: id, family, conditionKey: k, plans: new Set<number>() };
        e.plans.add(planIndex);
        seen.set(key, e);
      }
    }
  });

  return [...seen.values()]
    .map((e) => ({
      intervention: e.intervention,
      family: e.family,
      conditionKey: e.conditionKey,
      observedIn: e.plans.size,
      outOf: keyPlanCounts.get(e.conditionKey)?.size ?? 0,
    }))
    .sort((a, b) => b.observedIn / (b.outOf || 1) - a.observedIn / (a.outOf || 1) || a.intervention.localeCompare(b.intervention));
}

/**
 * Interventions a planner would consider for this case, from learned patterns.
 *
 * Returns identities only. The caller builds a candidate from its own care
 * library or ontology; nothing about the reference plan's version of the item
 * — its frequency, its duration, its price — crosses this boundary.
 */
export function suggestedInterventions(
  patterns: readonly CarePattern[],
  sig: CaseSignature,
  minShare = 0.5,
  minPlans = MIN_CORPUS_PLANS,
): { intervention: InterventionId; family: ServiceFamily; share: number; conditionKey: string }[] {
  const keys = new Set(sig.conditionKeys);
  return patterns
    .filter((p) => keys.has(p.conditionKey) && p.outOf >= minPlans && p.observedIn / p.outOf >= minShare)
    .map((p) => ({ intervention: p.intervention, family: p.family, share: p.observedIn / p.outOf, conditionKey: p.conditionKey }));
}

/**
 * The ceiling a learned pattern may reach.
 *
 * A pattern is evidence about professional practice, not about this patient.
 * It licenses CONSIDERATION and nothing more — so this returns the same value
 * whatever the corpus share, and a caller cannot use a strong pattern to skip
 * the record.
 */
export const patternSupportCeiling = (): SupportClass => "CANDIDATE_REVIEW";

/** A pattern carries no patient content — asserted, not assumed. */
export function assertPatternFactFree(patterns: readonly CarePattern[]): void {
  for (const p of patterns) {
    const blob = JSON.stringify(p);
    if (/\d{2,}/.test(String(p.conditionKey)) || /[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/i.test(String(p.conditionKey))) {
      throw new Error(`Care pattern rejected: conditionKey "${p.conditionKey}" looks like free text rather than a key.`);
    }
    if (blob.length > 300) throw new Error("Care pattern rejected: unexpectedly large payload.");
  }
}


/**
 * Load the APPROVED care patterns for a firm.
 *
 * Unapproved artifacts are invisible here. A machine-derived lesson is a
 * candidate; adoption is a person's act, and the existing learning loop already
 * works this way for priors. Wiring consumption to `createdAt` instead would
 * make running a script equivalent to authorising a clinical rule.
 */
export async function approvedCarePatterns(
  db: { learnedArtifact?: { findFirst(args: unknown): Promise<{ payload: unknown; heldOut: string[] } | null> } },
  firmId: string,
  /** Exclude an artifact that learned from the case being evaluated. */
  excludeIfLearnedFrom?: string,
): Promise<CarePattern[]> {
  const row = await db.learnedArtifact
    ?.findFirst({
      where: { firmId, kind: "CARE_PATTERNS", approvedById: { not: null }, supersededById: null },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => null);
  if (!row) return [];
  // Leave-one-out at the point of USE, not only at derivation: an artifact that
  // learned from this case cannot inform the run being scored on it.
  if (excludeIfLearnedFrom && !row.heldOut.includes(excludeIfLearnedFrom)) return [];
  return (row.payload as CarePattern[]) ?? [];
}
