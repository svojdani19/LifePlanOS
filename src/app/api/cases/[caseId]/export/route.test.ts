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
  buildCostCsv: vi.fn(async () => "csv"),
}));
vi.mock("@/lib/export/pdf", () => ({ convertDocxToPdf: vi.fn(async (b: Buffer) => b) }));
vi.mock("@/lib/engine/validation", () => ({
  persistCaseValidation: vi.fn(async () => ({ blocking: 0, findings: [], counts: {} })),
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
  includedPresentValue: 2000,
  includedLifetimeCost: 2400,
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

  it("fails safely when rendered totals do not match the verified included set", async () => {
    deps.evaluate.mockResolvedValue(AUTHORIZED);
    deps.buildReportDocx.mockResolvedValue({ buffer: Buffer.from("docx"), totalLifetime: 999, totalPresentValue: 999, itemCount: 1 });
    const res = await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(res.status).toBe(409);
    expect(db.exportCreate).not.toHaveBeenCalled();
  });
});
