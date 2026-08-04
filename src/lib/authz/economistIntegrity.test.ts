import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Forensic economist — assumption provenance, deterministic calculation
// integrity, scenario history, medical-cost source eligibility, approval
// currency, and the expert-signature flow. The deterministic engine runs REAL
// (it is pure); prisma and the tenant guard are mocked at the module boundary.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/tenant", () => {
  class TenantError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    requirePermission: vi.fn(),
    requireCanonicalPermission: vi.fn(),
    requireCase: vi.fn(async () => ({ id: "case-8" })),
    audit: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    economicAssumption: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    economicScenario: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    reportApproval: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(),
    },
    reportExport: { findFirst: vi.fn(async () => null) },
    caseSnapshot: { findFirst: vi.fn(async () => null) },
    user: { findMany: vi.fn(async () => []) },
    userCredential: { findMany: vi.fn(async () => []) },
  };
  prisma.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
  return { prisma };
});
vi.mock("@/lib/authz/credentialGate", () => ({
  enforceReviewCredential: vi.fn(async () => {}),
  assertVerifiedCredential: vi.fn(async () => {}),
  credentialCategoryForExpert: vi.fn((role: string) => (role === "economist" ? "ECONOMIST" : "PHYSICIAN")),
}));
vi.mock("@/lib/reports/registry", () => ({ getReport: vi.fn(() => ({ requiredExpert: "economist" })) }));
vi.mock("@/lib/reports/persist", () => ({ approvalStale: vi.fn(() => false) }));

import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission } from "@/lib/tenant";
import { hashEconInputs, computeEconomicLoss, ECON_ENGINE_VERSION, type EconInputs } from "@/lib/engine/economics";
import { GET as econGet, POST as econPost } from "@/app/api/cases/[caseId]/economics/route";
import { POST as approvalPost } from "@/app/api/cases/[caseId]/reports/[exportId]/approval/route";
import { getReport } from "@/lib/reports/registry";

const db = prisma as unknown as Record<string, Record<string, Mock>>;
const mockApiContext = requireApiContext as unknown as Mock;
const mockCanonical = requireCanonicalPermission as unknown as Mock;

const ctx = {
  user: { id: "econ-1", name: "Cameron Price, PhD", role: "ATTORNEY_REVIEWER", credentialSummary: "PhD" },
  firm: { id: "firm-1", isDemo: false, features: { "report.forensic_economist": true } },
  subscription: null,
};

const params = () => ({ params: Promise.resolve({ caseId: "case-8" }) });
const approvalParams = (exportId: string) => ({ params: Promise.resolve({ caseId: "case-8", exportId }) });
const jsonReq = (body: unknown, qs = "") =>
  new Request(`http://t${qs}`, { method: "POST", body: JSON.stringify(body) });

// A complete required-assumption set (decimal-rate units are unambiguous).
const CURRENT_ASSUMPTIONS = [
  { id: "a1", key: "baseline_earnings", value: "68500", unit: "USD/year", source: "W-2 records (synthetic)", expertId: "econ-1" },
  { id: "a2", key: "earnings_growth", value: "0.028", unit: "decimal", source: "ECI series (synthetic)", expertId: "econ-1" },
  { id: "a3", key: "discount_rate", value: "0.03", unit: "decimal", source: "Treasury ladder (synthetic)", expertId: "econ-1" },
  { id: "a4", key: "worklife_expectancy", value: "17.4", unit: "years", source: "Worklife tables (synthetic)", expertId: "econ-1" },
  { id: "a5", key: "loss_start", value: "1", unit: "years", source: "Employer records (synthetic)", expertId: "econ-1" },
];

const BASE_INPUTS: EconInputs = {
  baselineAnnualEarnings: 68500,
  earningsGrowthRate: 0.028,
  discountRate: 0.03,
  worklifeYearsRemaining: 17.4,
  lossStartYearsAgo: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApiContext.mockResolvedValue(ctx);
  mockCanonical.mockImplementation(() => {});
  db.economicAssumption.findMany.mockResolvedValue([]);
  db.economicAssumption.findFirst.mockResolvedValue(null);
  db.economicAssumption.count.mockResolvedValue(0);
  db.economicAssumption.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-a", ...data }));
  db.economicScenario.findMany.mockResolvedValue([]);
  db.economicScenario.findFirst.mockResolvedValue(null);
  db.economicScenario.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `sc-${String(data.name)}`, ...data }));
  db.reportExport.findFirst.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  (getReport as unknown as Mock).mockReturnValue({ requiredExpert: "economist" });
});

describe("POST /economics — assumption provenance", () => {
  const entry = { key: "discount_rate", value: "0.035", unit: "decimal", source: "Updated Treasury ladder (synthetic)" };

  it("rejects unknown computational keys; custom:* keys are accepted as disclosed non-computational assumptions", async () => {
    const bad = await econPost(jsonReq({ ...entry, key: "made_up_key" }), params());
    expect(bad.status).toBe(422);
    expect(db.economicAssumption.create).not.toHaveBeenCalled();

    const custom = await econPost(jsonReq({ ...entry, key: "custom:tax_note" }), params());
    expect(custom.status).toBe(200);
    // Non-computational entry never stales economist signatures.
    expect(db.reportApproval.updateMany).not.toHaveBeenCalled();
  });

  it("supersedes transactionally: create + supersede-all-other-current commit atomically, single current version guaranteed", async () => {
    db.economicAssumption.findFirst.mockResolvedValue({ id: "a3", value: "0.03", unit: "decimal", source: "Treasury ladder (synthetic)" });
    db.economicAssumption.count.mockResolvedValue(2);
    const res = await econPost(jsonReq(entry), params());
    expect(res.status).toBe(200);
    expect(db.$transaction as unknown as Mock).toHaveBeenCalled();
    expect(db.economicAssumption.updateMany).toHaveBeenCalledWith({
      where: { caseId: "case-8", firmId: "firm-1", key: "discount_rate", supersededById: null, NOT: { id: "new-a" } },
      data: { supersededById: "new-a" },
    });
    // Version increments from full history; prior rows are never deleted.
    expect(db.economicAssumption.create.mock.calls[0][0].data.version).toBe(3);
    expect(db.economicAssumption.create.mock.calls[0][0].data.expertId).toBe("econ-1");
  });

  it("a substantive change stales ACTIVE economist approvals; re-entering the identical value does not", async () => {
    db.economicAssumption.findFirst.mockResolvedValue({ id: "a3", value: "0.03", unit: "decimal", source: "Treasury ladder (synthetic)" });
    await econPost(jsonReq(entry), params());
    expect(db.reportApproval.updateMany).toHaveBeenCalledWith({
      where: { caseId: "case-8", firmId: "firm-1", expertRole: "economist", status: "ACTIVE" },
      data: { status: "STALE", invalidReason: expect.any(String) },
    });

    vi.clearAllMocks();
    mockApiContext.mockResolvedValue(ctx);
    db.economicAssumption.findFirst.mockResolvedValue({ id: "a3", value: "0.035", unit: "decimal", source: "Updated Treasury ladder (synthetic)" });
    db.economicAssumption.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-a2", ...data }));
    await econPost(jsonReq(entry), params());
    expect(db.reportApproval.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /economics?compute=1 — deterministic calculation integrity", () => {
  beforeEach(() => {
    db.economicAssumption.findMany.mockResolvedValue(CURRENT_ASSUMPTIONS);
  });

  it("refuses to compute with required assumptions missing — nothing is ever defaulted", async () => {
    db.economicAssumption.findMany.mockResolvedValue(CURRENT_ASSUMPTIONS.slice(0, 3));
    const res2 = await econPost(jsonReq({}, "?compute=1"), params());
    expect(res2.status).toBe(422);
    const body = await res2.json();
    expect(body.missing).toContain("worklife_expectancy");
    expect(db.economicScenario.create).not.toHaveBeenCalled();
  });

  it("reserved base name and duplicate scenario names are refused", async () => {
    const reserved = await econPost(jsonReq({ scenarios: [{ name: "base", overrides: {} }] }, "?compute=1"), params());
    expect(reserved.status).toBe(422);
    const dupes = await econPost(
      jsonReq({ scenarios: [{ name: "low", overrides: {} }, { name: "low", overrides: {} }] }, "?compute=1"),
      params(),
    );
    expect(dupes.status).toBe(422);
    expect(db.economicScenario.create).not.toHaveBeenCalled();
  });

  it("records an immutable calculation run: creates a NEW row, supersedes the prior current row, and never updates in place", async () => {
    db.economicScenario.findFirst.mockResolvedValue({ id: "old-base", result: { inputsHash: "old-hash" } });
    const res = await econPost(jsonReq({}, "?compute=1"), params());
    expect(res.status).toBe(200);
    expect(db.economicScenario.create).toHaveBeenCalled();
    expect(db.economicScenario.updateMany).toHaveBeenCalledWith({
      where: { caseId: "case-8", firmId: "firm-1", name: "base", supersededById: null, NOT: { id: "sc-base" } },
      data: { supersededById: "sc-base" },
    });
    const stored = db.economicScenario.create.mock.calls[0][0].data;
    expect(stored.computedById).toBe("econ-1");
    expect(stored.result.engineVersion).toBe(ECON_ENGINE_VERSION);
    // Identical inputs ⇒ identical stored hash and totals (engine ran real).
    const expected = computeEconomicLoss(BASE_INPUTS);
    expect(stored.result.inputsHash).toBe(expected.inputsHash);
    expect(stored.result.totalPresentValue).toBeCloseTo(expected.totalPresentValue, 6);
  });

  it("client-supplied totals and results are ignored — the server computes everything", async () => {
    await econPost(
      jsonReq({ scenarios: [], result: { totalPresentValue: 1 }, totalPresentValue: 1, inputsHash: "attacker" }, "?compute=1"),
      params(),
    );
    const stored = db.economicScenario.create.mock.calls[0][0].data;
    expect(stored.result.totalPresentValue).toBeCloseTo(computeEconomicLoss(BASE_INPUTS).totalPresentValue, 6);
    expect(stored.result.inputsHash).not.toBe("attacker");
  });

  it("a changed base-input hash stales ACTIVE economist approvals before the new run is recorded", async () => {
    db.economicScenario.findFirst.mockResolvedValue({ id: "old-base", result: { inputsHash: "different-old-hash" } });
    await econPost(jsonReq({}, "?compute=1"), params());
    expect(db.reportApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ expertRole: "economist", status: "ACTIVE" }) }),
    );
  });

  it("the medical component comes ONLY from a final, non-superseded, hash-bearing export — with full provenance stored", async () => {
    db.reportExport.findFirst.mockResolvedValue({
      id: "exp-9", reportType: "LIFE_CARE_PLAN", totalPresentValue: 259377, contentSha256: "abc123", version: 3,
    });
    await econPost(jsonReq({}, "?compute=1"), params());
    // Eligibility criteria are in the QUERY — drafts, superseded rows, and
    // hashless exports can never be selected.
    expect(db.reportExport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ draft: false, supersededById: null, contentSha256: { not: null } }),
      }),
    );
    const stored = db.economicScenario.create.mock.calls[0][0].data;
    expect(stored.result.medicalSource).toMatchObject({ exportId: "exp-9", contentSha256: "abc123", version: 3, presentValue: 259377 });
    expect(stored.result.medicalSource.selectedAt).toEqual(expect.any(String));
    expect(stored.result.totalPresentValue).toBeCloseTo(
      computeEconomicLoss({ ...BASE_INPUTS, medicalCostPresentValue: 259377 }).totalPresentValue,
      6,
    );
  });

  it("with no eligible export the medical component is omitted and disclosed — never estimated", async () => {
    await econPost(jsonReq({}, "?compute=1"), params());
    const stored = db.economicScenario.create.mock.calls[0][0].data;
    expect(stored.result.medicalSource).toBeNull();
    expect(stored.result.medicalCostPresentValue).toBe(0);
    expect(stored.result.medicalNote).toContain("omitted, not estimated");
  });
});

describe("GET /economics — fail-closed staleness", () => {
  it("a stored scenario whose hash no longer matches the current assumptions is reported STALE and drops readiness to recomputation", async () => {
    db.economicAssumption.findMany.mockResolvedValue(CURRENT_ASSUMPTIONS);
    db.economicScenario.findMany.mockResolvedValue([
      { id: "sc1", name: "base", overrides: {}, result: { inputsHash: "stale-hash", medicalSource: null, totalPresentValue: 1 }, computedAt: new Date() },
    ]);
    const res = await econGet(new Request("http://t"), params());
    const body = await res.json();
    expect(body.scenarios[0].stale).toBe(true);
    expect(body.readiness.status).toBe("Expert input required");
    expect(body.readiness.missing[0]).toMatch(/recompute/i);
  });

  it("a current scenario (matching hash, same medical source) is not stale", async () => {
    db.economicAssumption.findMany.mockResolvedValue(CURRENT_ASSUMPTIONS);
    const real = computeEconomicLoss(BASE_INPUTS);
    db.economicScenario.findMany.mockResolvedValue([
      { id: "sc1", name: "base", overrides: {}, result: { inputsHash: real.inputsHash, medicalSource: null, totalPresentValue: real.totalPresentValue }, computedAt: new Date() },
    ]);
    const res = await econGet(new Request("http://t"), params());
    const body = await res.json();
    expect(body.scenarios[0].stale).toBe(false);
    expect(body.readiness.status).toBe("Draft support package available");
  });

  it("a superseded medical-cost source makes the stored scenario stale even when the amount is unchanged", async () => {
    db.economicAssumption.findMany.mockResolvedValue(CURRENT_ASSUMPTIONS);
    const withMedical = computeEconomicLoss({ ...BASE_INPUTS, medicalCostPresentValue: 100000 });
    db.economicScenario.findMany.mockResolvedValue([
      { id: "sc1", name: "base", overrides: {}, result: { inputsHash: withMedical.inputsHash, medicalSource: { exportId: "old-export", presentValue: 100000 }, totalPresentValue: 1 }, computedAt: new Date() },
    ]);
    // A NEW export is now the eligible source (same PV, different identity).
    db.reportExport.findFirst.mockResolvedValue({ id: "new-export", reportType: "LIFE_CARE_PLAN", totalPresentValue: 100000, contentSha256: "h", version: 4 });
    const res = await econGet(new Request("http://t"), params());
    const body = await res.json();
    expect(body.scenarios[0].stale).toBe(true);
  });
});

describe("expert signature flow (approval route)", () => {
  const draftExport = {
    id: "exp-1", caseId: "case-8", firmId: "firm-1", draft: true, reportType: "FORENSIC_ECONOMIST_REPORT",
    contentSha256: "sha-1", snapshotId: null,
  };
  const approvalBody = () => jsonReq({ kind: "APPROVAL", statementText: "Economic conclusions as stated.", confirm: true });

  beforeEach(() => {
    db.userCredential.findMany.mockResolvedValue([{ category: "ECONOMIST", status: "ORG_VERIFIED", expiresAt: null }]);
    db.reportApproval.create.mockResolvedValue({ id: "appr-1" });
  });

  it("the economist may sign the NEWEST draft of their own report — the deadlock is gone, the signature stays hash-bound", async () => {
    db.reportExport.findFirst.mockResolvedValue(draftExport);
    const res = await approvalPost(approvalBody(), approvalParams("exp-1"));
    expect(res.status).toBe(200);
    expect(db.reportApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewerId: "econ-1", contentSha256: "sha-1", expertRole: "economist" }) }),
    );
  });

  it("an OLDER draft cannot be signed — only the most recent export of the report", async () => {
    // loadExport returns the old export; the newest-check finds a different one.
    db.reportExport.findFirst
      .mockResolvedValueOnce(draftExport)
      .mockResolvedValueOnce({ id: "exp-2" });
    const res = await approvalPost(approvalBody(), approvalParams("exp-1"));
    expect(res.status).toBe(409);
    expect(db.reportApproval.create).not.toHaveBeenCalled();
  });

  it("physician-report drafts remain unsignable", async () => {
    (getReport as unknown as Mock).mockReturnValue({ requiredExpert: "physician" });
    db.userCredential.findMany.mockResolvedValue([{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: null }]);
    db.reportExport.findFirst.mockResolvedValue({ ...draftExport, reportType: "LIFE_CARE_PLAN" });
    const res = await approvalPost(jsonReq({ kind: "ATTESTATION", statementText: "x", confirm: true }), approvalParams("exp-1"));
    expect(res.status).toBe(409);
    expect(db.reportApproval.create).not.toHaveBeenCalled();
  });
});
