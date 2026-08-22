// Legacy export route — enforcement of the professional-authority gate for
// FINAL expert DOCX/PDF release. A blocked attempt must create no file, no
// ReportExport artifact, and no case-status advancement, and must be audited
// with PHI-free reason codes; drafts remain available without attestation.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  exportCount: vi.fn(),
  exportCreate: vi.fn(),
  caseUpdateMany: vi.fn(),
  caseFindUniqueOrThrow: vi.fn(),
  itemAggregate: vi.fn(),
  snapshotCreate: vi.fn(),
}));
const deps = vi.hoisted(() => ({
  audit: vi.fn(),
  recordUsage: vi.fn(),
  putObject: vi.fn(),
  buildReportDocx: vi.fn(),
  evaluate: vi.fn(),
  divergences: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    reportExport: { count: db.exportCount, create: db.exportCreate, findMany: vi.fn() },
    case: { updateMany: db.caseUpdateMany, findUniqueOrThrow: db.caseFindUniqueOrThrow },
    futureCareItem: { aggregate: db.itemAggregate },
    caseSnapshot: { create: db.snapshotCreate },
  },
}));
vi.mock("@/lib/tenant", () => ({
  requireApiContext: vi.fn(async () => ({ user: { id: "user-1", role: "ADMIN" }, firm: { id: "firm-1" } })),
  requirePermission: vi.fn(),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
  audit: deps.audit,
  recordUsage: deps.recordUsage,
}));
vi.mock("@/lib/export/report", () => ({
  buildReportDocx: deps.buildReportDocx,
  buildCostCsv: vi.fn(async () => ({ csv: "csv", itemCount: 2, totalLifetime: 2400, totalPresentValue: 2000 })),
}));
vi.mock("@/lib/export/pdf", () => ({ convertDocxToPdf: vi.fn(async (b: Buffer) => b) }));
vi.mock("@/lib/engine/validation", () => ({
  persistCaseValidation: vi.fn(async () => ({ blocking: 0, findings: [], counts: {} })),
  openBlockingCount: vi.fn(async () => 0),
  unreconciledBasisDivergences: deps.divergences,
}));
vi.mock("@/lib/engine/clinicalReasoningPersist", () => ({ persistCaseReasoning: vi.fn(async () => null) }));
vi.mock("@/lib/engine/snapshot", () => ({ buildSnapshotPayload: vi.fn(() => ({})) }));
vi.mock("@/lib/engine/generate", () => ({ assumptionsFor: vi.fn(() => ({})) }));
vi.mock("@/lib/storage", () => ({ putObject: deps.putObject }));
vi.mock("@/lib/reports/professionalAuthority", () => ({ evaluatePhysicianReportAuthority: deps.evaluate }));

import { POST } from "./route";

const AUTHORIZED = {
  authorized: true as const,
  attestationId: "att-1",
  signerUserId: "md-1",
  signerName: "Dr. Test, MD",
  signerCredentialSummary: null,
  statementText: "signed",
  signedAt: new Date(),
  contentHash: "h".repeat(64),
  attestedItemCount: 2,
  attestedPresentValue: 2000,
  includedFingerprint: "f1",
  includedItemIds: ["a", "b"],
  includedCount: 2,
  includedPresentValue: 2000,
  includedLifetimeCost: 2400,
  clinicalFingerprint: "cf1",
  financialFingerprint: "ff1",
  reportFingerprint: "rf1",
  coveredScopes: ["FUTURE_CARE_MEDICAL_NECESSITY", "FREQUENCY_AND_DURATION"],
};

function req(body: unknown): Request {
  return new Request("http://localhost/api/cases/case-1/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ caseId: "case-1" }) };

beforeEach(() => {
  [...Object.values(db), ...Object.values(deps)].forEach((fn) => fn.mockReset());
  db.exportCount.mockResolvedValue(0);
  db.exportCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "exp-1", version: 1, ...data }));
  db.caseFindUniqueOrThrow.mockRejectedValue(new Error("no snapshot data"));
  deps.putObject.mockResolvedValue("key-1");
  deps.buildReportDocx.mockResolvedValue({ buffer: Buffer.from("docx"), totalLifetime: 2400, totalPresentValue: 2000, itemCount: 2 });
  deps.divergences.mockResolvedValue([]);
});

describe("the record must agree with the document", () => {
  // The bypass this closes: mark the BASIS_STALE finding resolved-as-is, and
  // the OPEN-only gate lets a final release through with the plan and its
  // record still describing different objects. This gate re-derives, so no
  // disposition — malformed, legacy or deliberate — can buy a release.
  const DIVERGED = [{ futureCareItemId: "i-1", service: "Total knee arthroplasty", state: "STALE" as const, recordedHash: "aaa", derivedHash: "bbb", reconciled: false }];

  it("blocks a final DOCX when a recommendation diverges from its recorded basis", async () => {
    deps.divergences.mockResolvedValue(DIVERGED);
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.reasons).toContain("BASIS_DIVERGENCE");
    // Nothing is produced, stored, or advanced.
    expect(deps.buildReportDocx).not.toHaveBeenCalled();
    expect(deps.putObject).not.toHaveBeenCalled();
    expect(db.exportCreate).not.toHaveBeenCalled();
    expect(db.caseUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks PDF on the same basis", async () => {
    deps.divergences.mockResolvedValue(DIVERGED);
    expect((await POST(req({ format: "PDF", mode: "final" }), params)).status).toBe(422);
  });

  it("audits the denial with structural, PHI-free metadata", async () => {
    deps.divergences.mockResolvedValue(DIVERGED);
    await POST(req({ format: "DOCX", mode: "final" }), params);
    const call = deps.audit.mock.calls.find((c) => c[1] === "export.final_denied");
    expect(call).toBeTruthy();
    expect(call![2].meta).toMatchObject({ reasons: ["BASIS_DIVERGENCE"], diverged: 1 });
    expect(JSON.stringify(call![2].meta)).not.toMatch(/knee|arthroplasty/i);
  });

  it("blocks BEFORE the professional-authority gate — a signed attestation does not cure it", async () => {
    deps.divergences.mockResolvedValue(DIVERGED);
    deps.evaluate.mockResolvedValue(AUTHORIZED);
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).reasons).toContain("BASIS_DIVERGENCE");
  });

  it("does not block a DRAFT — the divergence is disclosed on its face instead", async () => {
    deps.divergences.mockResolvedValue(DIVERGED);
    const res = await POST(req({ format: "DOCX", mode: "draft" }), params);
    expect(res.status).toBe(200);
    expect(deps.buildReportDocx).toHaveBeenCalled();
  });

  it("lets a reconciled divergence through — that is the credentialed path", async () => {
    // unreconciledBasisDivergences filters these out, so an empty list here IS
    // the reconciled case.
    deps.divergences.mockResolvedValue([]);
    deps.evaluate.mockResolvedValue(AUTHORIZED);
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(200);
  });
});

describe("CSV release semantics", () => {
  it("rejects a final-mode CSV outright — never silently reinterpreted", async () => {
    const res = await POST(req({ format: "CSV", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.reasons).toContain("CSV_FINAL_NOT_OFFERED");
    expect(deps.putObject).not.toHaveBeenCalled();
    expect(db.exportCreate).not.toHaveBeenCalled();
    expect(db.caseUpdateMany).not.toHaveBeenCalled();
    // The authority gate is never even consulted for a rejected CSV final.
    expect(deps.evaluate).not.toHaveBeenCalled();
  });

  it("supporting CSV exports without authority, never advances the case, and records the included-set totals as a draft artifact", async () => {
    const res = await POST(req({ format: "CSV", mode: "draft" }), params);
    expect(res.status).toBe(200);
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(db.caseUpdateMany).not.toHaveBeenCalled();
    const created = db.exportCreate.mock.calls[0][0].data;
    // Totals/count come from the deterministic included set, not all items.
    expect(created.itemCount).toBe(2);
    expect(created.totalLifetimeCost).toBe(2400);
    expect(created.totalPresentValue).toBe(2000);
    // A CSV is always a supporting/draft artifact.
    expect(created.draft).toBe(true);
  });
});

describe("final expert export enforcement", () => {
  it("blocks a final DOCX without professional authority: 422, no file, no artifact, no status change, audited", async () => {
    deps.evaluate.mockResolvedValue({ authorized: false, reasons: ["NO_ACTIVE_ATTESTATION"], includedFingerprint: null });
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("professional approval");
    expect(body.reasons).toEqual(["NO_ACTIVE_ATTESTATION"]);
    expect(JSON.stringify(body)).not.toMatch(/Margaret|diagnos|record text/i);
    expect(deps.buildReportDocx).not.toHaveBeenCalled();
    expect(deps.putObject).not.toHaveBeenCalled();
    expect(db.exportCreate).not.toHaveBeenCalled();
    expect(db.caseUpdateMany).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.anything(),
      "export.final_denied",
      expect.objectContaining({ meta: expect.objectContaining({ reasons: ["NO_ACTIVE_ATTESTATION"] }) }),
    );
  });

  it("keeps draft export available without any attestation", async () => {
    deps.evaluate.mockResolvedValue({ authorized: false, reasons: ["NO_ACTIVE_ATTESTATION"], includedFingerprint: null });
    const res = await POST(req({ format: "DOCX", mode: "draft" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.export.draft).toBe(true);
    expect(deps.evaluate).not.toHaveBeenCalled(); // drafts never consult the expert gate
    expect(db.caseUpdateMany).not.toHaveBeenCalled(); // drafts never advance the case
  });

  it("allows a final export under a current verified attestation covering the included set", async () => {
    deps.evaluate.mockResolvedValue(AUTHORIZED);
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(200);
    expect(deps.putObject).toHaveBeenCalledTimes(1);
    expect(db.exportCreate).toHaveBeenCalledTimes(1);
    expect(db.caseUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("fails safely when the plan changes during generation (fingerprint drift)", async () => {
    deps.evaluate
      .mockResolvedValueOnce(AUTHORIZED)
      .mockResolvedValueOnce({ ...AUTHORIZED, includedFingerprint: "f2-CHANGED" });
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reasons).toEqual(["PLAN_CHANGED_DURING_GENERATION"]);
    expect(deps.putObject).not.toHaveBeenCalled();
    expect(db.exportCreate).not.toHaveBeenCalled();
    expect(db.caseUpdateMany).not.toHaveBeenCalled();
  });

  it("fails safely when the attestation is invalidated during generation", async () => {
    deps.evaluate
      .mockResolvedValueOnce(AUTHORIZED)
      .mockResolvedValueOnce({ authorized: false, reasons: ["ATTESTATION_DRIFTED"], includedFingerprint: "f1" });
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(409);
    expect(db.exportCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["clinical fingerprint", { clinicalFingerprint: "cf-CHANGED" }],
    ["financial fingerprint", { financialFingerprint: "ff-CHANGED" }],
    ["report fingerprint", { reportFingerprint: "rf-CHANGED" }],
    ["included ids", { includedItemIds: ["a", "c"] }],
    ["included count", { includedCount: 3 }],
  ] as const)("fails safely when the %s drifts during generation", async (_label, drift) => {
    deps.evaluate
      .mockResolvedValueOnce(AUTHORIZED)
      .mockResolvedValueOnce({ ...AUTHORIZED, ...drift });
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.reasons).toEqual(["PLAN_CHANGED_DURING_GENERATION"]);
    expect(deps.putObject).not.toHaveBeenCalled();
    expect(db.exportCreate).not.toHaveBeenCalled();
    expect(db.caseUpdateMany).not.toHaveBeenCalled();
  });

  it("fails safely when rendered totals do not match the verified included set", async () => {
    deps.evaluate.mockResolvedValue(AUTHORIZED);
    deps.buildReportDocx.mockResolvedValue({ buffer: Buffer.from("docx"), totalLifetime: 999, totalPresentValue: 999, itemCount: 1 });
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(409);
    expect(db.exportCreate).not.toHaveBeenCalled();
  });
});
