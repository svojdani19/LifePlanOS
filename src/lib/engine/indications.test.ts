import { describe, it, expect } from "vitest";
import { checkIndication } from "./indications";

describe("indication checklists", () => {
  it("revision arthroplasty requires an index implant", () => {
    expect(checkIndication("Revision knee arthroplasty", "post-traumatic osteoarthritis of the knee")?.met).toBe(false);
    expect(checkIndication("Revision knee arthroplasty", "status post total knee arthroplasty 2024")?.met).toBe(true);
  });

  it("primary arthroplasty requires documented articular pathology", () => {
    expect(checkIndication("Total knee arthroplasty", "ankle sprain with mild swelling")?.met).toBe(false);
    expect(checkIndication("Total knee arthroplasty", "tricompartmental joint space narrowing, post-traumatic arthritis")?.met).toBe(true);
  });

  it("attendant care requires documented functional dependence", () => {
    expect(checkIndication("Attendant care", "well-healed incision, full ROM")?.met).toBe(false);
    expect(checkIndication("Attendant care", "requires assistance with ADLs and transfers")?.met).toBe(true);
  });

  it("EMG requires neurologic symptoms; psych services require psych documentation", () => {
    expect(checkIndication("EMG / nerve conduction study", "isolated patellar fracture")?.met).toBe(false);
    expect(checkIndication("EMG / nerve conduction study", "radiating numbness and tingling to the foot")?.met).toBe(true);
    expect(checkIndication("Psychological counseling", "left tibial plateau fracture")?.met).toBe(false);
    expect(checkIndication("Psychological counseling", "adjustment disorder with depressed mood")?.met).toBe(true);
  });

  it("returns null for services with no defined checklist", () => {
    expect(checkIndication("Orthopedic follow-up visits", "anything")).toBeNull();
  });
});
