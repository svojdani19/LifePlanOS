import { describe, it, expect } from "vitest";
import { planRegeneration, materialChanges, changedFields, hasReviewHistory, lifecycleFor, MATERIAL_FIELDS, type PriorItem } from "./lifecycle";

// P2.R1 — review-history preservation rules (see docs/15_PRODUCT_ROADMAP.md).

const base = { lineageId: "L1", version: 1, physicianNote: null, edited: false, lifecycleStatus: "AI_DRAFT" };

describe("hasReviewHistory", () => {
  it("is false for an untouched AI draft", () => {
    expect(hasReviewHistory({ physicianStatus: "PENDING" })).toBe(false);
  });
  it("is true after any physician action, note, or planner edit", () => {
    expect(hasReviewHistory({ physicianStatus: "APPROVED" })).toBe(true);
    expect(hasReviewHistory({ physicianStatus: "REJECTED" })).toBe(true);
    expect(hasReviewHistory({ physicianStatus: "PENDING", physicianNote: "seen" })).toBe(true);
    expect(hasReviewHistory({ physicianStatus: "PENDING", edited: true })).toBe(true);
  });
});

describe("planRegeneration — supersede, never delete, reviewed items (P2.R1 §1)", () => {
  const prior: PriorItem[] = [
    { ...base, id: "a", service: "Pain management visits", physicianStatus: "APPROVED", lifecycleStatus: "PHYSICIAN_APPROVED" },
    { ...base, id: "b", service: "Physical therapy", physicianStatus: "PENDING" },
    { ...base, id: "c", service: "Knee brace", physicianStatus: "PENDING", edited: true },
  ];
  const plan = planRegeneration(prior);

  it("deletes only the untouched AI draft", () => {
    expect(plan.deleteIds).toEqual(["b"]);
  });
  it("preserves the approved and the planner-edited items as superseded", () => {
    expect(plan.supersede.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });
  it("continues the lineage for a regenerated service at version+1 (P2.R1 §2)", () => {
    const lin = plan.lineageForService.get("pain management visits");
    expect(lin).toEqual({ lineageId: "L1", version: 1, priorId: "a" });
  });
  it("keeps the highest version as the lineage head", () => {
    const p2 = planRegeneration([
      { ...base, id: "v1", service: "X", physicianStatus: "APPROVED", version: 1 },
      { ...base, id: "v2", service: "X", physicianStatus: "APPROVED", version: 3 },
    ]);
    expect(p2.lineageForService.get("x")!.priorId).toBe("v2");
  });
});

describe("material vs nonmaterial changes (P2.R1 §3)", () => {
  const prior = { service: "TKA", cptCode: "27447", frequencyPerYear: 1, rationale: "old wording", unitCost: 42000 };

  it("a frequency change is material (invalidates approval)", () => {
    expect(materialChanges({ frequencyPerYear: 2 }, prior)).toEqual(["frequencyPerYear"]);
  });
  it("a CPT change is material", () => {
    expect(materialChanges({ cptCode: "27446" }, prior)).toEqual(["cptCode"]);
  });
  it("a rationale re-wording is NOT material (approval carries)", () => {
    expect(materialChanges({ rationale: "clearer wording" }, prior)).toEqual([]);
    expect(changedFields({ rationale: "clearer wording" }, prior)).toEqual(["rationale"]);
  });
  it("an unchanged material field does not trigger invalidation", () => {
    expect(materialChanges({ cptCode: "27447", rationale: "x" }, prior)).toEqual([]);
  });
  it("the material-field list is the code-defined one from the requirement", () => {
    expect([...MATERIAL_FIELDS]).toEqual(["service", "category", "conditionId", "cptCode", "probability", "frequencyPerYear", "durationYears", "isLifetime", "unitCost", "pricingSource"]);
  });
});

describe("lifecycle mapping", () => {
  it("maps legacy physician statuses honestly", () => {
    expect(lifecycleFor("APPROVED")).toBe("PHYSICIAN_APPROVED");
    expect(lifecycleFor("MODIFIED")).toBe("PHYSICIAN_MODIFIED");
    expect(lifecycleFor("REJECTED")).toBe("PHYSICIAN_REJECTED");
    expect(lifecycleFor("PENDING")).toBe("AI_DRAFT");
    expect(lifecycleFor("PENDING", { recordSupported: true })).toBe("RECORD_SUPPORTED");
    expect(lifecycleFor("APPROVED", { superseded: true })).toBe("SUPERSEDED");
  });
});
