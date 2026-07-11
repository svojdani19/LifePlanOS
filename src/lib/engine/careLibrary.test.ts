import { describe, it, expect } from "vitest";
import { resolveConditionKeys, CONDITION_CARE } from "./careLibrary";

describe("resolveConditionKeys", () => {
  it("maps a lumbar diagnosis to the lumbar spine condition", () => {
    expect(resolveConditionKeys("L1 burst fracture of the lumbar spine")).toContain("LUMBAR_SPINE");
  });
  it("recognizes a traumatic brain injury", () => {
    expect(resolveConditionKeys("severe traumatic brain injury with post-concussion syndrome")).toContain("TBI");
  });
  it("recognizes a knee injury", () => {
    expect(resolveConditionKeys("displaced tibial plateau fracture of the knee")).toContain("KNEE");
  });
  it("matches multiple conditions in a polytrauma corpus", () => {
    const keys = resolveConditionKeys("lumbar radiculopathy ; cervical neck pain ; traumatic brain injury ; total knee arthroplasty");
    expect(keys).toEqual(expect.arrayContaining(["LUMBAR_SPINE", "CERVICAL_SPINE", "TBI", "KNEE"]));
  });
  it("returns no keys for non-clinical text", () => {
    expect(resolveConditionKeys("the quick brown fox jumps over the lazy dog")).toHaveLength(0);
  });
  it("every matched condition maps to a non-empty care set", () => {
    for (const k of resolveConditionKeys("lumbar spine injury")) {
      expect(CONDITION_CARE[k].length).toBeGreaterThan(0);
    }
  });
});
