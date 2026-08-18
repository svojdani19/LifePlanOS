// A machine pass rebuilds what it derived. It does not touch what a person
// contributed — the rule the chronology, the record findings and the review
// lineage already live by, applied to the evidence ledger.
//
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { persistMachineLedger, relinkPhysicianEvidence, serviceKeyOf, type LedgerStore } from "@/lib/engine/persistLedger";
import type { LedgerRow } from "@/lib/engine/evidenceLedger";

interface Row { id: string; caseId: string; addedById: string | null; quote: string; futureCareItemId?: string; lineageId?: string | null; serviceKey?: string | null }

function makeStore(seed: Row[] = []) {
  const rows = [...seed];
  const store: LedgerStore & { rows: Row[] } = {
    rows,
    recommendationEvidence: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => r.caseId === where.caseId && (where.addedById as { not?: null })?.not === null ? r.addedById !== null : true),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const doomed = rows.filter((r) => r.caseId === where.caseId && (where.addedById === null ? r.addedById === null : true));
        for (const d of doomed) rows.splice(rows.indexOf(d), 1);
        return { count: doomed.length };
      },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const [i, d] of data.entries()) rows.push({ id: `new-${i}`, caseId: d.caseId as string, addedById: null, quote: d.quote as string });
        return { count: data.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const hit = rows.find((r) => r.id === where.id);
        if (hit) Object.assign(hit, data);
        return hit ?? {};
      },
    },
  };
  return store;
}

const row = (quote: string): LedgerRow => ({
  futureCareItemId: "i-1",
  conditionId: "c-1",
  claim: "NECESSITY",
  stance: "SUPPORTS",
  strength: "OBJECTIVE",
  sourceKind: "CHRONOLOGY_EVENT",
  sourceDocumentId: null,
  encounterId: null,
  chronologyEventId: null,
  page: 1,
  field: null,
  quote,
  recordedOn: null,
  sourceFingerprint: null,
  verbatim: false,
  producerVersion: "test",
});

const SCOPE = { caseId: "case-1", firmId: "firm-1" };

describe("regeneration replaces what it derived", () => {
  it("clears the previous derived rows and writes the new ones", async () => {
    const store = makeStore([{ id: "old", caseId: "case-1", addedById: null, quote: "stale finding" }]);
    const out = await persistMachineLedger(store, SCOPE, [row("fresh finding")]);
    expect(out.replaced).toBe(1);
    expect(out.written).toBe(1);
    expect(store.rows.map((r) => r.quote)).toEqual(["fresh finding"]);
  });

  it("writes nothing and still clears when the new plan has no evidence", async () => {
    const store = makeStore([{ id: "old", caseId: "case-1", addedById: null, quote: "stale" }]);
    const out = await persistMachineLedger(store, SCOPE, []);
    expect(out.written).toBe(0);
    expect(store.rows).toHaveLength(0);
  });
});

describe("regeneration never discards a physician's citation", () => {
  it("leaves a physician row in place while replacing the derived ones", async () => {
    const store = makeStore([
      { id: "derived", caseId: "case-1", addedById: null, quote: "stale finding" },
      { id: "byMD", caseId: "case-1", addedById: "dr-1", quote: "the paper the physician chose" },
    ]);
    const out = await persistMachineLedger(store, SCOPE, [row("fresh finding")]);
    expect(out.physicianRowsPreserved).toBe(1);
    expect(store.rows.some((r) => r.id === "byMD")).toBe(true);
    expect(store.rows.some((r) => r.id === "derived")).toBe(false);
  });

  it("preserves it even when the new plan derives nothing at all", async () => {
    // The dangerous case: an empty rebuild is exactly when a careless delete
    // would take the physician's work with it.
    const store = makeStore([{ id: "byMD", caseId: "case-1", addedById: "dr-1", quote: "chosen paper" }]);
    await persistMachineLedger(store, SCOPE, []);
    expect(store.rows.map((r) => r.id)).toEqual(["byMD"]);
  });

  it("scopes the delete to the case — another case's ledger is untouched", async () => {
    const store = makeStore([{ id: "other", caseId: "case-2", addedById: null, quote: "other case" }]);
    await persistMachineLedger(store, SCOPE, [row("fresh")]);
    expect(store.rows.some((r) => r.id === "other")).toBe(true);
  });
});

describe("a citation follows its recommendation across a rebuild", () => {
  // Preserving the ROW is not preserving the CONTRIBUTION. On the reference
  // case 22 of 59 items are deleted and recreated with fresh ids on every
  // generation, so a citation keyed to `futureCareItemId` survived the writer
  // and then addressed a row that no longer existed: absent from the panel,
  // and unreachable by the delete route, which scopes by that same id.
  const cited = (over: Partial<Row> = {}): Row => ({
    id: "phys-1",
    caseId: "case-1",
    addedById: "u-1",
    quote: "Arthroplasty outcomes in end-stage osteoarthritis",
    futureCareItemId: "old-item",
    lineageId: "lin-1",
    serviceKey: "total knee arthroplasty",
    ...over,
  });

  it("re-points it by lineage when the item id changed", async () => {
    const store = makeStore([cited()]);
    const out = await relinkPhysicianEvidence(store, "case-1", [{ id: "new-item", service: "Total knee arthroplasty", lineageId: "lin-1" }]);
    expect(out.relinked).toBe(1);
    expect(out.orphaned).toBe(0);
    expect(store.rows[0].futureCareItemId).toBe("new-item");
  });

  it("falls back to the service name when no lineage carried over", async () => {
    const store = makeStore([cited({ lineageId: null })]);
    const out = await relinkPhysicianEvidence(store, "case-1", [{ id: "new-item", service: "Total Knee Arthroplasty", lineageId: null }]);
    expect(out.relinked).toBe(1);
    expect(store.rows[0].futureCareItemId).toBe("new-item");
  });

  it("leaves an unmatched citation alone and REPORTS it rather than guessing", async () => {
    // The recommendation is genuinely gone. Attaching the citation to the
    // nearest surviving item would silently re-purpose a clinician's work.
    const store = makeStore([cited({ lineageId: "lin-9", serviceKey: "cervical fusion" })]);
    const out = await relinkPhysicianEvidence(store, "case-1", [{ id: "new-item", service: "Physical therapy", lineageId: "lin-1" }]);
    expect(out.relinked).toBe(0);
    expect(out.orphaned).toBe(1);
    expect(store.rows[0].futureCareItemId).toBe("old-item");
  });

  it("does not touch a citation whose item is still there", async () => {
    const store = makeStore([cited({ futureCareItemId: "live-item" })]);
    const out = await relinkPhysicianEvidence(store, "case-1", [{ id: "live-item", service: "Total knee arthroplasty", lineageId: "lin-1" }]);
    expect(out.relinked).toBe(0);
    expect(out.orphaned).toBe(0);
  });

  it("normalises service names the way the endpoint does", () => {
    expect(serviceKeyOf("  Total-Knee   Arthroplasty ")).toBe(serviceKeyOf("total knee arthroplasty"));
  });
});
