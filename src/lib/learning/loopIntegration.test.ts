// Closing the loop: detection from real detectors, bounded repair, and the
// metrics that say whether any of it worked.
//
// The properties defended here are the ones that separate a controlled loop
// from a system that quietly teaches itself something wrong: a self-confirming
// check may validate itself, a model asked to find fault may not, a repair
// never overwrites a human, and a recurrence is counted as a recurrence.
//
// Synthetic fixtures only — no PHI.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    learningFinding: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    learningCandidate: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  codeFromWarning,
  detectFromReviewerCorrection,
  detectFromWarnings,
  detectLedgerMisses,
  detectPossibleDuplicates,
} from "@/lib/learning/detectors";
import { attemptRepair, auditIsQualified, isProtected, PROTECTED_REVIEW_STATES } from "@/lib/learning/repairService";
import { computeLearningMetrics, isRepeatFailure } from "@/lib/learning/learningMetrics";
import type { SectionVerdict } from "@/lib/records/sectionLedger";

const db = prisma as unknown as {
  learningFinding: Record<string, ReturnType<typeof vi.fn>>;
  learningCandidate: Record<string, ReturnType<typeof vi.fn>>;
};

const FIRM = "firm-a";
const ctx = { firmId: FIRM, caseId: "case-1", documentId: "doc-1", documentClass: "THERAPY_COURSE" };

const section = (over: Partial<SectionVerdict> = {}): SectionVerdict => ({
  key: "exam",
  concept: "findings",
  label: "Exam",
  state: "RECOVERABLE_MISS",
  satisfiedBy: [],
  headingText: "ROS",
  discovered: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.learningFinding.create.mockImplementation(async ({ data }: never) => ({ id: "find-1", ...(data as object) }));
  db.learningFinding.findFirst.mockResolvedValue({
    id: "find-1", firmId: FIRM, failureCode: "MISSED_SECTION", state: "DETECTED", repairAttempts: 0, documentClass: "THERAPY_COURSE",
  });
  db.learningFinding.update.mockImplementation(async ({ data }: never) => ({ id: "find-1", ...(data as object) }));
  db.learningFinding.count.mockResolvedValue(0);
  db.learningFinding.findMany.mockResolvedValue([]);
  db.learningCandidate.findMany.mockResolvedValue([]);
});

describe("a self-confirming check may validate itself", () => {
  it("records a ledger miss as already validated", async () => {
    // "This page prints an Assessment heading and we captured nothing from it"
    // is not an opinion — the source has already disagreed with the output.
    await detectLedgerMisses(ctx, [section()]);
    expect(db.learningFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "VALIDATED", validatorKind: "DETERMINISTIC", validatorResult: "CONFIRMED" }),
      }),
    );
  });

  it("records the section it concerns, so a lesson can be class-specific", async () => {
    await detectLedgerMisses(ctx, [section({ key: "assessment" })]);
    expect(db.learningFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sectionType: "assessment", documentClass: "THERAPY_COURSE", detectionSource: "SECTION_LEDGER" }),
      }),
    );
  });

  it("ignores a section the record simply does not document", async () => {
    // An emergency note has no operative findings. Manufacturing a failure out
    // of that would drown the real ones.
    const created = await detectLedgerMisses(ctx, [section({ state: "ABSENT_FROM_SOURCE" }), section({ state: "PRESENT" })]);
    expect(created).toHaveLength(0);
    expect(db.learningFinding.create).not.toHaveBeenCalled();
  });
});

describe("a model asked to find fault may not validate itself", () => {
  it("records a critic warning as an unconfirmed allegation", async () => {
    await detectFromWarnings(ctx, ["laterality inconsistent with the cited excerpt"]);
    expect(db.learningFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "DETECTED", detectionSource: "CRITIC" }) }),
    );
    // Nothing validated it.
    expect(db.learningFinding.update).not.toHaveBeenCalled();
  });

  it("maps warnings onto the failure they describe", () => {
    expect(codeFromWarning("laterality inconsistent with the cited excerpt")).toBe("WRONG_LATERALITY");
    expect(codeFromWarning("claim dropped (value not supported by its excerpt)")).toBe("UNSUPPORTED_CLAIM");
    expect(codeFromWarning("no supportable encounter date was found")).toBe("WRONG_DATE");
    expect(codeFromWarning("recommended care described as delivered")).toBe("PLANNED_AS_PERFORMED");
  });

  it("drops a warning it cannot classify rather than filing it as OTHER", async () => {
    // A finding with the wrong code pollutes the repeat-failure rate for a
    // code that did not actually recur.
    expect(codeFromWarning("something the vocabulary does not describe")).toBeNull();
    const created = await detectFromWarnings(ctx, ["something the vocabulary does not describe"]);
    expect(created).toHaveLength(0);
  });
});

describe("uncertainty is recorded rather than resolved", () => {
  it("files a possible duplicate as a finding", async () => {
    await detectPossibleDuplicates(ctx, ["row-7"]);
    expect(db.learningFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failureCode: "MISSED_DUPLICATE" }) }),
    );
  });

  it("files nothing when the merger was sure", async () => {
    expect(await detectPossibleDuplicates(ctx, [])).toHaveLength(0);
  });
});

describe("a reviewer's correction arrives already true", () => {
  it("validates on the reviewer's authority", async () => {
    await detectFromReviewerCorrection(ctx, {
      category: "DATE_CORRECTED", reviewerId: "u1", reviewerRole: "PLANNER",
      correctionDelta: [{ field: "encounterDate", changeType: "REPLACED" }],
    });
    expect(db.learningFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "VALIDATED", validatorKind: "HUMAN_REVIEWER", reviewerId: "u1" }),
      }),
    );
  });

  it("prefers a failure code the caller knows over the category mapping", async () => {
    await detectFromReviewerCorrection(ctx, {
      category: "WRONG_FIELD", failureCode: "WRONG_LATERALITY", reviewerId: "u1", reviewerRole: "PLANNER",
    });
    expect(db.learningFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failureCode: "WRONG_LATERALITY" }) }),
    );
  });

  it("records only structural deltas, never values", async () => {
    await detectFromReviewerCorrection(ctx, {
      category: "SUMMARY_REWORDED", reviewerId: "u1", reviewerRole: "PLANNER",
      correctionDelta: [{ field: "summary", changeType: "REWORDED" }], changedMeaning: false,
    });
    const delta = db.learningFinding.update.mock.calls[0][0].data.correctionDelta;
    expect(delta).toEqual([{ field: "summary", changeType: "REWORDED" }]);
    expect(JSON.stringify(delta)).not.toMatch(/patient|\d{2}\/\d{2}\/\d{4}/);
  });
});

describe("repair never overwrites a human", () => {
  it("refuses to touch content a reviewer edited, verified or approved", async () => {
    for (const status of PROTECTED_REVIEW_STATES) {
      const retry = vi.fn(async () => true);
      const outcome = await attemptRepair({ firmId: FIRM, findingId: "find-1", retry, reviewStatus: status });
      expect(outcome).toEqual({ attempted: false, reason: "PROTECTED_CONTENT" });
      expect(retry).not.toHaveBeenCalled();
    }
  });

  it("treats an AI draft as repairable", async () => {
    expect(isProtected("AI_DRAFT")).toBe(false);
    expect(isProtected(null)).toBe(false);
  });
});

describe("repair is narrow, bounded and honest", () => {
  it("re-asks and marks the defect repaired when it is gone", async () => {
    db.learningFinding.findFirst.mockResolvedValue({
      id: "find-1", firmId: FIRM, failureCode: "MISSED_SECTION", state: "VALIDATED", repairAttempts: 0,
    });
    const retry = vi.fn(async () => true);
    const outcome = await attemptRepair({ firmId: FIRM, findingId: "find-1", retry, reviewStatus: "AI_DRAFT" });
    expect(outcome).toEqual({ attempted: true, succeeded: true });
    expect(retry).toHaveBeenCalledOnce();
    expect(db.learningFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "REPAIRED" }) }),
    );
  });

  it("does not retry a defect no retry can fix", async () => {
    db.learningFinding.findFirst.mockResolvedValue({
      id: "find-1", firmId: FIRM, failureCode: "IRRELEVANT_SUMMARY", state: "VALIDATED", repairAttempts: 0,
    });
    const retry = vi.fn(async () => true);
    const outcome = await attemptRepair({ firmId: FIRM, findingId: "find-1", retry });
    expect(outcome).toEqual({ attempted: false, reason: "NOT_RECOVERABLE" });
    expect(retry).not.toHaveBeenCalled();
  });

  it("stops after its bounded attempts rather than looping", async () => {
    db.learningFinding.findFirst.mockResolvedValue({
      id: "find-1", firmId: FIRM, failureCode: "MISSED_SECTION", state: "UNRESOLVED", repairAttempts: 2,
    });
    const retry = vi.fn(async () => true);
    expect(await attemptRepair({ firmId: FIRM, findingId: "find-1", retry })).toEqual({
      attempted: false, reason: "ATTEMPTS_EXHAUSTED",
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it("treats a thrown retry as a failed repair, not a crash", async () => {
    db.learningFinding.findFirst.mockResolvedValue({
      id: "find-1", firmId: FIRM, failureCode: "MISSED_SECTION", state: "VALIDATED", repairAttempts: 0,
    });
    const outcome = await attemptRepair({
      firmId: FIRM, findingId: "find-1", retry: async () => { throw new Error("provider down"); },
    });
    expect(outcome).toEqual({ attempted: true, succeeded: false });
  });
});

describe("an unresolved defect blocks an unqualified pass", () => {
  it("is not qualified while a confirmed defect is open", async () => {
    db.learningFinding.count.mockResolvedValue(2);
    expect(await auditIsQualified(FIRM, "case-1")).toEqual({ qualified: false, blocking: 2 });
  });

  it("is qualified when nothing is open", async () => {
    db.learningFinding.count.mockResolvedValue(0);
    expect(await auditIsQualified(FIRM, "case-1")).toEqual({ qualified: true, blocking: 0 });
  });
});

describe("metrics distinguish a new failure from a recurring one", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, n));

  it("counts the second occurrence of a code in a class as a repeat", async () => {
    db.learningFinding.findMany.mockResolvedValue([
      { failureCode: "MISSED_SECTION", documentClass: "THERAPY_COURSE", state: "REPAIRED", validatorKind: "DETERMINISTIC", validatorResult: "CONFIRMED", repairAttempts: 1, correctionDelta: [], createdAt: at(1) },
      { failureCode: "MISSED_SECTION", documentClass: "THERAPY_COURSE", state: "VALIDATED", validatorKind: "DETERMINISTIC", validatorResult: "CONFIRMED", repairAttempts: 0, correctionDelta: [], createdAt: at(2) },
      { failureCode: "WRONG_DATE", documentClass: "OPERATIVE", state: "VALIDATED", validatorKind: "DETERMINISTIC", validatorResult: "CONFIRMED", repairAttempts: 0, correctionDelta: [], createdAt: at(3) },
    ]);
    const m = await computeLearningMetrics({ firmId: FIRM });
    expect(m.totalFindings).toBe(3);
    expect(m.repeatFailureRate).toBeCloseTo(1 / 3, 2);
    expect(m.repeatByCode.MISSED_SECTION).toBe(1);
    expect(m.repeatByCode.WRONG_DATE).toBe(0);
  });

  it("measures how often the critic cries wolf", async () => {
    db.learningFinding.findMany.mockResolvedValue([
      { failureCode: "WRONG_LATERALITY", documentClass: "A", state: "REJECTED_FALSE_POSITIVE", validatorKind: "DETERMINISTIC", validatorResult: "REJECTED", repairAttempts: 0, correctionDelta: [], createdAt: at(1) },
      { failureCode: "WRONG_LATERALITY", documentClass: "B", state: "REPAIRED", validatorKind: "DETERMINISTIC", validatorResult: "CONFIRMED", repairAttempts: 1, correctionDelta: [], createdAt: at(2) },
    ]);
    const m = await computeLearningMetrics({ firmId: FIRM });
    expect(m.falsePositiveCriticRate).toBe(0.5);
  });

  it("counts adoption, rollback and how often lessons were applied", async () => {
    db.learningCandidate.findMany.mockResolvedValue([
      { status: "ADOPTED", applicationCount: 12 },
      { status: "REJECTED_NO_IMPROVEMENT", applicationCount: 0 },
      { status: "RETIRED", applicationCount: 5 },
    ]);
    const m = await computeLearningMetrics({ firmId: FIRM });
    expect(m.candidateAdoptionRate).toBeCloseTo(1 / 3, 2);
    expect(m.candidateRollbackRate).toBe(0.5);
    expect(m.learningRuleApplications).toBe(17);
  });

  it("is firm-scoped", async () => {
    await expect(computeLearningMetrics({ firmId: "" })).rejects.toThrow(/firm-scoped/i);
    await computeLearningMetrics({ firmId: FIRM });
    expect(db.learningFinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ firmId: FIRM }) }),
    );
  });

  it("contains no patient detail", async () => {
    db.learningFinding.findMany.mockResolvedValue([
      { failureCode: "MISSED_SECTION", documentClass: "THERAPY_COURSE", state: "REPAIRED", validatorKind: "HUMAN_REVIEWER", validatorResult: "CONFIRMED", repairAttempts: 1, correctionDelta: [{ field: "exam", changeType: "ADDED" }], createdAt: at(1) },
    ]);
    const m = await computeLearningMetrics({ firmId: FIRM });
    const serialized = JSON.stringify(m);
    expect(serialized).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(serialized).not.toMatch(/patient|dob|mrn/i);
  });

  it("asks whether a defect has been confirmed before", async () => {
    db.learningFinding.count.mockResolvedValue(1);
    expect(await isRepeatFailure(FIRM, "MISSED_SECTION", "THERAPY_COURSE")).toBe(true);
    db.learningFinding.count.mockResolvedValue(0);
    expect(await isRepeatFailure(FIRM, "MISSED_SECTION", "OPERATIVE")).toBe(false);
  });
});
