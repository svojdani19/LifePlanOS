import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Learning approval routes — who may adopt what.
//
// Under test: the route picks its authorization from the candidate's OWN
// recorded class, so the caller cannot choose their own gate; a CLINICAL lesson
// passes through the same verified-credential boundary as attestation; and
// rejection is gated identically to approval, so a firm's learning cannot be
// shaped by subtraction.
//
// Prisma, the tenant guard and the credential gate are mocked at the module
// boundary — the same pattern as physicianReviewRoutes.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/tenant", () => {
  // handleError narrows on TenantError, so the mock must export the real class
  // shape or the error path throws instead of returning a 403.
  class TenantError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) {
      super(message);
    }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    requireCanonicalPermission: vi.fn(),
    audit: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: { learningCandidate: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/authz/credentialGate", () => ({
  enforceReviewCredential: vi.fn(async () => {}),
  verifiedCredentialLabel: vi.fn(async () => "MD, verified"),
}));
vi.mock("@/lib/learning/candidateService", () => {
  class CandidateStateError extends Error {}
  return {
    CandidateStateError,
    approveCandidate: vi.fn(async () => ({ id: "cand-1", status: "ADOPTED" })),
    rejectCandidate: vi.fn(async () => ({ id: "cand-1", status: "REJECTED_BY_REVIEWER" })),
  };
});

import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission } from "@/lib/tenant";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import { approveCandidate, rejectCandidate } from "@/lib/learning/candidateService";
import { POST as approve } from "@/app/api/learning/candidates/[candidateId]/approve/route";
import { POST as reject } from "@/app/api/learning/candidates/[candidateId]/reject/route";

const findFirst = (prisma as unknown as { learningCandidate: { findFirst: Mock } }).learningCandidate.findFirst;
const ctx = { firm: { id: "firm-1" }, user: { id: "user-1" } };
const params = { params: Promise.resolve({ candidateId: "cand-1" }) };
const req = (body: unknown = {}) => new Request("http://t/x", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiContext as Mock).mockResolvedValue(ctx);
  (enforceReviewCredential as Mock).mockResolvedValue(undefined);
});

const row = (approvalClass: string) => ({
  id: "cand-1", approvalClass, mechanism: "TASK_GUIDANCE", failureCode: "MISSED_SECTION", status: "APPROVAL_PENDING",
});

describe("the gate follows the candidate, not the caller", () => {
  it("an editorial lesson is refused on the tenant surface entirely", async () => {
    // learning.approve is platformOnly and authorize() denies those at step 1
    // for every firm user, so requiring it here could only ever produce a 403
    // that reads like a misconfiguration. The route says what is true and
    // points at the surface that can act.
    findFirst.mockResolvedValue(row("STYLE"));
    const res = await approve(req(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STYLE_NOT_TENANT_DECIDABLE" });
    expect(enforceReviewCredential).not.toHaveBeenCalled();
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it("a clinical lesson needs learning.approve_clinical AND a verified physician credential", async () => {
    findFirst.mockResolvedValue(row("CLINICAL"));
    const res = await approve(req(), params);
    expect(res.status).toBe(200);
    expect(requireCanonicalPermission).toHaveBeenCalledWith(ctx, "learning.approve_clinical");
    expect(enforceReviewCredential).toHaveBeenCalledWith(ctx, "PHYSICIAN", expect.objectContaining({ action: "learning.approve_clinical" }));
  });

  it("the request body cannot choose the class", async () => {
    // Otherwise an administrator declares a clinical lesson editorial and
    // approves it themselves.
    findFirst.mockResolvedValue(row("CLINICAL"));
    await approve(req({ approvalClass: "STYLE", class: "STYLE" }), params);
    expect(requireCanonicalPermission).toHaveBeenCalledWith(ctx, "learning.approve_clinical");
    expect(enforceReviewCredential).toHaveBeenCalled();
  });

  it("an unrecognised or missing class is treated as CLINICAL", async () => {
    // Falling back to the weaker gate on unfamiliar data would make every
    // future schema change a potential privilege escalation.
    findFirst.mockResolvedValue({ ...row("STYLE"), approvalClass: null });
    await approve(req(), params);
    expect(requireCanonicalPermission).toHaveBeenCalledWith(ctx, "learning.approve_clinical");
  });

  it("refuses when the credential gate throws, and never reaches the service", async () => {
    findFirst.mockResolvedValue(row("CLINICAL"));
    (enforceReviewCredential as Mock).mockRejectedValue(new Error("no credential"));
    const res = await approve(req(), params);
    expect(res.ok).toBe(false);
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it("404s a candidate outside the caller's firm without checking anything else", async () => {
    findFirst.mockResolvedValue(null);
    const res = await approve(req(), params);
    expect(res.status).toBe(404);
    expect(findFirst.mock.calls[0][0].where.firmId).toBe("firm-1");
    expect(approveCandidate).not.toHaveBeenCalled();
  });
});

describe("rejection is gated exactly like approval", () => {
  it("requires the clinical gate to refuse a clinical lesson", async () => {
    // If only approval were gated, an administrator could shape the firm's
    // learning by rejecting every clinical lesson a physician would adopt.
    findFirst.mockResolvedValue(row("CLINICAL"));
    const res = await reject(req({ reason: "Disagrees with our practice." }), params);
    expect(res.status).toBe(200);
    expect(requireCanonicalPermission).toHaveBeenCalledWith(ctx, "learning.approve_clinical");
    expect(enforceReviewCredential).toHaveBeenCalledWith(ctx, "PHYSICIAN", expect.objectContaining({ action: "learning.reject_clinical" }));
  });

  it("refuses a rejection with no reason", async () => {
    // A CLINICAL row: STYLE is refused earlier now, so the reason check would
    // never be reached with one.
    findFirst.mockResolvedValue(row("CLINICAL"));
    const res = await reject(req({ reason: "  " }), params);
    expect(res.status).toBe(422);
    expect(rejectCandidate).not.toHaveBeenCalled();
  });
});


describe("a malformed persisted class falls to the physician gate", () => {
  it.each([
    ["an empty string", ""],
    ["lower case", "style"],
    ["a class from a later build", "PRESENTATION"],
    ["a number", 7],
  ])("%s is treated as CLINICAL", async (_label, value) => {
    findFirst.mockResolvedValue({ ...row("STYLE"), approvalClass: value });
    await approve(req(), params);
    expect(requireCanonicalPermission).toHaveBeenCalledWith(ctx, "learning.approve_clinical");
    expect(enforceReviewCredential).toHaveBeenCalledWith(ctx, "PHYSICIAN", expect.anything());
  });
});

describe("the credential gate is not optional", () => {
  it("a physician seat WITHOUT a verified credential is refused", async () => {
    // Holding the seat is not holding the credential. The gate fails closed and
    // the decision never reaches the service.
    findFirst.mockResolvedValue(row("CLINICAL"));
    (enforceReviewCredential as Mock).mockRejectedValue(new Error("A verified PHYSICIAN credential is required"));
    const res = await approve(req(), params);
    expect(res.ok).toBe(false);
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it("the same is true for refusing a clinical lesson", async () => {
    findFirst.mockResolvedValue(row("CLINICAL"));
    (enforceReviewCredential as Mock).mockRejectedValue(new Error("A verified PHYSICIAN credential is required"));
    const res = await reject(req({ reason: "Not consistent with our practice." }), params);
    expect(res.ok).toBe(false);
    expect(rejectCandidate).not.toHaveBeenCalled();
  });

  it("passes the credential label through for attribution", async () => {
    findFirst.mockResolvedValue(row("CLINICAL"));
    await approve(req(), params);
    expect(approveCandidate).toHaveBeenCalledWith(
      "cand-1",
      expect.objectContaining({ credentialLabel: "MD, verified" }),
      undefined,
      expect.any(Function),
    );
  });
});

describe("a lost concurrent decision surfaces as a conflict", () => {
  it("409s rather than reporting a success it did not achieve", async () => {
    const { CandidateStateError } = await import("@/lib/learning/candidateService");
    findFirst.mockResolvedValue(row("CLINICAL"));
    (approveCandidate as Mock).mockRejectedValue(new CandidateStateError("decided by someone else"));
    const res = await approve(req(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CANDIDATE_STATE" });
  });
});
