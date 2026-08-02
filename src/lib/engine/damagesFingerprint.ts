import { createHash } from "crypto";
import { FDE_LOGIC_VERSION, type FdeInput } from "./damagesEvaluation";

// ─────────────────────────────────────────────────────────────────────────────
// Damages-evaluation inputs fingerprint (MDIP hardening).
//
// PROBLEM: `evaluatedAt < case.updatedAt` is a lying staleness signal in both
// directions — Case.updatedAt moves on cosmetic edits (false stale) and does
// NOT move on child-table changes like a new FutureCareItem (false fresh).
//
// FIX: a deterministic sha256 fingerprint over the engine's EXACT input
// payload plus the identity (row ids) of every row that fed it. The hash is
// stored on the evaluation row; GET recomputes the current fingerprint and
// compares. Same facts → same hash (regardless of DB row order); any change
// to a fact the engine can see → different hash.
//
// Kept in its own module (not damagesEvaluation.ts) because the engine module
// is imported by client components and this one needs node:crypto.
// ─────────────────────────────────────────────────────────────────────────────

/** Identity of the rows behind the FdeInput snapshot — catches add/remove/
 *  replace even when the mapped payload happens to be identical. */
export interface FdeRowIds {
  conditionIds: string[];
  itemIds: string[];
  findingIds: string[];
  /** Material snapshots of sources represented to the engine only as counts
   * or presence flags. Content changes must invalidate the evaluation even
   * when the row count is unchanged. */
  sourceRecords?: Array<{ kind: string; id: string; material: unknown }>;
}

/** JSON.stringify with recursively sorted object keys — key order can never
 *  perturb the hash. Arrays keep their (pre-sorted) order. */
function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sort an array of objects by their canonical serialization so database row
 *  order can never perturb the hash. */
function canonicalSort<T>(items: T[]): T[] {
  return items
    .map((item) => ({ item, key: stableStringify(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((e) => e.item);
}

/**
 * Deterministic sha256 (hex) over the engine input + source-row identity.
 * Pure: identical facts always produce the identical hash, independent of
 * array order; any observable input change produces a different hash.
 * The logic version is folded in so an engine upgrade also reads as stale.
 */
export function computeInputsHash(input: FdeInput, rows: FdeRowIds): string {
  const payload = {
    logicVersion: FDE_LOGIC_VERSION,
    input: {
      conditions: canonicalSort(input.conditions),
      items: canonicalSort(input.items),
      findings: canonicalSort(input.findings),
      documentsCount: input.documentsCount,
      chronologyCount: input.chronologyCount,
      vocationalEntryCount: input.vocationalEntryCount,
      econAssumptionCount: input.econAssumptionCount,
      interviews: input.interviews,
      missingRecordSignals: [...input.missingRecordSignals].sort(),
      sourceIds: input.sourceIds
        ? {
            documents: [...input.sourceIds.documents].sort(),
            chronologyEvents: [...input.sourceIds.chronologyEvents].sort(),
            vocationalEntries: [...input.sourceIds.vocationalEntries].sort(),
            economicAssumptions: [...input.sourceIds.economicAssumptions].sort(),
            interviewFindings: [...input.sourceIds.interviewFindings].sort(),
            missingRecordFindings: [...input.sourceIds.missingRecordFindings].sort(),
          }
        : undefined,
    },
    rows: {
      conditionIds: [...rows.conditionIds].sort(),
      itemIds: [...rows.itemIds].sort(),
      findingIds: [...rows.findingIds].sort(),
      sourceRecords: canonicalSort(rows.sourceRecords ?? []),
    },
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
