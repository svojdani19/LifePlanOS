// From a real OPEN finding to a released export — and only for the exact pair.
//
// The unit tests prove the pieces. This proves the journey: a stale basis
// raises an OPEN blocking finding, the export is refused, a credentialed
// physician reconciles THAT pair through the same call the UI makes, and the
// export is then permitted — while an unrelated blocking finding is untouched
// and a second, different divergence on the same recommendation still blocks.

import { describe, it, expect } from "vitest";
import {
  encodeBasisFinding,
  statusForFinding,
  RECONCILED_STATUS,
  type ReconciliationRow,
} from "@/lib/engine/basisReconciliation";

const ITEM_A = "item-aaaa";
const ITEM_B = "item-bbbb";
const H = (c: string) => `basis-1:${c.repeat(32)}`;
const RECORDED = H("a");
const DERIVED = H("b");
const MOVED = H("c");

const rec = (over: Partial<ReconciliationRow> = {}): ReconciliationRow => ({
  futureCareItemId: ITEM_A,
  recordedHash: RECORDED,
  derivedHash: DERIVED,
  reconciledById: "md-1",
  createdAt: new Date("2026-08-22T12:00:00Z"),
  ...over,
});

/** The findings a case carries, as validation would republish them. */
function republish(reconciliations: ReconciliationRow[]) {
  const findings = [
    // Two recommendations that share a SERVICE NAME — the case the old
    // service-name lookup collapsed into one.
    { service: "Total knee arthroplasty", result: encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM_A, recordedHash: RECORDED, derivedHash: DERIVED }), exportBlocking: true },
    { service: "Total knee arthroplasty", result: encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM_B, recordedHash: RECORDED, derivedHash: DERIVED }), exportBlocking: true },
    { service: "Prosthetic gait training", result: "Cost inconsistency", exportBlocking: true },
    { service: "Physiatry follow-up", result: "Physician review pending", exportBlocking: false },
  ];
  return findings.map((f) => ({ ...f, ...statusForFinding(f.result, reconciliations, undefined) }));
}

const openBlocking = (rows: ReturnType<typeof republish>) => rows.filter((f) => f.exportBlocking && f.status === "OPEN").length;

describe("the journey from a blocking divergence to a released export", () => {
  it("starts blocked: the stale bases are OPEN and block the final", () => {
    const rows = republish([]);
    expect(rows.filter((f) => f.result.startsWith("BASIS_STALE")).every((f) => f.status === "OPEN")).toBe(true);
    expect(openBlocking(rows)).toBe(3); // two bases + the cost finding
  });

  it("reconciling one pair closes exactly that finding", () => {
    const rows = republish([rec()]);
    const a = rows.find((f) => f.result.includes(ITEM_A))!;
    const b = rows.find((f) => f.result.includes(ITEM_B))!;
    expect(a.status).toBe(RECONCILED_STATUS);
    // The other recommendation shares the service NAME and both hashes, and is
    // a different item. The old matcher closed it too.
    expect(b.status).toBe("OPEN");
  });

  it("does not clear unrelated findings", () => {
    const rows = republish([rec()]);
    expect(rows.find((f) => f.result === "Cost inconsistency")!.status).toBe("OPEN");
    expect(rows.find((f) => f.result === "Physician review pending")!.status).toBe("OPEN");
  });

  it("reaches a released export only when every blocker is answered", () => {
    // Both bases reconciled, cost finding still open → still blocked, and
    // blocked for the RIGHT reason.
    let rows = republish([rec(), rec({ futureCareItemId: ITEM_B })]);
    expect(rows.filter((f) => f.result.startsWith("BASIS_")).every((f) => f.status === RECONCILED_STATUS)).toBe(true);
    expect(openBlocking(rows)).toBe(1);
    expect(rows.filter((f) => f.exportBlocking && f.status === "OPEN")[0].result).toBe("Cost inconsistency");

    // With the cost finding dispositioned the ordinary way, nothing blocks.
    rows = republish([rec(), rec({ futureCareItemId: ITEM_B })]).map((f) =>
      f.result === "Cost inconsistency" ? { ...f, status: "RESOLVED_AS_IS" } : f,
    );
    expect(openBlocking(rows)).toBe(0);
  });

  it("records WHO reconciled and WHEN on the closed finding", () => {
    const rows = republish([rec()]);
    const a = rows.find((f) => f.result.includes(ITEM_A))!;
    expect(a.resolvedById).toBe("md-1");
    expect(a.resolvedAt).toEqual(new Date("2026-08-22T12:00:00Z"));
  });
});

describe("the reconciliation expires the moment either reading moves", () => {
  it("a new derived hash reopens the finding", () => {
    // The record moved again. The reviewer has not seen what the document would
    // now say, so their earlier judgment cannot cover it.
    const findings = [{ service: "TKA", result: encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM_A, recordedHash: RECORDED, derivedHash: MOVED }), exportBlocking: true }];
    const rows = findings.map((f) => ({ ...f, ...statusForFinding(f.result, [rec()], undefined) }));
    expect(rows[0].status).toBe("OPEN");
  });

  it("a regenerated basis (new recorded hash) reopens the finding", () => {
    const findings = [{ service: "TKA", result: encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM_A, recordedHash: MOVED, derivedHash: DERIVED }), exportBlocking: true }];
    const rows = findings.map((f) => ({ ...f, ...statusForFinding(f.result, [rec()], undefined) }));
    expect(rows[0].status).toBe("OPEN");
  });

  it("a reconciliation for a different item never applies", () => {
    const findings = [{ service: "TKA", result: encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM_B, recordedHash: RECORDED, derivedHash: DERIVED }), exportBlocking: true }];
    const rows = findings.map((f) => ({ ...f, ...statusForFinding(f.result, [rec()], undefined) }));
    expect(rows[0].status).toBe("OPEN");
  });
});

describe("a missing basis can never be reconciled into a release", () => {
  it("stays OPEN even with a reconciliation naming the exact hashes", () => {
    // The bypass in its purest form: sign off on a recommendation that has no
    // recorded basis at all and export it as final.
    const missing = encodeBasisFinding({ state: "MISSING", futureCareItemId: ITEM_A, recordedHash: null, derivedHash: DERIVED });
    const rows = [{ service: "TKA", result: missing, exportBlocking: true }].map((f) => ({
      ...f,
      ...statusForFinding(f.result, [rec({ recordedHash: null })], undefined),
    }));
    expect(rows[0].status).toBe("OPEN");
    expect(openBlocking(rows)).toBe(1);
  });
});

describe("a legacy finding is not silently reconcilable", () => {
  it("an old short-tail code stays OPEN whatever reconciliations exist", () => {
    const rows = [{ service: "TKA", result: "BASIS_STALE:aaaaaaaaaaaa->bbbbbbbbbbbb", exportBlocking: true }].map((f) => ({
      ...f,
      ...statusForFinding(f.result, [rec()], undefined),
    }));
    // Unmatchable, therefore blocking. The safe direction.
    expect(rows[0].status).toBe("OPEN");
  });

  it("a carried RESOLVED_AS_IS cannot resurrect the bypass on a decodable one", () => {
    // Even if a legacy disposition row exists for this key, a basis divergence
    // derives its status from the reconciliation record and nothing else.
    const code = encodeBasisFinding({ state: "STALE", futureCareItemId: ITEM_A, recordedHash: RECORDED, derivedHash: DERIVED });
    const s = statusForFinding(code, [], { status: "RESOLVED_AS_IS", resolvedById: "planner-1", resolvedAt: new Date() });
    expect(s.status).toBe("OPEN");
  });
});

describe("ordinary findings keep their existing workflow", () => {
  it("a carried disposition still survives a re-run", () => {
    const s = statusForFinding("Cost inconsistency", [], { status: "RESOLVED_AS_IS", resolvedById: "u", resolvedAt: new Date("2026-01-01") });
    expect(s.status).toBe("RESOLVED_AS_IS");
    expect(s.resolvedById).toBe("u");
  });

  it("an undispositioned ordinary finding is OPEN", () => {
    expect(statusForFinding("Cost inconsistency", [], undefined).status).toBe("OPEN");
  });
});
