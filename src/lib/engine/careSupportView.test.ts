import { describe, it, expect } from "vitest";
import {
  totalsMembership,
  supportBadgeFor,
  isDeEmphasised,
  categorySubtotal,
  membershipCaption,
  membershipExplanation,
  SUPPORT_TONE,
  SUPPORT_SHORT,
} from "@/lib/engine/careSupportView";
import { computePlanTotals, SUPPORT_CLASSES, SUPPORT_LABEL, type SupportClass } from "@/lib/engine/supportClass";

// ─────────────────────────────────────────────────────────────────────────────
// The defect: three different rules answered "is this in the total?".
//
//   server  — computePlanTotals, over supportClass
//   Costs   — it.contingencyOnly || physicianStatus === "REJECTED"
//   Future  — no rule at all; the subtotal summed every item in the group
//
// So the binding property is not "the view-model is self-consistent" — it is
// "the view-model agrees with computePlanTotals for every class". These tests
// assert that against the real totals function, not against a restatement of
// the view-model's own logic.
// ─────────────────────────────────────────────────────────────────────────────

const item = (supportClass: string, presentValue = 100, lifetimeCost = 150) =>
  ({ supportClass, presentValue, lifetimeCost });

describe("totalsMembership agrees with computePlanTotals", () => {
  it.each(SUPPORT_CLASSES)("%s is bucketed the way the totals count it", (cls) => {
    const totals = computePlanTotals([item(cls)]);
    const membership = totalsMembership(item(cls));
    expect(membership === "SUPPORTED").toBe(totals.supported.items === 1);
    // The scenario total includes supported items, so "in the scenario but not
    // supported" is exactly the candidate bucket.
    const inScenarioOnly = totals.scenario.items === 1 && totals.supported.items === 0;
    expect(membership === "CANDIDATE").toBe(inScenarioOnly);
    expect(membership === "EXCLUDED").toBe(totals.scenario.items === 0);
  });

  // The five states the brief names, spelled out so a regression names itself.
  it("record-supported enters the total", () => {
    expect(totalsMembership(item("RECORD_RECOMMENDED"))).toBe("SUPPORTED");
  });
  it("physician-supported enters the total", () => {
    expect(totalsMembership(item("PROFESSIONALLY_ADOPTED"))).toBe("SUPPORTED");
  });
  it("a proposed candidate does NOT enter the total", () => {
    expect(totalsMembership(item("CANDIDATE_REVIEW"))).toBe("CANDIDATE");
  });
  it("a contingent item does NOT enter the total", () => {
    expect(totalsMembership(item("CONDITIONAL"))).toBe("CANDIDATE");
  });
  it("a rejected item enters no total", () => {
    expect(totalsMembership(item("UNSUPPORTED"))).toBe("EXCLUDED");
  });

  it("defaults closed for an unknown or missing class", () => {
    expect(totalsMembership({ supportClass: null })).toBe("CANDIDATE");
    expect(totalsMembership({ supportClass: "SOMETHING_NEW" })).toBe("CANDIDATE");
    expect(totalsMembership({})).toBe("CANDIDATE");
  });
});

describe("the old Costs rule disagreed — proving these tests are not vacuous", () => {
  // Control. If this ever stops failing, the two rules have converged and the
  // assertions above have lost their teeth.
  const oldRule = (it: { contingencyOnly?: boolean; physicianStatus?: string }) =>
    !(it.contingencyOnly || it.physicianStatus === "REJECTED");

  it("counted a candidate as included, while the totals excluded it", () => {
    const candidate = { supportClass: "CANDIDATE_REVIEW", contingencyOnly: false, physicianStatus: "PENDING" };
    expect(oldRule(candidate)).toBe(true); // the old UI said "included"
    expect(totalsMembership(candidate)).not.toBe("SUPPORTED"); // the total said otherwise
    expect(computePlanTotals([{ ...candidate, presentValue: 100, lifetimeCost: 100 }]).supported.items).toBe(0);
  });
});

describe("supportBadgeFor", () => {
  it("uses the canonical label for every class", () => {
    for (const cls of SUPPORT_CLASSES) {
      expect(supportBadgeFor(item(cls)).label).toBe(SUPPORT_LABEL[cls]);
    }
  });

  it("carries a short form and a tone for every class", () => {
    for (const cls of SUPPORT_CLASSES) {
      const badge = supportBadgeFor(item(cls));
      expect(badge.short).toBe(SUPPORT_SHORT[cls]);
      expect(badge.tone).toBe(SUPPORT_TONE[cls as SupportClass]);
      expect(badge.short.length).toBeGreaterThan(0);
    }
  });

  it("states the totals consequence in the hover title", () => {
    expect(supportBadgeFor(item("RECORD_RECOMMENDED")).title).toContain("Included in the supported total");
    expect(supportBadgeFor(item("CANDIDATE_REVIEW")).title).toContain("not included in the supported total");
    expect(supportBadgeFor(item("UNSUPPORTED")).title).toContain("Not included in any total");
  });

  it("de-emphasises exactly the rows outside the headline total", () => {
    expect(isDeEmphasised(item("RECORD_RECOMMENDED"))).toBe(false);
    expect(isDeEmphasised(item("PATIENT_SPECIFIC"))).toBe(false);
    expect(isDeEmphasised(item("PROFESSIONALLY_ADOPTED"))).toBe(false);
    expect(isDeEmphasised(item("CANDIDATE_REVIEW"))).toBe(true);
    expect(isDeEmphasised(item("CONDITIONAL"))).toBe(true);
    expect(isDeEmphasised(item("UNSUPPORTED"))).toBe(true);
  });
});

describe("categorySubtotal", () => {
  const mixed = [
    item("RECORD_RECOMMENDED", 100, 200),
    item("PROFESSIONALLY_ADOPTED", 50, 60),
    item("CANDIDATE_REVIEW", 900, 1000),
    item("CONDITIONAL", 70, 80),
    item("UNSUPPORTED", 5000, 6000),
  ];

  it("never folds candidates into the supported subtotal", () => {
    const s = categorySubtotal(mixed);
    expect(s.supported).toEqual({ items: 2, presentValue: 150, lifetimeCost: 260 });
    expect(s.candidate).toEqual({ items: 2, presentValue: 970, lifetimeCost: 1080 });
    expect(s.excluded).toEqual({ items: 1, presentValue: 5000, lifetimeCost: 6000 });
  });

  it("its supported bucket equals what computePlanTotals counts", () => {
    const s = categorySubtotal(mixed);
    const totals = computePlanTotals(mixed);
    expect(s.supported.items).toBe(totals.supported.items);
    expect(s.supported.presentValue).toBe(totals.supported.presentValue);
    expect(s.supported.lifetimeCost).toBe(totals.supported.lifetimeCost);
  });

  it("its supported+candidate buckets equal the scenario total", () => {
    const s = categorySubtotal(mixed);
    const totals = computePlanTotals(mixed);
    expect(s.supported.items + s.candidate.items).toBe(totals.scenario.items);
    expect(s.supported.presentValue + s.candidate.presentValue).toBe(totals.scenario.presentValue);
  });

  // The exact regression: the old subtotal was this sum.
  it("does not reproduce the old sum-everything subtotal", () => {
    const oldSubtotal = mixed.reduce((sum, i) => sum + i.presentValue, 0);
    expect(categorySubtotal(mixed).supported.presentValue).not.toBe(oldSubtotal);
    expect(oldSubtotal).toBe(6120);
  });

  it("handles an empty category and missing money fields", () => {
    expect(categorySubtotal([])).toEqual({
      supported: { items: 0, presentValue: 0, lifetimeCost: 0 },
      candidate: { items: 0, presentValue: 0, lifetimeCost: 0 },
      excluded: { items: 0, presentValue: 0, lifetimeCost: 0 },
    });
    const sparse = categorySubtotal([{ supportClass: "RECORD_RECOMMENDED" }]);
    expect(sparse.supported).toEqual({ items: 1, presentValue: 0, lifetimeCost: 0 });
  });
});

describe("membershipCaption", () => {
  it("is silent when there is no distinction to draw", () => {
    expect(membershipCaption(categorySubtotal([item("RECORD_RECOMMENDED")]))).toBeNull();
  });

  it("names the counts that are not in the supported total", () => {
    const caption = membershipCaption(categorySubtotal([item("RECORD_RECOMMENDED"), item("CANDIDATE_REVIEW"), item("UNSUPPORTED")]));
    expect(caption).toBe("1 in the supported total · 1 disclosed for review · 1 in no total");
  });
});

describe("membershipExplanation", () => {
  it("gives the canonical label and the totals consequence, and nothing else", () => {
    expect(membershipExplanation(item("CANDIDATE_REVIEW"))).toBe(
      "Candidate — awaiting patient-specific support. Disclosed for review; not included in the supported total.",
    );
  });

  // Physician disposition and contingency are facts about an item, but they
  // are not the totaling rule — presenting them as the rule is the defect.
  it("does not describe the rule in terms of physician status or contingency", () => {
    for (const cls of SUPPORT_CLASSES) {
      const text = membershipExplanation(item(cls));
      expect(text).not.toMatch(/contingenc/i);
      expect(text).not.toMatch(/physician (rejected|approved)/i);
    }
  });
});
