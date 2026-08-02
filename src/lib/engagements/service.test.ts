import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// All DB access is mocked — these tests never touch a database.
vi.mock("@/lib/db", () => ({
  prisma: {
    caseEngagement: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    case: { findFirst: vi.fn() },
    document: { count: vi.fn() },
    user: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TRANSITIONS,
  EngagementError,
  advanceStatus,
  assignExperts,
  authorizeEngagement,
  cancelEngagement,
  createEngagement,
  feeFor,
  MAX_FEE,
  type EngagementStatus,
} from "./service";

const engCreate = prisma.caseEngagement.create as unknown as Mock;
const engFindFirst = prisma.caseEngagement.findFirst as unknown as Mock;
const engUpdate = prisma.caseEngagement.update as unknown as Mock;
const caseFindFirst = prisma.case.findFirst as unknown as Mock;
const docCount = prisma.document.count as unknown as Mock;
const userFindMany = prisma.user.findMany as unknown as Mock;
const auditCreate = prisma.auditLog.create as unknown as Mock;
const notifCreate = prisma.notification.create as unknown as Mock;

const actor = { firmId: "firm-1", userId: "user-admin" };

const baseEngagement = {
  id: "eng-1",
  firmId: "firm-1",
  caseId: "case-1",
  requestedById: "user-req",
  authorizedById: null,
  reportType: "LIFE_CARE_PLAN",
  status: "AWAITING_AUTHORIZATION",
  feeEstimate: 5000,
  feeStructure: "FIXED",
  estimatedCompletionDate: null,
  authorizedAt: null,
  assignedPlannerId: null,
  assignedPhysicianId: null,
  assignedVocationalExpertId: null,
  assignedEconomistId: null,
  assignedQaReviewerId: null,
  missingRequirements: null,
  cancellationStatus: null,
  completedAt: null,
  cancelledAt: null,
};

const FEATURES = {
  pricing: {
    LIFE_CARE_PLAN: { fixed: 7500, rush: 2000, turnaroundDays: 30 },
    MEDICAL_CHRONOLOGY: { hourly: 250 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  caseFindFirst.mockResolvedValue({ id: "case-1", caseNumber: "LCP-2026-0001" });
  engCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "eng-1", ...data }));
  engUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...baseEngagement, ...data }));
  auditCreate.mockResolvedValue({});
  notifCreate.mockResolvedValue({});
  userFindMany.mockResolvedValue([]);
  docCount.mockResolvedValue(3);
});

// ── feeFor — pricing config resolution ───────────────────────────────────────

describe("feeFor", () => {
  it("resolves the entry for a configured report type from firm features", () => {
    expect(feeFor(FEATURES, "LIFE_CARE_PLAN")).toEqual({ fixed: 7500, hourly: undefined, rush: 2000, turnaroundDays: 30 });
  });

  it("returns null when the report type is absent from the pricing config", () => {
    expect(feeFor(FEATURES, "DAMAGES_SUMMARY")).toBeNull();
  });

  it("returns null for malformed features (null, array, non-object pricing, negative values only)", () => {
    expect(feeFor(null, "LIFE_CARE_PLAN")).toBeNull();
    expect(feeFor([], "LIFE_CARE_PLAN")).toBeNull();
    expect(feeFor({ pricing: "cheap" }, "LIFE_CARE_PLAN")).toBeNull();
    expect(feeFor({ pricing: { LIFE_CARE_PLAN: { fixed: -5 } } }, "LIFE_CARE_PLAN")).toBeNull();
  });

  it("treats NaN, Infinity, and beyond-cap values as absent", () => {
    expect(feeFor({ pricing: { X: { fixed: NaN } } }, "X")).toBeNull();
    expect(feeFor({ pricing: { X: { hourly: Infinity } } }, "X")).toBeNull();
    expect(feeFor({ pricing: { X: { fixed: MAX_FEE + 1 } } }, "X")).toBeNull();
    expect(feeFor({ pricing: { X: { fixed: MAX_FEE } } }, "X")).toEqual({
      fixed: MAX_FEE,
      hourly: undefined,
      rush: undefined,
      turnaroundDays: undefined,
    });
  });
});

// ── createEngagement ─────────────────────────────────────────────────────────

describe("createEngagement", () => {
  it("derives fee estimate, structure, and ECD from the firm pricing config", async () => {
    const eng = await createEngagement(actor, {
      caseId: "case-1",
      reportType: "LIFE_CARE_PLAN",
      requestedById: "user-req",
      firmFeatures: FEATURES,
    });
    expect(eng.feeEstimate).toBe(7500);
    expect(eng.feeStructure).toBe("FIXED");
    expect(eng.estimatedCompletionDate).toBeInstanceOf(Date);
    expect(engCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "engagement.create" }) }));
  });

  it("uses an explicit fee estimate over the config, and null fee when neither exists", async () => {
    const explicit = await createEngagement(actor, {
      caseId: "case-1",
      reportType: "LIFE_CARE_PLAN",
      requestedById: "user-req",
      feeEstimate: 1234,
      firmFeatures: FEATURES,
    });
    expect(explicit.feeEstimate).toBe(1234);

    const bare = await createEngagement(actor, { caseId: "case-1", reportType: "CUSTOM", requestedById: "user-req" });
    expect(bare.feeEstimate).toBeNull();
    expect(bare.feeStructure).toBeNull();
  });

  it("defaults to AWAITING_AUTHORIZATION, honors RECOMMENDED, and refuses a case outside the firm", async () => {
    const def = await createEngagement(actor, { caseId: "case-1", reportType: "CUSTOM", requestedById: "user-req" });
    expect(def.status).toBe("AWAITING_AUTHORIZATION");
    const rec = await createEngagement(actor, { caseId: "case-1", reportType: "CUSTOM", requestedById: "user-req", status: "RECOMMENDED" });
    expect(rec.status).toBe("RECOMMENDED");

    caseFindFirst.mockResolvedValueOnce(null);
    await expect(createEngagement(actor, { caseId: "case-x", reportType: "CUSTOM", requestedById: "user-req" })).rejects.toThrow(
      EngagementError,
    );
  });

  it("rejects negative, NaN, Infinity, and beyond-cap explicit fee estimates before any DB write", async () => {
    for (const bad of [-1, NaN, Infinity, -Infinity, MAX_FEE + 1]) {
      await expect(
        createEngagement(actor, { caseId: "case-1", reportType: "CUSTOM", requestedById: "user-req", feeEstimate: bad }),
      ).rejects.toThrow(EngagementError);
    }
    expect(engCreate).not.toHaveBeenCalled();

    // The boundary itself is accepted.
    const eng = await createEngagement(actor, {
      caseId: "case-1",
      reportType: "CUSTOM",
      requestedById: "user-req",
      feeEstimate: MAX_FEE,
    });
    expect(eng.feeEstimate).toBe(MAX_FEE);
  });
});

// ── authorizeEngagement ──────────────────────────────────────────────────────

describe("authorizeEngagement", () => {
  it("sets AUTHORIZED with authorizer + timestamp and empty missingRequirements when records exist", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement });
    docCount.mockResolvedValue(4);
    const eng = await authorizeEngagement(actor, "eng-1");
    expect(eng.status).toBe("AUTHORIZED");
    expect(eng.authorizedById).toBe("user-admin");
    expect(eng.authorizedAt).toBeInstanceOf(Date);
    expect(engUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "AUTHORIZED", missingRequirements: [] }) }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "engagement.authorize" }) }),
    );
  });

  it("lands in RECORDS_PENDING with MEDICAL_RECORDS missing when the case has zero records", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement });
    docCount.mockResolvedValue(0);
    const eng = await authorizeEngagement(actor, "eng-1");
    expect(eng.status).toBe("RECORDS_PENDING");
    expect(eng.missingRequirements).toEqual(["MEDICAL_RECORDS"]);
  });

  it("notifies the requester on authorization", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement });
    await authorizeEngagement(actor, "eng-1");
    expect(notifCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-req", kind: "engagement.authorized", caseId: "case-1" }),
      }),
    );
    // PHI discipline: title carries the case number, never a client name.
    const title = notifCreate.mock.calls[0][0].data.title as string;
    expect(title).toContain("LCP-2026-0001");
  });

  it("refuses to authorize from a non-authorizable state and when the engagement is missing", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "IN_PROGRESS" });
    await expect(authorizeEngagement(actor, "eng-1")).rejects.toThrow(/Invalid engagement transition/);
    engFindFirst.mockResolvedValue(null);
    await expect(authorizeEngagement(actor, "eng-1")).rejects.toThrow("Engagement not found");
  });
});

// ── assignExperts ────────────────────────────────────────────────────────────

describe("assignExperts", () => {
  it("assigns experts from AUTHORIZED and moves to IN_PROGRESS, notifying each new assignee", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "AUTHORIZED" });
    userFindMany.mockResolvedValue([{ id: "planner-1" }, { id: "qa-1" }]);
    const eng = await assignExperts(actor, "eng-1", { plannerId: "planner-1", qaReviewerId: "qa-1" });
    expect(eng.status).toBe("IN_PROGRESS");
    expect(eng.assignedPlannerId).toBe("planner-1");
    expect(eng.assignedQaReviewerId).toBe("qa-1");
    const notifiedUsers = notifCreate.mock.calls.map((c) => c[0].data.userId);
    expect(notifiedUsers).toContain("planner-1");
    expect(notifiedUsers).toContain("qa-1");
    expect(notifiedUsers).toContain("user-req"); // requester learns the engagement is staffed
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "engagement.assign" }) }),
    );
  });

  it("stays in ASSIGNMENT_PENDING when every slot is cleared", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "AUTHORIZED" });
    const eng = await assignExperts(actor, "eng-1", { plannerId: null });
    expect(eng.status).toBe("ASSIGNMENT_PENDING");
  });

  it("rejects assignees who are not active members of the firm", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "AUTHORIZED" });
    userFindMany.mockResolvedValue([]); // no matching active seats
    await expect(assignExperts(actor, "eng-1", { plannerId: "outsider" })).rejects.toThrow(
      "One or more assignees are not active members of this firm.",
    );
  });

  it("refuses assignment from a pre-authorization state", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "AWAITING_AUTHORIZATION" });
    await expect(assignExperts(actor, "eng-1", { plannerId: "planner-1" })).rejects.toThrow(/Invalid engagement transition/);
  });
});

// ── advanceStatus — the transition graph ─────────────────────────────────────

describe("advanceStatus — transition graph", () => {
  it("permits every edge in ENGAGEMENT_TRANSITIONS (except the reserved authorize/cancel edges)", async () => {
    for (const from of ENGAGEMENT_STATUSES) {
      for (const to of ENGAGEMENT_TRANSITIONS[from]) {
        if (to === "CANCELLED" || to === "AUTHORIZED" || to === "RECORDS_PENDING") continue;
        vi.clearAllMocks();
        caseFindFirst.mockResolvedValue({ id: "case-1", caseNumber: "LCP-2026-0001" });
        engUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...baseEngagement, ...data }));
        engFindFirst.mockResolvedValue({ ...baseEngagement, status: from });
        const eng = await advanceStatus(actor, "eng-1", to);
        expect(eng.status).toBe(to);
      }
    }
  });

  it("refuses every off-graph transition with a message documenting the allowed moves", async () => {
    const cases: [EngagementStatus, string][] = [
      ["RECOMMENDED", "IN_PROGRESS"],
      ["AWAITING_AUTHORIZATION", "DELIVERED"],
      ["IN_PROGRESS", "COMPLETED"], // must pass through QA_REVIEW or DELIVERED
      ["COMPLETED", "IN_PROGRESS"], // terminal
      ["CANCELLED", "RECOMMENDED"], // terminal
    ];
    for (const [from, to] of cases) {
      engFindFirst.mockResolvedValue({ ...baseEngagement, status: from });
      await expect(advanceStatus(actor, "eng-1", to)).rejects.toThrow(/Invalid engagement transition/);
    }
    // The refusal names the allowed set.
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "DELIVERED" });
    await expect(advanceStatus(actor, "eng-1", "IN_PROGRESS")).rejects.toThrow(/Allowed from DELIVERED: COMPLETED, CANCELLED/);
  });

  it("rejects unknown statuses and routes CANCELLED to the cancel action", async () => {
    await expect(advanceStatus(actor, "eng-1", "SHIPPED")).rejects.toThrow("Unknown engagement status: SHIPPED");
    await expect(advanceStatus(actor, "eng-1", "CANCELLED")).rejects.toThrow("Cancellation requires a reason");
  });

  it("refuses to reach AUTHORIZED or RECORDS_PENDING via advance — authorization must stamp the authorizer", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "AWAITING_AUTHORIZATION" });
    await expect(advanceStatus(actor, "eng-1", "AUTHORIZED")).rejects.toThrow(
      "Authorization must go through the authorize action.",
    );
    await expect(advanceStatus(actor, "eng-1", "RECORDS_PENDING")).rejects.toThrow(
      "Authorization must go through the authorize action.",
    );
    expect(engUpdate).not.toHaveBeenCalled();
  });

  it("COMPLETED is reachable only from DELIVERED", async () => {
    for (const from of ENGAGEMENT_STATUSES.filter((s) => s !== "DELIVERED")) {
      expect(ENGAGEMENT_TRANSITIONS[from]).not.toContain("COMPLETED");
    }
    expect(ENGAGEMENT_TRANSITIONS.DELIVERED).toContain("COMPLETED");
  });

  it("stamps completedAt when advancing DELIVERED → COMPLETED and audits the move", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "DELIVERED" });
    const eng = await advanceStatus(actor, "eng-1", "COMPLETED");
    expect(eng.completedAt).toBeInstanceOf(Date);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "engagement.advance", meta: { from: "DELIVERED", to: "COMPLETED" } }),
      }),
    );
  });
});

// ── cancelEngagement ─────────────────────────────────────────────────────────

describe("cancelEngagement", () => {
  it("requires a non-empty reason", async () => {
    await expect(cancelEngagement(actor, "eng-1", "")).rejects.toThrow("A cancellation reason is required.");
    await expect(cancelEngagement(actor, "eng-1", "   ")).rejects.toThrow("A cancellation reason is required.");
    expect(engUpdate).not.toHaveBeenCalled();
  });

  it("cancels a live engagement, persisting the reason as cancellationStatus, and notifies the team", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "IN_PROGRESS", assignedPlannerId: "planner-1" });
    const eng = await cancelEngagement(actor, "eng-1", "Client withdrew");
    expect(eng.status).toBe("CANCELLED");
    expect(eng.cancellationStatus).toBe("Client withdrew");
    expect(eng.cancelledAt).toBeInstanceOf(Date);
    const notified = notifCreate.mock.calls.map((c) => c[0].data.userId);
    expect(notified).toContain("user-req");
    expect(notified).toContain("planner-1");
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "engagement.cancel" }) }),
    );
  });

  it("refuses to cancel a terminal engagement", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement, status: "COMPLETED" });
    await expect(cancelEngagement(actor, "eng-1", "too late")).rejects.toThrow(/Invalid engagement transition/);
  });
});

// ── Notification resilience inside engagement flows ──────────────────────────

describe("notification resilience", () => {
  it("a notification failure never breaks an authorization", async () => {
    engFindFirst.mockResolvedValue({ ...baseEngagement });
    notifCreate.mockRejectedValue(new Error("db down"));
    const eng = await authorizeEngagement(actor, "eng-1");
    expect(eng.status).toBe("AUTHORIZED");
  });
});
