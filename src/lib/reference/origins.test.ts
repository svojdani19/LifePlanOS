import { describe, it, expect } from "vitest";
import { originClass, isGrounded, AUTHORED_ORIGINS, ORIGIN_CLASS } from "@/lib/reference/origins";

describe("one definition of where an item came from", () => {
  it("keeps the four claims distinct", () => {
    expect(originClass("RECORD_RECOMMENDED")).toBe("TREATING_RECORD");
    expect(originClass("PHYSICIAN_ADDED")).toBe("PROFESSIONAL");
    expect(originClass("TEMPLATE_CONDITION")).toBe("TEMPLATE");
    expect(originClass("GOLD_IMPORT")).toBe("REFERENCE");
  });

  it("does not let reference content count as authored production content", () => {
    // This is what kept a published plan's 37 items alive inside the runtime
    // plan across every regeneration.
    expect(AUTHORED_ORIGINS.has("GOLD_IMPORT")).toBe(false);
    expect(AUTHORED_ORIGINS.has("PHYSICIAN_ADDED")).toBe(true);
    expect(AUTHORED_ORIGINS.has("PLANNER_ADDED")).toBe(true);
  });

  it("never grounds an item on reference material", () => {
    expect(isGrounded({ origin: "GOLD_IMPORT" })).toBe(false);
    // Not even when someone approved it — approval grounds it as PROFESSIONAL
    // judgement, which is a different origin, not as reference material.
    expect(isGrounded({ origin: "GOLD_IMPORT", physicianStatus: "APPROVED" })).toBe(false);
  });

  it("grounds a template only once a professional adopts it", () => {
    expect(isGrounded({ origin: "TEMPLATE_CONDITION" })).toBe(false);
    expect(isGrounded({ origin: "TEMPLATE_CONDITION", physicianStatus: "APPROVED" })).toBe(true);
    expect(isGrounded({ origin: "TEMPLATE_CONDITION", physicianStatus: "MODIFIED" })).toBe(true);
  });

  it("treats an unknown origin as a template — the weaker claim", () => {
    expect(originClass("SOMETHING_NEW")).toBe("TEMPLATE");
    expect(isGrounded({ origin: null })).toBe(false);
  });

  it("classifies every origin the schema declares", () => {
    for (const o of ["RECORD_RECOMMENDED", "PHYSICIAN_ADDED", "PLANNER_ADDED", "TEMPLATE_CONDITION", "TEMPLATE_BASELINE", "GOLD_IMPORT"]) {
      expect(ORIGIN_CLASS[o], o).toBeDefined();
    }
  });
});
