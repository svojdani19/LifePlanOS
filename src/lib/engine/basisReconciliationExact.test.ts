// Reconciliation must be operational, and exact.
//
// As shipped it was neither. The route created a BasisReconciliation and left
// the OPEN finding open; the export gate counted that finding before it ever
// consulted the reconciliation, so the credentialed path could be completed and
// still not release the report. Identity was recovered by looking the SERVICE
// NAME up in a map — two recommendations of the same service collided — and
// matched on twelve trailing hex characters of the derived hash, with the
// recorded side not compared at all. Nothing in the product called the
// endpoint, and the audit entry sat outside the transaction the comment said it
// shared.

import { describe, it, expect } from "vitest";
import {
  encodeBasisFinding,
  decodeBasisFinding,
  reconciliationCovers,
  reconcilable,
  isBasisDivergenceFinding,
  RECONCILED_STATUS,
} from "@/lib/engine/basisReconciliation";

const RECORDED = "basis-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DERIVED = "basis-1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ITEM = "5f2c1c4e-0000-4000-8000-000000000001";

describe("identity survives the round trip, in full", () => {
  it("carries the item id and BOTH complete hashes", () => {
    const code = encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM, recordedHash: RECORDED, derivedHash: DERIVED });
    expect(code).toContain(ITEM);
    expect(code).toContain(RECORDED);
    expect(code).toContain(DERIVED);
    expect(decodeBasisFinding(code)).toEqual({ state: "STALE", futureCareItemId: ITEM, recordedHash: RECORDED, derivedHash: DERIVED });
  });

  it("records a missing basis with no recorded hash rather than a placeholder one", () => {
    const code = encodeBasisFinding({ state: "MISSING", futureCareItemId: ITEM, recordedHash: null, derivedHash: DERIVED });
    expect(decodeBasisFinding(code)).toMatchObject({ state: "MISSING", recordedHash: null });
  });

  it("is still recognised as a basis divergence", () => {
    expect(isBasisDivergenceFinding(encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM, recordedHash: RECORDED, derivedHash: DERIVED }))).toBe(true);
  });

  it("refuses to decode a legacy short-tail code", () => {
    // Twelve trailing characters cannot identify an item or a hash. Returning
    // null keeps such a finding unmatched, and therefore blocking.
    expect(decodeBasisFinding("BASIS_STALE:aaaaaaaaaaaa->bbbbbbbbbbbb")).toBeNull();
  });

  it("refuses garbage rather than inventing an identity", () => {
    for (const r of ["", "BASIS_STALE", "Cost inconsistency", "BASIS_STALE:only-one-part"]) {
      expect(decodeBasisFinding(r)).toBeNull();
    }
  });
});

describe("a reconciliation covers one pair of readings and no other", () => {
  const div = { state: "STALE" as const, futureCareItemId: ITEM, recordedHash: RECORDED, derivedHash: DERIVED };
  const rec = { futureCareItemId: ITEM, recordedHash: RECORDED, derivedHash: DERIVED };

  it("covers the exact pair", () => {
    expect(reconciliationCovers(rec, div)).toBe(true);
  });

  it("does not cover a different item — even with identical hashes", () => {
    // The service-name lookup made two same-named recommendations one item.
    expect(reconciliationCovers({ ...rec, futureCareItemId: "other-item" }, div)).toBe(false);
  });

  it("does not cover a moved DERIVED hash", () => {
    expect(reconciliationCovers(rec, { ...div, derivedHash: "basis-1:cccccccccccccccccccccccccccccccc" })).toBe(false);
  });

  it("does not cover a moved RECORDED hash", () => {
    // The old matcher ignored the recorded side entirely.
    expect(reconciliationCovers(rec, { ...div, recordedHash: "basis-1:dddddddddddddddddddddddddddddddd" })).toBe(false);
  });

  it("is not satisfied by a shared suffix", () => {
    // The old matcher used endsWith on twelve characters.
    const sameTail = "basis-1:9999999999999999999" + DERIVED.slice(-12);
    expect(reconciliationCovers(rec, { ...div, derivedHash: sameTail })).toBe(false);
  });

  it("treats null and absent recorded hashes as the same thing, and not as a value", () => {
    expect(reconciliationCovers({ ...rec, recordedHash: null }, { ...div, recordedHash: null })).toBe(true);
    expect(reconciliationCovers({ ...rec, recordedHash: null }, div)).toBe(false);
  });
});

describe("a missing basis is not reconcilable", () => {
  it("STALE may be reconciled", () => {
    expect(reconcilable("STALE").ok).toBe(true);
  });

  it("MISSING may not, and says why", () => {
    // Accepting one would manufacture an authoritative basis out of a
    // signature — the exact bypass the mechanism removes.
    const r = reconcilable("MISSING");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nothing to reconcile against/i);
    expect(r.reason).toMatch(/regenerate the plan/i);
  });
});

describe("the reconciled status is its own thing", () => {
  it("is distinguishable from the generic dispositions it replaces", () => {
    expect(RECONCILED_STATUS).toBe("RESOLVED_RECONCILED");
    expect(RECONCILED_STATUS).not.toBe("RESOLVED_AS_IS");
    expect(RECONCILED_STATUS).not.toBe("IGNORED");
    // And it is not OPEN, which is what every export gate counts.
    expect(RECONCILED_STATUS).not.toBe("OPEN");
  });
});

describe("the workflow is reachable and wired end to end", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    return readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");
  };

  it("the review surface offers the action on a stale-basis finding", async () => {
    const src = await read("src/components/case/CaseWorkspace.tsx");
    expect(src).toMatch(/BASIS_STALE/);
    expect(src).toMatch(/Reconcile basis/);
    expect(src).toMatch(/BasisReconcileAction/);
  });

  it("the action posts to the reconcile route that exists", async () => {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const src = await read("src/components/case/CaseWorkspace.tsx");
    expect(src).toMatch(/\/api\/cases\/\$\{caseId\}\/basis\/reconcile/);
    expect(existsSync(join(__dirname, "..", "..", "..", "src/app/api/cases/[caseId]/basis/reconcile/route.ts"))).toBe(true);
  });

  it("it shows BOTH readings, not just a hash pair to sign off", async () => {
    const src = await read("src/components/case/CaseWorkspace.tsx");
    expect(src).toMatch(/Basis on file/);
    expect(src).toMatch(/Record derives now/);
  });

  it("it requires a substantive reason before it will submit", async () => {
    const src = await read("src/components/case/CaseWorkspace.tsx");
    expect(src).toMatch(/reason\.trim\(\)\.length < 12/);
  });

  it("it sends the exact hashes it displayed, so a stale tab cannot reconcile", async () => {
    const src = await read("src/components/case/CaseWorkspace.tsx");
    expect(src).toMatch(/recordedHash: mine\.recordedHash/);
    expect(src).toMatch(/derivedHash: mine\.derivedHash/);
    const route = await read("src/app/api/cases/[caseId]/basis/reconcile/route.ts");
    expect(route).toMatch(/STALE_VIEW/);
  });

  it("the route closes the exact finding inside the transaction, with the audit", async () => {
    const route = await read("src/app/api/cases/[caseId]/basis/reconcile/route.ts");
    const tx = route.slice(route.indexOf("prisma.$transaction"), route.indexOf("return ok({ reconciliation"));
    expect(tx).toMatch(/basisReconciliation\.create/);
    expect(tx).toMatch(/validationFinding\.updateMany/);
    expect(tx).toMatch(/audit\(/);
    // Closes by the exact result code, never by item alone.
    expect(tx).toMatch(/result: diverged\.findingResult/);
  });

  it("the route refuses a missing basis", async () => {
    const route = await read("src/app/api/cases/[caseId]/basis/reconcile/route.ts");
    expect(route).toMatch(/BASIS_MISSING_NOT_RECONCILABLE/);
  });

  it("every gate derives its status from the reconciliation record", async () => {
    // Not from a disposition carried on a string key — that let the export
    // gate, the draft banner and the divergence check disagree.
    const v = await read("src/lib/engine/validation.ts");
    // It loads the reconciliations and hands them to the one pure function that
    // decides a republished finding's status.
    expect(v).toMatch(/basisReconciliation\.findMany/);
    expect(v).toMatch(/statusForFinding\(f\.result, reconciliations/);
    const helper = await read("src/lib/engine/basisReconciliation.ts");
    expect(helper).toMatch(/export function statusForFinding/);
    expect(helper).toMatch(/reconciliationCovers/);
    expect(helper).toMatch(/RECONCILED_STATUS/);
  });

  it("the export gate consults divergences before counting open findings", async () => {
    const src = await read("src/app/api/cases/[caseId]/export/route.ts");
    expect(src.indexOf("unreconciledBasisDivergences(")).toBeLessThan(src.indexOf("openBlockingCount("));
  });
});
