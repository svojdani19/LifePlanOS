// Human approval for learned lessons.
//
// The loop could previously adopt a lesson on its own: judgeCandidate said the
// held-out metrics improved, evaluateCandidate wrote ADOPTED, and
// retrieveGuidance served that lesson into live prompts. Nobody approved
// anything, and a lesson that changes how care is recommended was adopted on
// exactly the same footing as one that changes which field leads a summary.
//
// Synthetic fixtures only — no PHI.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    learningFinding: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    learningCandidate: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  approveCandidate,
  rejectCandidate,
  evaluateCandidate,
  listCandidates,
  retrieveGuidance,
  promoteToCandidate,
  type Scorecard,
} from "@/lib/learning/candidateService";

const db = prisma as unknown as {
  learningFinding: Record<string, ReturnType<typeof vi.fn>>;
  learningCandidate: Record<string, ReturnType<typeof vi.fn>>;
};

const FIRM = "firm-1";
const ACTOR = { userId: "user-1", firmId: FIRM };

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  sourceCaseIds: ["c-1"],
  evaluatedCaseIds: ["c-9"],
  deltas: { recall: 0.1 },
  safetyDeltas: {},
  byDocumentClass: {},
  ...over,
});

const candidateRow = (over: Record<string, unknown> = {}) => ({
  id: "cand-1",
  firmId: FIRM,
  status: "APPROVAL_PENDING",
  approvalClass: "STYLE",
  safetyClean: true,
  mechanism: "TASK_GUIDANCE",
  failureCode: "MISSED_SECTION",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.learningCandidate.update.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "cand-1", ...a.data }));
  db.learningFinding.updateMany.mockResolvedValue({ count: 1 });
});

describe("a metric may not adopt a lesson", () => {
  it("a passing evaluation reaches APPROVAL_PENDING, not ADOPTED", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow({ status: "EVALUATED" }));
    const { candidate } = await evaluateCandidate("cand-1", FIRM, card());
    expect(candidate.status).toBe("APPROVAL_PENDING");
    // adoptedAt is the timestamp of a human act. A machine pass does not earn one.
    expect(candidate.adoptedAt).toBeNull();
  });

  it("a failing evaluation is still rejected outright, with no queue entry", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow({ status: "EVALUATED" }));
    const { candidate } = await evaluateCandidate("cand-1", FIRM, card({ deltas: { recall: 0 } }));
    expect(candidate.status).toBe("REJECTED_NO_IMPROVEMENT");
  });

  it("an evaluation that overlaps its own training set still cannot reach the queue", async () => {
    // The held-out gate runs before anything else and is unaffected by adding
    // an approval step after it.
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow({ status: "EVALUATED" }));
    const { candidate } = await evaluateCandidate("cand-1", FIRM, card({ evaluatedCaseIds: ["c-1"] }));
    expect(candidate.status).toBe("REJECTED_NO_IMPROVEMENT");
  });
});

describe("nothing unapproved reaches a prompt", () => {
  // This is the property the whole change rests on. If APPROVAL_PENDING rows
  // were served, the approval step would be decoration.
  it("retrieveGuidance asks only for ADOPTED", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE" });
    const where = db.learningCandidate.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("ADOPTED");
    expect(where.firmId).toBe(FIRM);
  });

  it("refuses to retrieve without a firm, so one tenant's lessons cannot leak", async () => {
    await expect(retrieveGuidance({ firmId: "", mechanism: "TASK_GUIDANCE" })).rejects.toThrow(/requires a firm/i);
  });
});

describe("approval is recorded as an act by a person", () => {
  it("adopts and records who approved, under which class", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow());
    const r = await approveCandidate("cand-1", { ...ACTOR, credentialLabel: "MD, state licence on file" });
    expect(r.status).toBe("ADOPTED");
    expect(r.approvedById).toBe("user-1");
    expect(r.approvedAt).toBeInstanceOf(Date);
    expect(r.approverCredential).toBe("MD, state licence on file");
  });

  it("refuses to adopt a candidate that has not been evaluated", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow({ status: "DRAFT" }));
    await expect(approveCandidate("cand-1", ACTOR)).rejects.toThrow(/awaiting approval/i);
  });

  it("refuses to adopt a candidate that regressed a safety metric, whoever asks", async () => {
    // Approval is a human decision about a lesson that passed; it is not an
    // override of the safety gate. A reviewer cannot approve past this.
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow({ safetyClean: false }));
    await expect(approveCandidate("cand-1", ACTOR)).rejects.toThrow(/safety-critical/i);
  });

  it("refuses to adopt across a firm boundary", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(null);
    await expect(approveCandidate("cand-1", { userId: "u", firmId: "other-firm" })).rejects.toThrow(/not found in this firm/i);
    expect(db.learningCandidate.findFirst.mock.calls[0][0].where.firmId).toBe("other-firm");
  });

  it("clears a prior rejection when a candidate is later approved", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow());
    const r = await approveCandidate("cand-1", ACTOR);
    expect(r.rejectedById).toBeNull();
    expect(r.rejectionReason).toBeNull();
  });
});

describe("a rejection is a decision, not a deletion", () => {
  it("records the reviewer and the reason and keeps the row", async () => {
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow());
    const r = await rejectCandidate("cand-1", ACTOR, "Conflicts with our attending's standing practice.");
    expect(r.status).toBe("REJECTED_BY_REVIEWER");
    expect(r.rejectedById).toBe("user-1");
    expect(r.rejectionReason).toMatch(/standing practice/);
  });

  it("insists on a reason", async () => {
    // "Rejected" with no reason is indistinguishable from a mis-click, and the
    // point of keeping the row is the record of WHY.
    await expect(rejectCandidate("cand-1", ACTOR, "   ")).rejects.toThrow(/must record a reason/i);
    expect(db.learningCandidate.findFirst).not.toHaveBeenCalled();
  });

  it("does not undo an adoption", async () => {
    // Reversal is retireCandidate, which restores what the lesson superseded.
    // Rejection is for lessons that were never adopted.
    db.learningCandidate.findFirst.mockResolvedValue(candidateRow({ status: "ADOPTED" }));
    await expect(rejectCandidate("cand-1", ACTOR, "no")).rejects.toThrow(/awaiting approval/i);
  });
});

describe("the class is set once, at promotion", () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    id: "f-1", firmId: FIRM, state: "VALIDATED", failureCode: "MISSED_SECTION",
    documentClass: "THERAPY_NOTE", sectionType: null, ...over,
  });

  beforeEach(() => {
    db.learningFinding.count.mockResolvedValue(5);
    db.learningCandidate.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "cand-1", ...a.data }));
    db.learningFinding.update.mockResolvedValue({});
  });

  it("stamps an editorial lesson STYLE", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding());
    const c = await promoteToCandidate({ findingId: "f-1", firmId: FIRM, guidance: "Capture each documented modality with its duration." });
    expect(c.approvalClass).toBe("STYLE");
  });

  it("stamps a care-plan lesson CLINICAL", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "UNSUPPORTED_FREQUENCY" }));
    const c = await promoteToCandidate({ findingId: "f-1", firmId: FIRM, guidance: "Record the cadence the note states." });
    expect(c.approvalClass).toBe("CLINICAL");
  });

  it("stamps a safety-critical lesson CLINICAL even when its mechanism is guidance", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "WRONG_LATERALITY" }));
    const c = await promoteToCandidate({ findingId: "f-1", firmId: FIRM, guidance: "Read the side from the operative heading." });
    expect(c.approvalClass).toBe("CLINICAL");
  });
});

describe("the queue is firm-scoped by construction", () => {
  it("cannot be listed without a firm", async () => {
    await expect(listCandidates("")).rejects.toThrow(/requires a firm/i);
  });

  it("scopes every query to the calling firm", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await listCandidates(FIRM, { status: "APPROVAL_PENDING", approvalClass: "CLINICAL" });
    const where = db.learningCandidate.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ firmId: FIRM, status: "APPROVAL_PENDING", approvalClass: "CLINICAL" });
  });

  it("caps the page size so a listing cannot pull the whole table", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await listCandidates(FIRM, { limit: 10_000 });
    expect(db.learningCandidate.findMany.mock.calls[0][0].take).toBe(200);
  });
});
