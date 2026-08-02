import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Professional-credential boundary regression tests (docs/26 hardening).
//
// The invariant under test: no server path lets a person sign/attest outside
// their own verified professional credential, regardless of the seat (role)
// they occupy. Prisma and the tenant guard are mocked at the module boundary
// (same pattern as the export-download route test) — no database, no session.
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
    requireCase: vi.fn(async () => ({ id: "case-1" })),
    audit: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    userCredential: { findMany: vi.fn(async () => []) },
    vocationalEntry: { create: vi.fn() },
    reportExport: { findFirst: vi.fn() },
    reportApproval: { updateMany: vi.fn(async () => ({ count: 0 })), create: vi.fn(), findMany: vi.fn(async () => []) },
    caseSnapshot: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/engine/attestationService", () => ({
  signAttestation: vi.fn(async () => ({
    attestation: { id: "att-1", itemCount: 1, totalPresentValue: 100, contentHash: "hash" },
    superseded: null,
  })),
  refreshCaseAttestations: vi.fn(async () => {}),
}));
vi.mock("@/lib/engine/attestation", () => ({ verifyAttestation: vi.fn() }));
vi.mock("@/lib/reports/registry", () => ({ getReport: vi.fn(() => ({ requiredExpert: "physician" })) }));
vi.mock("@/lib/reports/persist", () => ({ approvalStale: vi.fn(() => false) }));

import { prisma } from "@/lib/db";
import { requireApiContext, audit } from "@/lib/tenant";
import { signAttestation } from "@/lib/engine/attestationService";
import { assertVerifiedCredential, enforceReviewCredential, hasVerifiedCredential, credentialCategoryForExpert } from "./credentialGate";
import { POST as attestPost } from "@/app/api/cases/[caseId]/attestation/route";
import { POST as approvalPost } from "@/app/api/cases/[caseId]/reports/[exportId]/approval/route";
import { POST as vocationalPost } from "@/app/api/cases/[caseId]/vocational/route";

const findCredentials = prisma.userCredential.findMany as unknown as Mock;
const mockApiContext = requireApiContext as unknown as Mock;
const auditMock = audit as unknown as Mock;

const FUTURE = new Date(Date.now() + 365 * 24 * 3600 * 1000);
const PAST = new Date(Date.now() - 24 * 3600 * 1000);

const cred = (category: string | null, status = "ORG_VERIFIED", expiresAt: Date | null = null) => ({
  category,
  status,
  expiresAt,
});

const ctxOf = (over: { role?: string; features?: unknown; isDemo?: boolean } = {}) => ({
  user: { id: "user-1", name: "Test User", role: over.role ?? "PHYSICIAN_REVIEWER", credentialSummary: null },
  firm: { id: "firm-1", isDemo: over.isDemo ?? false, features: over.features ?? null },
  subscription: null,
});

const actor = { userId: "user-1", firmId: "firm-1" };

// Silence + capture the structured credential.gap warnings. clearAllMocks in
// beforeEach resets call history but keeps the no-op implementation.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  findCredentials.mockResolvedValue([]);
  mockApiContext.mockResolvedValue(ctxOf());
});

// ── The gate itself ──────────────────────────────────────────────────────────

describe("assertVerifiedCredential — category boundaries", () => {
  it("(b) an economist credential can never pass the PHYSICIAN gate", async () => {
    findCredentials.mockResolvedValue([cred("ECONOMIST")]);
    await expect(assertVerifiedCredential(actor, "PHYSICIAN")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("(a) a vocational credential can never pass the PHYSICIAN gate", async () => {
    findCredentials.mockResolvedValue([cred("VOCATIONAL")]);
    await expect(assertVerifiedCredential(actor, "PHYSICIAN")).rejects.toMatchObject({ status: 403 });
  });

  it("(d) a physician credential can never pass the VOCATIONAL or ECONOMIST gate", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN")]);
    await expect(assertVerifiedCredential(actor, "VOCATIONAL")).rejects.toMatchObject({ status: 403 });
    await expect(assertVerifiedCredential(actor, "ECONOMIST")).rejects.toMatchObject({ status: 403 });
  });

  it("(e) no credentials at all (admin / QA seat) fails every category", async () => {
    findCredentials.mockResolvedValue([]);
    for (const category of ["PHYSICIAN", "VOCATIONAL", "ECONOMIST"] as const) {
      await expect(assertVerifiedCredential(actor, category)).rejects.toMatchObject({ status: 403 });
    }
  });

  it("(f) EXPIRED and SUSPENDED statuses are rejected even with the right category", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN", "EXPIRED"), cred("PHYSICIAN", "SUSPENDED")]);
    await expect(assertVerifiedCredential(actor, "PHYSICIAN")).rejects.toMatchObject({ status: 403 });
  });

  it("(f) a verified credential whose expiresAt has passed is rejected", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN", "ORG_VERIFIED", PAST)]);
    await expect(assertVerifiedCredential(actor, "PHYSICIAN")).rejects.toMatchObject({ status: 403 });
  });

  it("(h) SELF_REPORTED and PENDING never qualify; legacy rows (no category) never qualify", async () => {
    findCredentials.mockResolvedValue([
      cred("PHYSICIAN", "SELF_REPORTED"),
      cred("PHYSICIAN", "PENDING"),
      cred(null, "SELF_REPORTED"), // legacy upload — no category
    ]);
    await expect(assertVerifiedCredential(actor, "PHYSICIAN")).rejects.toMatchObject({ status: 403 });
    expect(await hasVerifiedCredential(actor, "PHYSICIAN")).toBe(false);
  });

  it("(g) ORG_VERIFIED (no expiry) and EXTERNALLY_VERIFIED (future expiry) pass", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN", "ORG_VERIFIED", null)]);
    await expect(assertVerifiedCredential(actor, "PHYSICIAN")).resolves.toBeUndefined();
    findCredentials.mockResolvedValue([cred("VOCATIONAL", "EXTERNALLY_VERIFIED", FUTURE)]);
    await expect(assertVerifiedCredential(actor, "VOCATIONAL")).resolves.toBeUndefined();
  });

  it("accepts a full TenantContext as the actor and scopes the query to user+firm", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN")]);
    await expect(assertVerifiedCredential(ctxOf() as never, "PHYSICIAN")).resolves.toBeUndefined();
    expect(findCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", firmId: "firm-1" } }),
    );
  });

  it("maps report expert roles to credential categories", () => {
    expect(credentialCategoryForExpert("physician")).toBe("PHYSICIAN");
    expect(credentialCategoryForExpert("vocational")).toBe("VOCATIONAL");
    expect(credentialCategoryForExpert("economist")).toBe("ECONOMIST");
    expect(credentialCategoryForExpert("unknown")).toBeNull();
  });
});

describe("enforceReviewCredential — review-class decisions", () => {
  it("blocks a non-credentialed reviewer when the firm opted into enterprise authorization", async () => {
    const ctx = ctxOf({ features: { "authorization.enterprise": true } });
    await expect(
      enforceReviewCredential(ctx as never, "PHYSICIAN", { action: "futurecare.physician_review", caseId: "case-1" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("blocks a non-credentialed reviewer on a demo firm", async () => {
    const ctx = ctxOf({ isDemo: true });
    await expect(
      enforceReviewCredential(ctx as never, "PHYSICIAN", { action: "futurecare.accept_all" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("logs a structured credential.gap (console + audit) instead of blocking for legacy firms", async () => {
    const ctx = ctxOf();
    await expect(
      enforceReviewCredential(ctx as never, "ECONOMIST", { action: "economics.assumption", caseId: "case-9" }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(logged).toMatchObject({
      event: "credential.gap",
      userId: "user-1",
      firmId: "firm-1",
      requiredCredential: "ECONOMIST",
      action: "economics.assumption",
      caseId: "case-9",
    });
    expect(auditMock).toHaveBeenCalledWith(
      ctx,
      "credential.gap",
      expect.objectContaining({ meta: expect.objectContaining({ requiredCredential: "ECONOMIST" }) }),
    );
  });

  it("passes silently (no warning, no audit) when the credential is verified", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN")]);
    await expect(
      enforceReviewCredential(ctxOf({ isDemo: true }) as never, "PHYSICIAN", { action: "futurecare.physician_review" }),
    ).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

// ── Route wiring: item-scope attestation (Attestation rows) ──────────────────

const attestReq = () =>
  new Request("http://localhost/api/cases/case-1/attestation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
const ATTEST_PARAMS = { params: { caseId: "case-1" } };

describe("POST /attestation — always credential-gated", () => {
  it("(a) a vocational-credentialed user in a reviewer seat cannot physician-attest", async () => {
    findCredentials.mockResolvedValue([cred("VOCATIONAL")]);
    const res = await attestPost(attestReq(), ATTEST_PARAMS);
    expect(res.status).toBe(403);
    expect(signAttestation).not.toHaveBeenCalled();
  });

  it("(c) a QA reviewer with no credential rows cannot physician-attest", async () => {
    mockApiContext.mockResolvedValue(ctxOf({ role: "QA_REVIEWER" }));
    findCredentials.mockResolvedValue([]);
    const res = await attestPost(attestReq(), ATTEST_PARAMS);
    expect(res.status).toBe(403);
    expect(signAttestation).not.toHaveBeenCalled();
  });

  it("(e) an admin seat (permission check passes) still cannot attest without a credential", async () => {
    // requirePermission is mocked as a no-op — the seat is allowed; only the
    // personal credential boundary stands between the admin and the signature.
    mockApiContext.mockResolvedValue(ctxOf({ role: "ADMIN" }));
    findCredentials.mockResolvedValue([cred(null, "SELF_REPORTED")]);
    const res = await attestPost(attestReq(), ATTEST_PARAMS);
    expect(res.status).toBe(403);
    expect(signAttestation).not.toHaveBeenCalled();
  });

  it("(g) a verified unexpired PHYSICIAN credential signs — as the SESSION user, never a client-sent id", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN", "EXTERNALLY_VERIFIED", FUTURE)]);
    const res = await attestPost(attestReq(), ATTEST_PARAMS);
    expect(res.status).toBe(200);
    expect(signAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ physician: expect.objectContaining({ id: "user-1" }) }),
    );
  });
});

// ── Route wiring: report-level ReportApproval ────────────────────────────────

const approvalReq = (kind: "APPROVAL" | "ATTESTATION") =>
  new Request("http://localhost/api/cases/case-1/reports/export-1/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, statementText: "I attest.", confirm: true }),
  });
const APPROVAL_PARAMS = { params: { caseId: "case-1", exportId: "export-1" } };
const exportRow = () => ({
  id: "export-1",
  caseId: "case-1",
  firmId: "firm-1",
  draft: false,
  contentSha256: "abc123",
  reportType: "LIFE_CARE_PLAN",
  snapshotId: null,
});

describe("POST /reports/[exportId]/approval — ReportApproval", () => {
  beforeEach(() => {
    (prisma.reportExport.findFirst as unknown as Mock).mockResolvedValue(exportRow());
    (prisma.reportApproval.create as unknown as Mock).mockResolvedValue({ id: "appr-1" });
  });

  it("kind ATTESTATION is ALWAYS gated: no verified PHYSICIAN credential → 403, no row created", async () => {
    findCredentials.mockResolvedValue([cred("ECONOMIST"), cred("PHYSICIAN", "SELF_REPORTED")]);
    const res = await approvalPost(approvalReq("ATTESTATION"), APPROVAL_PARAMS);
    expect(res.status).toBe(403);
    expect(prisma.reportApproval.create).not.toHaveBeenCalled();
    expect(prisma.reportApproval.updateMany).not.toHaveBeenCalled();
  });

  it("kind APPROVAL blocks non-credentialed signers on enterprise firms", async () => {
    mockApiContext.mockResolvedValue(ctxOf({ features: { "authorization.enterprise": true } }));
    const res = await approvalPost(approvalReq("APPROVAL"), APPROVAL_PARAMS);
    expect(res.status).toBe(403);
    expect(prisma.reportApproval.create).not.toHaveBeenCalled();
  });

  it("a credentialed physician signs, recorded under the session user id", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN")]);
    const res = await approvalPost(approvalReq("ATTESTATION"), APPROVAL_PARAMS);
    expect(res.status).toBe(200);
    expect(prisma.reportApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reviewerId: "user-1", kind: "ATTESTATION" }),
    });
  });
});

// ── Route wiring: vocational sign-off (VERIFIED marking) ─────────────────────

const vocReq = (verification?: string) =>
  new Request("http://localhost/api/cases/case-1/vocational", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "conclusion",
      title: "Employability conclusion",
      source: "Vocational interview 2026-07-01",
      ...(verification ? { verification } : {}),
    }),
  });
const VOC_PARAMS = { params: { caseId: "case-1" } };

describe("POST /vocational — VERIFIED marking is vocational sign-off", () => {
  it("(d) a physician-credentialed reviewer cannot mark entries VERIFIED without a VOCATIONAL credential", async () => {
    findCredentials.mockResolvedValue([cred("PHYSICIAN")]);
    const res = await vocationalPost(vocReq("VERIFIED"), VOC_PARAMS);
    expect(res.status).toBe(403);
    expect(prisma.vocationalEntry.create).not.toHaveBeenCalled();
  });

  it("a verified VOCATIONAL credential may mark VERIFIED", async () => {
    findCredentials.mockResolvedValue([cred("VOCATIONAL", "ORG_VERIFIED", FUTURE)]);
    (prisma.vocationalEntry.create as unknown as Mock).mockResolvedValue({ id: "voc-1", kind: "conclusion" });
    const res = await vocationalPost(vocReq("VERIFIED"), VOC_PARAMS);
    expect(res.status).toBe(201);
    expect(prisma.vocationalEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ enteredById: "user-1", verification: "VERIFIED" }),
    });
  });

  it("UNVERIFIED intake entry needs no credential (planner workflow preserved)", async () => {
    findCredentials.mockResolvedValue([]);
    (prisma.vocationalEntry.create as unknown as Mock).mockResolvedValue({ id: "voc-2", kind: "conclusion" });
    const res = await vocationalPost(vocReq(), VOC_PARAMS);
    expect(res.status).toBe(201);
  });
});
