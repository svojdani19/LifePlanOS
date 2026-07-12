// ─────────────────────────────────────────────────────────────────────────────
// Recommendation lifecycle (P2.R1). Pure, unit-testable rules for:
//   • material vs. nonmaterial change detection (a material change invalidates
//     prior approval; a formatting change does not);
//   • supersede-not-delete planning on regeneration (reviewed items are never
//     destroyed — they are superseded with a stable lineage);
//   • mapping the legacy 4-state physicianStatus onto the 12-state RecStatus.
// Persistence lives in the callers (generate.ts, the item routes); this module
// stays free of prisma so the rules are pinned by tests.
// ─────────────────────────────────────────────────────────────────────────────

// Fields whose change alters the clinical/economic substance of a
// recommendation (P2.R1 §3). Changing any of these on an approved item
// invalidates the approval and returns the item to review.
export const MATERIAL_FIELDS = [
  "service",
  "category",
  "conditionId",
  "cptCode",
  "probability",
  "frequencyPerYear",
  "durationYears",
  "isLifetime",
  "unitCost",
  "pricingSource",
] as const;
export type MaterialField = (typeof MATERIAL_FIELDS)[number];

// Nonmaterial: wording/formatting only — approval carries across.
export const NONMATERIAL_FIELDS = ["rationale", "physicianSummary", "specialty", "confidence", "defenseVulnerability", "lowerCostAlternative", "literatureSupport", "evidenceStrength", "missingSupport", "plaintiffValue", "startTrigger"] as const;

/** The subset of `changed` field names that are material. */
export function materialChanges(changed: Record<string, unknown>, prior: Record<string, unknown>): string[] {
  return MATERIAL_FIELDS.filter((f) => f in changed && changed[f] !== undefined && !valuesEqual(changed[f], prior[f]));
}
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true; // null vs undefined
  return false;
}

/** All changed field names (material or not), for the transition ledger. */
export function changedFields(changed: Record<string, unknown>, prior: Record<string, unknown>): string[] {
  return Object.keys(changed).filter((f) => changed[f] !== undefined && !valuesEqual(changed[f], (prior as Record<string, unknown>)[f]));
}

/** An item has review history when any human action has touched it. */
export function hasReviewHistory(item: { physicianStatus: string; physicianNote?: string | null; edited?: boolean }): boolean {
  return item.physicianStatus !== "PENDING" || !!item.physicianNote || !!item.edited;
}

/** Legacy physicianStatus → 12-state lifecycle status. */
export function lifecycleFor(physicianStatus: string, opts: { superseded?: boolean; recordSupported?: boolean } = {}): string {
  if (opts.superseded) return "SUPERSEDED";
  switch (physicianStatus) {
    case "APPROVED": return "PHYSICIAN_APPROVED";
    case "MODIFIED": return "PHYSICIAN_MODIFIED";
    case "REJECTED": return "PHYSICIAN_REJECTED";
    default: return opts.recordSupported ? "RECORD_SUPPORTED" : "AI_DRAFT";
  }
}

// ── Regeneration planning (P2.R1 §1–2) ───────────────────────────────────────
export interface PriorItem {
  id: string;
  service: string;
  lineageId: string;
  version: number;
  physicianStatus: string;
  physicianNote?: string | null;
  edited?: boolean;
  lifecycleStatus: string;
}
export interface RegenPlan {
  /** prior item ids safe to hard-delete (no review history) */
  deleteIds: string[];
  /** prior items to preserve as superseded versions */
  supersede: PriorItem[];
  /** for a new item's service: the lineage it continues (or none) */
  lineageForService: Map<string, { lineageId: string; version: number; priorId: string }>;
}

/**
 * Plan a regeneration against the existing items. Unreviewed AI drafts are
 * replaced in place (deleted); anything with review history is preserved and
 * superseded. A regenerated item with the same service identity continues the
 * old lineage at version+1.
 */
export function planRegeneration(prior: PriorItem[]): RegenPlan {
  const deleteIds: string[] = [];
  const supersede: PriorItem[] = [];
  const lineageForService = new Map<string, { lineageId: string; version: number; priorId: string }>();
  for (const it of prior) {
    if (hasReviewHistory(it)) {
      supersede.push(it);
      const key = it.service.trim().toLowerCase();
      // Keep the highest version per service as the lineage head.
      const existing = lineageForService.get(key);
      if (!existing || it.version > existing.version) lineageForService.set(key, { lineageId: it.lineageId, version: it.version, priorId: it.id });
    } else {
      deleteIds.push(it.id);
    }
  }
  return { deleteIds, supersede, lineageForService };
}
