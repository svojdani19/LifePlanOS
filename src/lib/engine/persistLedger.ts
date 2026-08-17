// ─────────────────────────────────────────────────────────────────────────────
// Writing the evidence ledger.
//
// Two kinds of row share this table and they are governed by opposite rules,
// which is the whole reason this is a module rather than a createMany call:
//
//   MACHINE rows are DERIVED — a function of the records, the conditions and
//   the compatibility rules. They are rebuilt from scratch on every plan
//   generation, because keeping a stale derivation beside a fresh one would
//   let a reviewer read evidence for a recommendation that no longer exists.
//
//   PHYSICIAN rows are a clinician's own citation, entered by hand against a
//   specific claim. They survive regeneration untouched. This is the same rule
//   the chronology, the record findings and the review lineage already live
//   by: a machine pass never discards a person's work.
//
// The distinction is `addedById`. A row with one was put there by a human and
// is not this module's to delete.
// ─────────────────────────────────────────────────────────────────────────────

import type { LedgerRow } from "@/lib/engine/evidenceLedger";

/** The Prisma surface this writer needs, structurally typed for testing. */
export interface LedgerStore {
  recommendationEvidence: {
    deleteMany(args: unknown): Promise<{ count: number }>;
    createMany(args: unknown): Promise<{ count: number }>;
    findMany(args: unknown): Promise<unknown[]>;
  };
}

export interface PersistResult {
  written: number;
  replaced: number;
  physicianRowsPreserved: number;
}

/**
 * Replace this case's MACHINE-derived ledger with a freshly built one.
 *
 * `deleteMany` is scoped by `addedById: null` — the clause that makes this
 * safe. Without it a regeneration would silently destroy every citation a
 * physician had attached to the plan.
 */
export async function persistMachineLedger(
  db: LedgerStore,
  scope: { caseId: string; firmId: string },
  rows: readonly LedgerRow[],
): Promise<PersistResult> {
  const preserved = await db.recommendationEvidence.findMany({
    where: { caseId: scope.caseId, addedById: { not: null } },
    select: { id: true },
  });

  const gone = await db.recommendationEvidence.deleteMany({
    // MACHINE rows only. A physician's citation is not derived output.
    where: { caseId: scope.caseId, addedById: null },
  });

  if (!rows.length) return { written: 0, replaced: gone.count, physicianRowsPreserved: preserved.length };

  const created = await db.recommendationEvidence.createMany({
    data: rows.map((r) => ({
      firmId: scope.firmId,
      caseId: scope.caseId,
      futureCareItemId: r.futureCareItemId,
      conditionId: r.conditionId,
      claim: r.claim,
      stance: r.stance,
      strength: r.strength,
      sourceKind: r.sourceKind,
      sourceDocumentId: r.sourceDocumentId,
      encounterId: r.encounterId,
      chronologyEventId: r.chronologyEventId,
      page: r.page,
      field: r.field,
      quote: r.quote,
      recordedOn: r.recordedOn,
      sourceFingerprint: r.sourceFingerprint,
      producerVersion: r.producerVersion,
    })),
  });

  return { written: created.count, replaced: gone.count, physicianRowsPreserved: preserved.length };
}
