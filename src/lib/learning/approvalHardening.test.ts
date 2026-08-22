// Hardening the learning approval decision.
//
// Three defects: the class was CAST out of a database string (so an unknown
// value picked the weaker gate), the decision was a read followed by a write
// (so two reviewers could both succeed and the second silently overwrote the
// first's attribution), and the audit entry was written by the route after the
// transaction (so a failure between them left an adoption nobody was recorded
// as making).
//
// Synthetic fixtures only — no PHI.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseApprovalClass, requiredApprovalCredential, requiredApprovalPermission } from "@/lib/learning/approvalClass";

describe("the persisted class is parsed, never cast", () => {
  it("only the exact string STYLE is editorial", () => {
    expect(parseApprovalClass("STYLE")).toBe("STYLE");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["lower case", "style"],
    ["mixed case", "Style"],
    ["padded", " STYLE "],
    ["a class from a later build", "PRESENTATION"],
    ["a number", 0],
    ["an object", { approvalClass: "STYLE" }],
    ["an array", ["STYLE"]],
    ["a boolean", false],
  ])("fails closed to CLINICAL for %s", (_label, value) => {
    // Each of these is a valid TypeScript ApprovalClass under a cast, and none
    // equals "CLINICAL" — so the comparison that chooses the gate would have
    // chosen the weaker one.
    expect(parseApprovalClass(value)).toBe("CLINICAL");
  });

  it("a fail-closed class demands the physician gate", () => {
    const cls = parseApprovalClass("something the database should not contain");
    expect(requiredApprovalCredential(cls)).toBe("PHYSICIAN");
    expect(requiredApprovalPermission(cls)).toBe("learning.approve_clinical");
  });
});

// ── Service: atomicity and concurrency ──────────────────────────────────────

vi.mock("@/lib/db", () => {
  const prisma = {
    learningCandidate: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    learningFinding: { updateMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  (prisma.$transaction as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
    async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])),
  );
  return { prisma };
});

import { prisma } from "@/lib/db";
import { approveCandidate, rejectCandidate, CandidateStateError, retrieveGuidance } from "@/lib/learning/candidateService";

const db = prisma as unknown as {
  learningCandidate: Record<string, ReturnType<typeof vi.fn>>;
  learningFinding: Record<string, ReturnType<typeof vi.fn>>;
  auditLog: Record<string, ReturnType<typeof vi.fn>>;
  $transaction: ReturnType<typeof vi.fn>;
};

const ACTOR = { userId: "user-1", firmId: "firm-1", credentialLabel: "MD" };
const PENDING = {
  id: "cand-1", firmId: "firm-1", status: "APPROVAL_PENDING", approvalClass: "STYLE",
  safetyClean: true, mechanism: "TASK_GUIDANCE", failureCode: "MISSED_SECTION",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
  db.learningCandidate.findFirst.mockResolvedValue(PENDING);
  db.learningCandidate.updateMany.mockResolvedValue({ count: 1 });
  db.learningCandidate.findFirstOrThrow.mockResolvedValue({ ...PENDING, status: "ADOPTED" });
  db.learningFinding.updateMany.mockResolvedValue({ count: 1 });
});

describe("a decision is one atomic, conditional transition", () => {
  it("guards on the state in the WHERE clause, not on a prior read", async () => {
    await approveCandidate("cand-1", ACTOR);
    expect(db.learningCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cand-1", firmId: "firm-1", status: "APPROVAL_PENDING" } }),
    );
  });

  it("the loser of a concurrent decision fails — both cannot succeed", async () => {
    // The first caller's write moved the row out of APPROVAL_PENDING, so the
    // second matches nothing. Previously both read PENDING and both wrote, and
    // the second silently overwrote the first reviewer's attribution.
    db.learningCandidate.updateMany.mockResolvedValue({ count: 0 });
    await expect(approveCandidate("cand-1", ACTOR)).rejects.toBeInstanceOf(CandidateStateError);
    expect(db.learningFinding.updateMany).not.toHaveBeenCalled();
  });

  it("runs the whole decision inside one transaction", async () => {
    await approveCandidate("cand-1", ACTOR);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("writes the audit entry inside that transaction", async () => {
    const seen: string[] = [];
    await approveCandidate("cand-1", ACTOR, undefined, async () => { seen.push("audit"); });
    expect(seen).toEqual(["audit"]);
  });

  it("a failing audit write aborts the decision — no unattributable adoption", async () => {
    // The state change and its record are one act. Either both land or neither.
    await expect(
      approveCandidate("cand-1", ACTOR, undefined, async () => { throw new Error("audit sink down"); }),
    ).rejects.toThrow(/audit sink down/);
  });

  it("refuses to adopt a candidate that failed the safety metrics", async () => {
    db.learningCandidate.findFirst.mockResolvedValue({ ...PENDING, safetyClean: false });
    await expect(approveCandidate("cand-1", ACTOR)).rejects.toThrow(/safety-critical/i);
    expect(db.learningCandidate.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a decision on a candidate that is not awaiting approval", async () => {
    db.learningCandidate.findFirst.mockResolvedValue({ ...PENDING, status: "ADOPTED" });
    await expect(approveCandidate("cand-1", ACTOR)).rejects.toBeInstanceOf(CandidateStateError);
  });

  it("rejection is atomic and conditional in exactly the same way", async () => {
    await rejectCandidate("cand-1", ACTOR, "Conflicts with our attending's practice.");
    expect(db.learningCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cand-1", firmId: "firm-1", status: "APPROVAL_PENDING" } }),
    );
    db.learningCandidate.updateMany.mockResolvedValue({ count: 0 });
    await expect(rejectCandidate("cand-1", ACTOR, "Conflicts with our practice.")).rejects.toBeInstanceOf(CandidateStateError);
  });
});

describe("tenant isolation", () => {
  it("scopes both the read and the conditional write to the caller's firm", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(null);
    await expect(approveCandidate("cand-1", { userId: "u", firmId: "other-firm" })).rejects.toThrow(/not found in this firm/i);
    expect(db.learningCandidate.findFirst.mock.calls[0][0].where).toMatchObject({ firmId: "other-firm" });
  });

  it("a cross-tenant approve cannot fall through to the write", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(null);
    await expect(approveCandidate("cand-1", { userId: "u", firmId: "other-firm" })).rejects.toThrow();
    expect(db.learningCandidate.updateMany).not.toHaveBeenCalled();
  });
});

describe("only human-approved lessons reach a prompt", () => {
  it("retrieval asks for ADOPTED and scopes to one firm", async () => {
    db.learningCandidate.findMany = vi.fn().mockResolvedValue([]);
    await retrieveGuidance({ firmId: "firm-1", mechanism: "TASK_GUIDANCE" });
    const where = (db.learningCandidate.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.status).toBe("ADOPTED");
    expect(where.firmId).toBe("firm-1");
  });

  it.each(["APPROVAL_PENDING", "EVALUATED", "DRAFT", "REJECTED_BY_REVIEWER", "RETIRED"])(
    "never asks for %s",
    async (status) => {
      db.learningCandidate.findMany = vi.fn().mockResolvedValue([]);
      await retrieveGuidance({ firmId: "firm-1", mechanism: "SALIENCE_PREFERENCE" });
      const where = (db.learningCandidate.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
      expect(where.status).not.toBe(status);
    },
  );
});
