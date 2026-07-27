import { describe, it, expect } from "vitest";
import { orderReviewQueue, priorityOf, weakestDimensions, sufficiencySummary, type ReviewQueueItem } from "./reviewQueue";

const base: ReviewQueueItem = {
  itemId: "x",
  caseId: "c",
  caseNumber: "LCP-2026-0001",
  clientName: "Test",
  service: "svc",
  category: "IMAGING",
  presentValue: 10_000,
  probability: "PROBABLE",
  isLifetime: false,
  frequencyPerYear: 1,
  durationYears: 5,
  assessmentStatus: "VALIDATED",
  blockingFindings: [],
  sufficiency: null,
  weakestDimensions: [],
  necessityRationale: null,
  unknownCount: 0,
};

describe("orderReviewQueue", () => {
  it("blocking findings outrank everything, then INVALID, then NEEDS_REVIEW, then PV", () => {
    const q = orderReviewQueue([
      { ...base, itemId: "validated-big", presentValue: 900_000 },
      { ...base, itemId: "needs-review", assessmentStatus: "NEEDS_REVIEW", presentValue: 5_000 },
      { ...base, itemId: "invalid", assessmentStatus: "INVALID", presentValue: 1_000 },
      { ...base, itemId: "blocked", blockingFindings: ["Laterality mismatch"], presentValue: 100 },
    ]);
    expect(q.map((i) => i.itemId)).toEqual(["blocked", "invalid", "needs-review", "validated-big"]);
  });

  it("within a priority class, dollars at stake rank first", () => {
    const q = orderReviewQueue([
      { ...base, itemId: "small", assessmentStatus: "NEEDS_REVIEW", presentValue: 5_000 },
      { ...base, itemId: "large", assessmentStatus: "NEEDS_REVIEW", presentValue: 500_000 },
    ]);
    expect(q[0].itemId).toBe("large");
  });

  it("priorityOf is stable for unassessed items", () => {
    expect(priorityOf({ blockingFindings: [], assessmentStatus: null })).toBe(3);
  });
});

describe("weakestDimensions", () => {
  const vector = {
    clinicalCertainty: 80,
    evidenceQuality: 70,
    objectiveEvidence: 20,
    literatureSupport: 60,
    guidelineSupport: 90,
    providerAgreement: 50,
    chronologyConsistency: 85,
    medicalNecessity: 75,
    contradictoryEvidence: 95, // heavy contradiction burden
    physicianReview: 0,
  };

  it("ranks the lowest dimensions, inverting the contradiction burden", () => {
    const weakest = weakestDimensions(vector, 2);
    // contradiction burden 95 → effective 5 (weakest); objective evidence 20 next.
    expect(weakest[0]).toEqual({ dimension: "contradiction burden", score: 5 });
    expect(weakest[1]).toEqual({ dimension: "objective evidence", score: 20 });
  });

  it("excludes the physicianReview dimension — the queue itself explains it", () => {
    const weakest = weakestDimensions(vector, 10);
    expect(weakest.some((w) => w.dimension === "physician review")).toBe(false);
  });

  it("is empty for a missing vector", () => {
    expect(weakestDimensions(null)).toEqual([]);
  });
});

describe("sufficiencySummary", () => {
  it("compacts a sufficiency payload and caps the missing list", () => {
    const s = sufficiencySummary({ score: 40, threshold: 60, sufficient: false, missing: ["a", "b", "c", "d", "e", "f", "g"] } as never);
    expect(s).toMatchObject({ score: 40, threshold: 60, sufficient: false });
    expect(s!.missing).toHaveLength(5);
  });

  it("is null when scores are absent", () => {
    expect(sufficiencySummary(null)).toBeNull();
    expect(sufficiencySummary({} as never)).toBeNull();
  });
});
