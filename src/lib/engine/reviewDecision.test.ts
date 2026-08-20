import { describe, it, expect } from "vitest";
import { supportClassForDecision, classifyExistingItem, needsReclassification, reviewDecisionFields } from "@/lib/engine/reviewDecision";
import { entersSupportedTotal, computePlanTotals } from "@/lib/engine/supportClass";

describe("a review decision writes the classification, not just the status", () => {
  it("puts an approved template into the supported total", () => {
    // The defect: the route set `physicianStatus` alone, so an approved item
    // stayed CANDIDATE_REVIEW and out of the headline while report logic keyed
    // on approval counted it.
    const item = { origin: "TEMPLATE_CONDITION", supportClass: "CANDIDATE_REVIEW" };
    const v = supportClassForDecision(item, "APPROVED");
    expect(v.supportClass).toBe("PROFESSIONALLY_ADOPTED");
    expect(entersSupportedTotal(v.supportClass)).toBe(true);
  });

  it("labels approval as professional judgement, never as treating-record evidence", () => {
    const v = supportClassForDecision({ origin: "TEMPLATE_CONDITION" }, "APPROVED");
    expect(v.reason).toMatch(/qualified professional/i);
    expect(v.reason).not.toMatch(/treating provider recommended/i);
  });

  it("takes a rejected item out of the total whatever its origin", () => {
    for (const origin of ["TEMPLATE_CONDITION", "RECORD_RECOMMENDED", "PHYSICIAN_ADDED"]) {
      const v = supportClassForDecision({ origin }, "REJECTED");
      expect(v.supportClass, origin).toBe("UNSUPPORTED");
      expect(entersSupportedTotal(v.supportClass)).toBe(false);
    }
  });

  it("treats MODIFIED as adoption — the physician has taken it as their own", () => {
    expect(supportClassForDecision({ origin: "TEMPLATE_BASELINE" }, "MODIFIED").supportClass).toBe("PROFESSIONALLY_ADOPTED");
  });

  it("returns every field a decision writes, so no caller can write half of it", () => {
    const f = reviewDecisionFields({ origin: "TEMPLATE_CONDITION" }, "APPROVED", "PHYSICIAN_APPROVED");
    expect(Object.keys(f).sort()).toEqual(["lifecycleStatus", "physicianStatus", "supportClass", "supportReason"]);
  });
});

describe("the backfill is deterministic, idempotent, and agrees with the routes", () => {
  it("rescues a plan the migration default would have collapsed", () => {
    // Every pre-existing row got CANDIDATE_REVIEW from the column default.
    // For an approved plan that is wrong in the dangerous direction: the
    // headline supported total drops to nothing.
    const approvedPlan = [
      { origin: "TEMPLATE_CONDITION", physicianStatus: "APPROVED", supportClass: "CANDIDATE_REVIEW", presentValue: 100_000, lifetimeCost: 120_000 },
      { origin: "RECORD_RECOMMENDED", physicianStatus: "APPROVED", supportClass: "CANDIDATE_REVIEW", presentValue: 50_000, lifetimeCost: 60_000 },
    ];
    expect(computePlanTotals(approvedPlan).supported.presentValue).toBe(0);
    const fixed = approvedPlan.map((i) => ({ ...i, supportClass: classifyExistingItem(i).supportClass }));
    expect(computePlanTotals(fixed).supported.presentValue).toBe(150_000);
  });

  it("agrees exactly with what the review route would have written", () => {
    for (const origin of ["TEMPLATE_CONDITION", "TEMPLATE_BASELINE", "RECORD_RECOMMENDED", "PHYSICIAN_ADDED"]) {
      for (const status of ["APPROVED", "MODIFIED", "REJECTED"]) {
        expect(classifyExistingItem({ origin, physicianStatus: status }).supportClass, `${origin}/${status}`)
          .toBe(supportClassForDecision({ origin }, status).supportClass);
      }
    }
  });

  it("never invents patient-specific support for an unreviewed template", () => {
    const v = classifyExistingItem({ origin: "TEMPLATE_CONDITION", physicianStatus: "PENDING" });
    expect(v.supportClass).toBe("CANDIDATE_REVIEW");
    expect(entersSupportedTotal(v.supportClass)).toBe(false);
  });

  it("keeps an unreviewed record-recommended item supported", () => {
    expect(classifyExistingItem({ origin: "RECORD_RECOMMENDED", physicianStatus: "PENDING" }).supportClass).toBe("RECORD_RECOMMENDED");
  });

  it("never totals reference content, reviewed or not", () => {
    expect(classifyExistingItem({ origin: "GOLD_IMPORT", physicianStatus: "PENDING" }).supportClass).toBe("UNSUPPORTED");
  });

  it("is idempotent — a second run changes nothing", () => {
    const item = { origin: "TEMPLATE_CONDITION", physicianStatus: "APPROVED", supportClass: "CANDIDATE_REVIEW" };
    expect(needsReclassification(item)).toBe(true);
    const once = { ...item, supportClass: classifyExistingItem(item).supportClass };
    expect(needsReclassification(once)).toBe(false);
    expect(classifyExistingItem(once).supportClass).toBe(classifyExistingItem(item).supportClass);
  });
});
