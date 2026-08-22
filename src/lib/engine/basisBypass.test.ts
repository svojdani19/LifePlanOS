// The exact bypass: disposition a basis divergence, then export a final.
//
// BASIS_STALE / BASIS_MISSING say the plan and the record it rests on are
// different objects. They were ordinary ValidationFinding rows, so anyone with
// report.export or case.edit could set them RESOLVED_AS_IS or IGNORED — and the
// final-export gate counts only OPEN blocking findings. Two clicks turned "this
// report does not match its record" into a clean release, mismatch intact and
// now invisible.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { dispositionAllowed, isBasisDivergenceFinding, validateReconciliation } from "@/lib/engine/basisReconciliation";

describe("recognising a divergence finding", () => {
  it("matches the codes validation actually writes, hash pair and all", () => {
    expect(isBasisDivergenceFinding("BASIS_STALE:abc123def456->789xyz012345")).toBe(true);
    expect(isBasisDivergenceFinding("BASIS_MISSING:none->789xyz012345")).toBe(true);
    expect(isBasisDivergenceFinding("BASIS_STALE")).toBe(true);
  });

  it("does not sweep in unrelated findings", () => {
    // Every other validation workflow keeps its existing behaviour.
    for (const r of ["Missing citation", "Cost inconsistency", "Code mismatch", "RETRIEVAL_FAILED:article-citations:AUTH", "REFRESH_INCOMPLETE:validation"]) {
      expect(isBasisDivergenceFinding(r)).toBe(false);
    }
  });

  it("is not fooled by a lookalike prefix", () => {
    expect(isBasisDivergenceFinding("BASIS_STALENESS_REVIEWED")).toBe(false);
  });
});

describe("generic dispositions cannot close a divergence", () => {
  it.each(["resolve_as_is", "ignore", "accept_changes"] as const)("refuses %s", (action) => {
    const v = dispositionAllowed("BASIS_STALE:aaa->bbb", action);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/different objects/i);
  });

  it("still allows reopen — that only ever moves toward blocking", () => {
    expect(dispositionAllowed("BASIS_STALE:aaa->bbb", "reopen").allowed).toBe(true);
  });

  it("leaves every other finding's workflow untouched", () => {
    for (const action of ["resolve_as_is", "ignore", "accept_changes", "reopen"] as const) {
      expect(dispositionAllowed("Cost inconsistency", action).allowed).toBe(true);
    }
  });
});

describe("a reconciliation must actually say something", () => {
  const base = {
    caseId: "c", firmId: "f", futureCareItemId: "i",
    recordedHash: "aaa", derivedHash: "bbb",
    actorUserId: "u", credentialLabel: "MD", reason: "The new imaging supports the same plan.",
  };

  it("accepts a substantive reconciliation", () => {
    expect(validateReconciliation(base)).toBeNull();
  });

  it("rejects an empty or token reason", () => {
    expect(validateReconciliation({ ...base, reason: "   " })).toMatch(/why/i);
    expect(validateReconciliation({ ...base, reason: "ok" })).toMatch(/substantive/i);
  });

  it("rejects one that names no credential — it is a professional act", () => {
    expect(validateReconciliation({ ...base, credentialLabel: "" })).toMatch(/credential/i);
  });

  it("rejects one with nothing to reconcile against", () => {
    expect(validateReconciliation({ ...base, derivedHash: "" })).toMatch(/current derived basis/i);
  });
});

// ── Route level ─────────────────────────────────────────────────────────────

vi.mock("@/lib/tenant", () => {
  class TenantError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) { super(message); }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    requirePermission: vi.fn(),
    requireCanonicalPermission: vi.fn(),
    requireCase: vi.fn(async () => ({ id: "case-1" })),
    audit: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    validationFinding: { findFirst: vi.fn(), update: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    futureCareItem: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/engine/validation", () => ({
  persistCaseValidation: vi.fn(async () => ({ counts: {}, blocking: false, findings: [] })),
  openBlockingCount: vi.fn(async () => 0),
  unreconciledBasisDivergences: vi.fn(async () => []),
}));
vi.mock("@/lib/engine/generate", () => ({ recomputeCosts: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireApiContext } from "@/lib/tenant";
import { POST as disposition } from "@/app/api/cases/[caseId]/validation/[findingId]/route";

const findingFindFirst = (prisma as unknown as { validationFinding: { findFirst: Mock; update: Mock } }).validationFinding;
const params = { params: Promise.resolve({ caseId: "case-1", findingId: "f-1" }) };
const req = (action: string) => new Request("http://t/x", { method: "POST", body: JSON.stringify({ action }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiContext as Mock).mockResolvedValue({ firm: { id: "firm-1" }, user: { id: "user-1" } });
});

describe("the disposition route refuses the bypass", () => {
  it.each(["resolve_as_is", "ignore"])("409s a BASIS_STALE finding on %s and writes nothing", async (action) => {
    findingFindFirst.findFirst.mockResolvedValue({ id: "f-1", service: "TKA", result: "BASIS_STALE:aaa->bbb" });
    const res = await disposition(req(action), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "BASIS_DIVERGENCE_NOT_DISPOSITIONABLE" });
    expect(findingFindFirst.update).not.toHaveBeenCalled();
  });

  it("409s BASIS_MISSING too", async () => {
    findingFindFirst.findFirst.mockResolvedValue({ id: "f-1", service: "TKA", result: "BASIS_MISSING:none->bbb" });
    expect((await disposition(req("ignore"), params)).status).toBe(409);
  });

  it("still dispositions an ordinary finding", async () => {
    findingFindFirst.findFirst.mockResolvedValue({ id: "f-1", service: "TKA", result: "Cost inconsistency" });
    const res = await disposition(req("resolve_as_is"), params);
    expect(res.status).toBe(200);
    expect(findingFindFirst.update).toHaveBeenCalled();
  });

  it("still lets a basis finding be reopened", async () => {
    findingFindFirst.findFirst.mockResolvedValue({ id: "f-1", service: "TKA", result: "BASIS_STALE:aaa->bbb" });
    const res = await disposition(req("reopen"), params);
    expect(res.status).toBe(200);
    expect(findingFindFirst.update).toHaveBeenCalled();
  });
});
