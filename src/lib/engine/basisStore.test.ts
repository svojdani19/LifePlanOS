// A failed read is not an absence.
//
// Four call sites loaded the recorded bases as `findMany().catch(() => [])`, so
// an empty array meant either "this case has no recorded bases" or "the read
// did not work", and every consumer took the first reading.
//
// Observed live against a database whose schema had not caught up: every query
// failed with P2022, the panel rendered witness assessments as though nothing
// had ever been recorded, and validation emitted BASIS_MISSING for all 34 items
// — a statement about the record, made by code that never read the record.

import { describe, it, expect, vi } from "vitest";
import {
  loadRecordedBases,
  unreadableBasisFinding,
  BasisUnreadableError,
  BASIS_UNREADABLE,
  type BasisStore,
} from "@/lib/engine/basisStore";

const store = (rows: { futureCareItemId: string }[]): BasisStore => ({
  recommendationBasis: { findMany: vi.fn(async () => rows) },
});
const broken = (err: unknown): BasisStore => ({
  recommendationBasis: { findMany: vi.fn(async () => { throw err; }) },
});

describe("the two empties are told apart", () => {
  it("a case with no recorded bases is readable and empty", () => {
    // This is the state that licenses "no recorded basis exists".
    return loadRecordedBases(store([]), "case-1").then((r) => {
      expect(r.readable).toBe(true);
      expect(r.readable && r.count).toBe(0);
    });
  });

  it("a case with bases loads them keyed by item", async () => {
    const r = await loadRecordedBases(store([{ futureCareItemId: "i-1" }, { futureCareItemId: "i-2" }]), "case-1");
    expect(r.readable).toBe(true);
    expect(r.readable && r.byItem.size).toBe(2);
    expect(r.readable && r.byItem.has("i-1")).toBe(true);
  });

  it("a failed read is NOT empty — it is unreadable, with a reason", async () => {
    const r = await loadRecordedBases(broken(new Error("The column `RecommendationBasis.specification` does not exist")), "case-1");
    expect(r.readable).toBe(false);
    expect(r.readable === false && r.reason).toMatch(/does not exist/);
  });

  it("a client without the model is unreadable, not empty", async () => {
    const r = await loadRecordedBases({}, "case-1");
    expect(r.readable).toBe(false);
  });

  it("keeps the reason bounded and single-line for display and audit", async () => {
    const r = await loadRecordedBases(broken(new Error(`line one\n  ${"x".repeat(600)}`)), "case-1");
    expect(r.readable).toBe(false);
    if (!r.readable) {
      expect(r.reason).not.toContain("\n");
      expect(r.reason.length).toBeLessThanOrEqual(240);
    }
  });
});

describe("the finding says what was and was not established", () => {
  const f = unreadableBasisFinding("P2022: column does not exist");

  it("blocks a final export", () => {
    expect(f.exportBlocking).toBe(true);
    expect(f.severity).toBe("Critical");
    expect(f.result).toBe(BASIS_UNREADABLE);
  });

  it("refuses to be read as a missing-basis finding", () => {
    // The whole point: BASIS_MISSING is a claim about the plan. This is a claim
    // about the software.
    expect(f.issue).toMatch(/NOT a finding that the recommendations lack a recorded basis/i);
    expect(f.issue).toMatch(/never reached/i);
    expect(f.result).not.toMatch(/BASIS_MISSING|BASIS_STALE/);
  });

  it("carries the cause so someone can fix it", () => {
    expect(f.issue).toContain("P2022: column does not exist");
    expect(f.suggestion).toMatch(/re-run the integrity check/i);
  });

  it("is not a basis divergence, so the reconciliation path does not apply", async () => {
    // Reconciling a divergence is a clinical judgment about a record you can
    // read. There is nothing here for a physician to reconcile.
    const { isBasisDivergenceFinding } = await import("@/lib/engine/basisReconciliation");
    expect(isBasisDivergenceFinding(f.result)).toBe(false);
  });
});

describe("callers that would otherwise assert something false", () => {
  it("the error names the case and the cause", () => {
    const e = new BasisUnreadableError("case-9", "P2022");
    expect(e.name).toBe("BasisUnreadableError");
    expect(e.message).toContain("case-9");
    expect(e.message).toContain("P2022");
    expect(e.message).toMatch(/no recorded assessment can be produced/i);
  });

  it.each([
    ["validation", "src/lib/engine/validation.ts"],
    ["the persistence path", "src/lib/engine/clinicalReasoningPersist.ts"],
    ["the report", "src/lib/export/report.ts"],
    ["the workspace loader", "src/app/(app)/cases/[caseId]/page.tsx"],
  ])("%s loads through the honest loader", async (_label, path) => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "..", path), "utf8");
    expect(src).toMatch(/loadRecordedBases\(/);
  });

  it.each([
    ["validation", "src/lib/engine/validation.ts"],
    ["the persistence path", "src/lib/engine/clinicalReasoningPersist.ts"],
    ["the report", "src/lib/export/report.ts"],
    ["the workspace loader", "src/app/(app)/cases/[caseId]/page.tsx"],
  ])("%s no longer swallows the read", async (_label, path) => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "..", path), "utf8");
    expect(src).not.toMatch(/recommendationBasis\?\.findMany\([^)]*\)\.catch/);
  });

  it("the persistence path raises rather than writing witness content", async () => {
    // Returning an empty result would look like a clean run with no work, and
    // the next reader would take the absence of assessments at face value.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "clinicalReasoningPersist.ts"), "utf8");
    expect(src).toMatch(/throw new BasisUnreadableError/);
  });

  it("the panel is told, rather than shown a silent fallback", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "components", "case", "CaseWorkspace.tsx"), "utf8");
    expect(src).toMatch(/basisUnreadable/);
    expect(src).toMatch(/could not be read/i);
  });
});

describe("an unreadable store is not dispositionable either", () => {
  it("refuses resolve-as-is, ignore and accept-changes", async () => {
    // It is not a divergence — nothing was compared — so it is not in the
    // divergence prefix set and slipped past that check. It is the same kind of
    // statement though: that the plan's agreement with its record is UNKNOWN.
    const { dispositionAllowed } = await import("@/lib/engine/basisReconciliation");
    for (const action of ["resolve_as_is", "ignore", "accept_changes"] as const) {
      const v = dispositionAllowed(BASIS_UNREADABLE, action);
      expect(v.allowed, action).toBe(false);
      expect(v.reason).toMatch(/could not be read/i);
      expect(v.reason).toMatch(/not a judgment a reviewer can make/i);
    }
  });

  it("still allows reopen", async () => {
    const { dispositionAllowed } = await import("@/lib/engine/basisReconciliation");
    expect(dispositionAllowed(BASIS_UNREADABLE, "reopen").allowed).toBe(true);
  });

  it("is not reconcilable — there is nothing to compare, let alone judge", async () => {
    const { isBasisDivergenceFinding } = await import("@/lib/engine/basisReconciliation");
    expect(isBasisDivergenceFinding(BASIS_UNREADABLE)).toBe(false);
  });

  it("stays OPEN through a republish, even carrying a legacy disposition", async () => {
    // There is no independent divergence check that would catch this one —
    // nothing was compared — so a legacy RESOLVED_AS_IS on this key would be
    // the whole bypass restored. It is forced OPEN.
    const { statusForFinding } = await import("@/lib/engine/basisReconciliation");
    const s = statusForFinding(BASIS_UNREADABLE, [], { status: "RESOLVED_AS_IS", resolvedById: "u", resolvedAt: new Date() });
    expect(s.status).toBe("OPEN");
    expect(s.resolvedById).toBeNull();
  });
});
