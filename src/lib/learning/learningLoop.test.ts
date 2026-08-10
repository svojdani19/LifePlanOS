// The loop's safety properties, held against a mocked store so the rules are
// tested rather than the database.
//
// What is being defended here: a system that learns from its own mistakes can
// teach itself something wrong and then keep applying it. Every test below is
// a way that could happen.
//
// Synthetic fixtures only — no PHI.

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the store is built inside the
// factory and read back through the mocked module afterwards.
vi.mock("@/lib/db", () => ({
  prisma: {
    learningFinding: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    learningCandidate: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  assertPhiFree,
  detectFinding,
  MAX_REPAIR_ATTEMPTS,
  recordRepairAttempt,
  repairExhausted,
  validateFinding,
} from "@/lib/learning/findingService";
import {
  judgeCandidate,
  MIN_SUPPORT_FOR_CLINICAL_PRIOR,
  MAX_RETRIEVED_GUIDANCE,
  promoteToCandidate,
  retrieveGuidance,
  sanitizeGuidance,
  type Scorecard,
} from "@/lib/learning/candidateService";

const db = prisma as unknown as {
  learningFinding: Record<string, ReturnType<typeof vi.fn>>;
  learningCandidate: Record<string, ReturnType<typeof vi.fn>>;
};

const FIRM = "firm-a";
const OTHER_FIRM = "firm-b";

const finding = (over: Record<string, unknown> = {}) => ({
  id: "find-1",
  firmId: FIRM,
  failureCode: "MISSED_SECTION",
  state: "VALIDATED",
  documentClass: "THERAPY_COURSE",
  sectionType: "exam",
  repairAttempts: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.learningFinding.update.mockImplementation(async ({ data }: never) => ({ ...finding(), ...(data as object) }));
  db.learningCandidate.create.mockImplementation(async ({ data }: never) => ({ id: "cand-1", version: 1, ...(data as object) }));
  db.learningFinding.count.mockResolvedValue(1);
});

describe("an allegation is not training truth", () => {
  it("records a detection that can influence nothing", async () => {
    db.learningFinding.create.mockResolvedValue({ id: "find-1", state: "DETECTED" });
    await detectFinding({ firmId: FIRM, failureCode: "MISSED_SECTION", detectionSource: "CRITIC" });
    expect(db.learningFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "DETECTED" }) }),
    );
  });

  it("refuses to make a lesson from an unvalidated finding", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ state: "DETECTED" }));
    await expect(promoteToCandidate({ firmId: FIRM, findingId: "find-1", guidance: "Capture the exam section." })).rejects.toThrow(
      /only a confirmed finding/i,
    );
  });

  it("refuses to make a lesson from a rejected false positive", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ state: "REJECTED_FALSE_POSITIVE" }));
    await expect(promoteToCandidate({ firmId: FIRM, findingId: "find-1", guidance: "Capture the exam section." })).rejects.toThrow();
  });

  it("records a rejection rather than deleting it, so critic noise is measurable", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ state: "DETECTED" }));
    await validateFinding({ findingId: "find-1", firmId: FIRM, validatorKind: "DETERMINISTIC", confirmed: false });
    expect(db.learningFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "REJECTED_FALSE_POSITIVE", validatorResult: "REJECTED" }) }),
    );
  });
});

describe("authority cannot be bypassed", () => {
  it("refuses a clinical confirmation from a reviewer without clinical standing", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "UNSUPPORTED_FREQUENCY", state: "DETECTED" }));
    await expect(
      validateFinding({ findingId: "find-1", firmId: FIRM, validatorKind: "HUMAN_CLINICAL", confirmed: true, reviewerRole: "PLANNER" }),
    ).rejects.toThrow(/clinical authority/i);
  });

  it("accepts it from a physician reviewer", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "UNSUPPORTED_FREQUENCY", state: "DETECTED" }));
    await expect(
      validateFinding({
        findingId: "find-1", firmId: FIRM, validatorKind: "HUMAN_CLINICAL", confirmed: true, reviewerRole: "PHYSICIAN_REVIEWER",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses to confirm a summary preference deterministically", async () => {
    // No deterministic check can decide that a true sentence was the wrong
    // one to lead with.
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "IRRELEVANT_SUMMARY", state: "DETECTED" }));
    await expect(
      validateFinding({ findingId: "find-1", firmId: FIRM, validatorKind: "DETERMINISTIC", confirmed: true }),
    ).rejects.toThrow(/needs a human judgement/i);
  });

  it("cannot resolve a finding belonging to another firm", async () => {
    db.learningFinding.findFirst.mockResolvedValue(null);
    await expect(
      validateFinding({ findingId: "find-1", firmId: OTHER_FIRM, validatorKind: "DETERMINISTIC", confirmed: true }),
    ).rejects.toThrow(/not found in this firm/i);
  });
});

describe("one correction is not a clinical truth", () => {
  it("refuses a firm-scoped prior until the firm has corrected it repeatedly", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "UNSUPPORTED_FREQUENCY" }));
    db.learningFinding.count.mockResolvedValue(1);
    await expect(
      promoteToCandidate({ firmId: FIRM, findingId: "find-1", guidance: "Therapy visit frequency runs lower for this firm." }),
    ).rejects.toThrow(new RegExp(`${MIN_SUPPORT_FOR_CLINICAL_PRIOR} consistent corrections`));
  });

  it("allows it once the corrections repeat", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "UNSUPPORTED_FREQUENCY" }));
    db.learningFinding.count.mockResolvedValue(MIN_SUPPORT_FOR_CLINICAL_PRIOR);
    await expect(
      promoteToCandidate({ firmId: FIRM, findingId: "find-1", guidance: "Therapy visit frequency runs lower for this firm." }),
    ).resolves.toBeDefined();
  });

  it("refuses to generalize a failure that does not generalize", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ failureCode: "SOURCE_CONFLICT" }));
    await expect(
      promoteToCandidate({ firmId: FIRM, findingId: "find-1", guidance: "Prefer the later record." }),
    ).rejects.toThrow(/does not generalize/i);
  });
});

describe("adoption gates", () => {
  const card = (over: Partial<Scorecard> = {}): Scorecard => ({
    evaluatedCaseIds: ["case-2", "case-3"],
    sourceCaseIds: ["case-1"],
    deltas: { claimRecall: 0.04 },
    safetyDeltas: {},
    ...over,
  });

  it("adopts a candidate that improves a metric with no safety regression", () => {
    const v = judgeCandidate(card());
    expect(v.adopt).toBe(true);
    expect(v.safetyClean).toBe(true);
  });

  it("rejects a candidate measured on the case that produced it", () => {
    // A lesson drawn from one case and scored on that case restates the
    // correction; it is not evidence of anything.
    const v = judgeCandidate(card({ evaluatedCaseIds: ["case-1", "case-2"] }));
    expect(v.adopt).toBe(false);
    expect(v.reasons).toContain("EVALUATION_OVERLAPS_TRAINING");
  });

  it("rejects a candidate with no held-out cases at all", () => {
    expect(judgeCandidate(card({ evaluatedCaseIds: [] })).reasons).toContain("NO_HELD_OUT_CASES");
  });

  it("rejects any safety-critical regression however large the gain", () => {
    const v = judgeCandidate(card({ deltas: { claimRecall: 0.5 }, safetyDeltas: { negationReversal: 0.01 } }));
    expect(v.adopt).toBe(false);
    expect(v.safetyClean).toBe(false);
    expect(v.reasons).toContain("SAFETY_REGRESSION:negationReversal");
  });

  it("rejects a candidate that improves nothing", () => {
    expect(judgeCandidate(card({ deltas: { claimRecall: 0 } })).reasons).toContain("NO_MEASURED_IMPROVEMENT");
  });

  it("rejects a gain bought with a material loss in another document class", () => {
    const v = judgeCandidate(card({ byDocumentClass: { OPERATIVE: -0.2 } }));
    expect(v.adopt).toBe(false);
    expect(v.reasons).toContain("REGRESSION_IN_CLASS:OPERATIVE");
  });

  it("is deterministic", () => {
    expect(judgeCandidate(card())).toEqual(judgeCandidate(card()));
  });
});

describe("retrieval is firm-scoped, bounded and PHI-free", () => {
  it("always filters by firm", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE" });
    expect(db.learningCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ firmId: FIRM, status: "ADOPTED" }) }),
    );
  });

  it("refuses to retrieve without a firm", async () => {
    await expect(retrieveGuidance({ firmId: "", mechanism: "TASK_GUIDANCE" })).rejects.toThrow(/requires a firm/i);
  });

  it("returns only adopted lessons", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE" });
    const where = db.learningCandidate.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("ADOPTED");
  });

  it("bounds how much guidance a prompt can receive", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE", limit: 99 });
    expect(db.learningCandidate.findMany.mock.calls[0][0].take).toBe(MAX_RETRIEVED_GUIDANCE);
  });

  it("orders deterministically so the same task builds the same prompt", async () => {
    db.learningCandidate.findMany.mockResolvedValue([]);
    await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE" });
    expect(db.learningCandidate.findMany.mock.calls[0][0].orderBy).toEqual([
      { supportCount: "desc" }, { createdAt: "asc" }, { id: "asc" },
    ]);
  });

  it("drops a lesson that looks patient-specific before it reaches a prompt", async () => {
    db.learningCandidate.findMany.mockResolvedValue([
      { id: "c1", version: 1, guidance: "Capture each documented modality with its duration." },
      { id: "c2", version: 1, guidance: "For the visit on 03/15/2024 record the traction parameters." },
    ]);
    const got = await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE" });
    expect(got.map((g) => g.candidateId)).toEqual(["c1"]);
  });

  it("reports which lessons were applied, so a regression can be traced", async () => {
    db.learningCandidate.findMany.mockResolvedValue([
      { id: "c1", version: 3, guidance: "Capture each documented modality with its duration." },
    ]);
    const got = await retrieveGuidance({ firmId: FIRM, mechanism: "TASK_GUIDANCE" });
    expect(got[0]).toMatchObject({ candidateId: "c1", version: 3 });
  });
});

describe("PHI never enters learning storage", () => {
  it("rejects a date, a DOB, an MRN or a named patient", () => {
    expect(() => assertPhiFree("Record the visit on 03/15/2024")).toThrow();
    expect(() => assertPhiFree("DOB is often mis-read as the encounter date")).toThrow();
    expect(() => assertPhiFree("Check the MRN header")).toThrow();
    expect(() => assertPhiFree("Patient Derrick reported numbness")).toThrow();
  });

  it("rejects anything long enough to be a record excerpt", () => {
    expect(() => assertPhiFree("x".repeat(400))).toThrow(/exceeds/);
  });

  it("accepts fact-free structural guidance", () => {
    expect(() => assertPhiFree("For therapy notes, capture each documented modality with duration and parameters.")).not.toThrow();
    expect(() => assertPhiFree("Do not lead a visit summary with height, weight or routine intake information.")).not.toThrow();
  });

  it("sanitizes rather than repairs", () => {
    expect(sanitizeGuidance("Capture the exam section.")).toBe("Capture the exam section.");
    expect(sanitizeGuidance("Seen on 03/15/2024 for follow-up")).toBeNull();
  });
});

describe("repair is bounded and never silently claims success", () => {
  it("marks a finding repaired only when the defect is gone", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ state: "VALIDATED" }));
    await recordRepairAttempt("find-1", FIRM, true);
    expect(db.learningFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "REPAIRED" }) }),
    );
  });

  it("leaves a failed repair visible as unresolved", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ state: "VALIDATED" }));
    await recordRepairAttempt("find-1", FIRM, false);
    expect(db.learningFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "UNRESOLVED", repairedAt: null }) }),
    );
  });

  it("bounds retries rather than looping on an unrecoverable defect", () => {
    expect(repairExhausted(MAX_REPAIR_ATTEMPTS)).toBe(true);
    expect(repairExhausted(MAX_REPAIR_ATTEMPTS - 1)).toBe(false);
  });

  it("refuses to repair something nobody confirmed", async () => {
    db.learningFinding.findFirst.mockResolvedValue(finding({ state: "DETECTED" }));
    await expect(recordRepairAttempt("find-1", FIRM, true)).rejects.toThrow(/only a validated finding/i);
  });
});
