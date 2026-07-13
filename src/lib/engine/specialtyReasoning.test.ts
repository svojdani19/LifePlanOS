import { describe, it, expect } from "vitest";
import { specialtyLens } from "./specialtyReasoning";

describe("specialtyLens", () => {
  it("maps each care category to its specialty's concern and goal", () => {
    expect(specialtyLens("PAIN_MANAGEMENT", "Pain management visits").concern).toMatch(/opioid|medication optimization/i);
    expect(specialtyLens("ORTHOPEDIC_SURGERY", "Total knee arthroplasty").concern).toMatch(/post-traumatic arthritis|revision/i);
    expect(specialtyLens("PMR", "Physiatry follow-up").goal).toMatch(/independence|function/i);
    expect(specialtyLens("NEUROSURGERY", "Lumbar fusion").concern).toMatch(/adjacent-segment|instability/i);
    expect(specialtyLens("NEUROLOGY", "Neurology follow-up").concern).toMatch(/neuropathic|electrodiagnostic/i);
    expect(specialtyLens("PRIMARY_CARE", "Annual visit").concern).toMatch(/coordination|medication safety/i);
  });

  it("lets a service keyword (urology) override the category", () => {
    const l = specialtyLens("SPECIALIST_VISIT", "Neurogenic bladder management");
    expect(l.label).toBe("urology");
    expect(l.concern).toMatch(/renal|bladder/i);
  });

  it("different specialties produce different lenses (no shared generic wording)", () => {
    const pain = specialtyLens("PAIN_MANAGEMENT", "x");
    const ortho = specialtyLens("ORTHOPEDIC_SURGERY", "y");
    expect(pain.label).not.toBe(ortho.label);
    expect(pain.concern).not.toBe(ortho.concern);
    expect(pain.goal).not.toBe(ortho.goal);
  });
});
