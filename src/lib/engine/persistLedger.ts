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
    update(args: unknown): Promise<unknown>;
  };
}

/** Normalised service name — the last-resort key for re-linking. */
export const serviceKeyOf = (service: string): string => service.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface PhysicianRow {
  id: string;
  futureCareItemId: string;
  lineageId: string | null;
  serviceKey: string | null;
}

interface CurrentItem {
  id: string;
  service: string;
  lineageId?: string | null;
}

export interface RelinkResult {
  relinked: number;
  /** Citations whose recommendation is no longer in the plan at all. */
  orphaned: number;
}

/**
 * Re-point a physician's citations at the recommendations they belong to.
 *
 * Preserving the ROW is not preserving the CONTRIBUTION. On the reference case
 * 22 of 59 items are deleted and recreated with fresh ids on every generation,
 * so a citation keyed to `futureCareItemId` alone survived the rebuild and then
 * addressed a row that no longer existed: absent from the panel, and beyond the
 * reach of the delete route, which scopes by that same id. Silent loss that
 * looked like safety.
 *
 * Lineage first — it is the identity the plan versioning already maintains.
 * Service name second, because a regenerated "Physical therapy" is the same
 * recommendation to the physician who cited a paper about it. Anything still
 * unmatched is left alone and REPORTED: the recommendation is genuinely gone,
 * and that is a fact for a person to resolve, not for this function to tidy
 * away by guessing.
 */
export async function relinkPhysicianEvidence(
  db: LedgerStore,
  caseId: string,
  currentItems: readonly CurrentItem[],
): Promise<RelinkResult> {
  const rows = (await db.recommendationEvidence.findMany({
    where: { caseId, addedById: { not: null } },
    select: { id: true, futureCareItemId: true, lineageId: true, serviceKey: true },
  })) as PhysicianRow[];
  if (!rows.length) return { relinked: 0, orphaned: 0 };

  const live = new Set(currentItems.map((i) => i.id));
  const byLineage = new Map<string, CurrentItem>();
  const byService = new Map<string, CurrentItem>();
  for (const i of currentItems) {
    if (i.lineageId) byLineage.set(i.lineageId, i);
    byService.set(serviceKeyOf(i.service), i);
  }

  let relinked = 0;
  let orphaned = 0;
  for (const r of rows) {
    if (live.has(r.futureCareItemId)) continue; // still pointing at a real item
    const successor = (r.lineageId ? byLineage.get(r.lineageId) : undefined) ?? (r.serviceKey ? byService.get(r.serviceKey) : undefined);
    if (!successor) {
      orphaned++;
      continue;
    }
    await db.recommendationEvidence.update({
      where: { id: r.id },
      data: { futureCareItemId: successor.id, lineageId: successor.lineageId ?? r.lineageId },
    });
    relinked++;
  }
  return { relinked, orphaned };
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
      verbatim: r.verbatim,
      producerVersion: r.producerVersion,
    })),
  });

  return { written: created.count, replaced: gone.count, physicianRowsPreserved: preserved.length };
}
