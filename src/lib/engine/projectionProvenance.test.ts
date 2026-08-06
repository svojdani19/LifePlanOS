// A citation beside a projected line reads as if the records supplied every
// number on it. These tests hold the line that they usually did not, and that
// the report says so. Synthetic text only.
import { describe, it, expect } from "vitest";
import { statedQuantities, projectionNote, sealProvenance, ALL_ASSUMED, type ProjectionInputs } from "./projectionProvenance";

describe("quantities the records actually state", () => {
  it("reads a stated frequency", () => {
    expect(statedQuantities("Physical therapy twice weekly.").frequencyPerYear).toBe(104);
    expect(statedQuantities("PT three times a week.").frequencyPerYear).toBe(156);
    expect(statedQuantities("Follow up monthly.").frequencyPerYear).toBe(12);
    expect(statedQuantities("Injections every 6 months.").frequencyPerYear).toBe(2);
    expect(statedQuantities("Repeat imaging annually.").frequencyPerYear).toBe(1);
  });

  it("reads a stated duration", () => {
    expect(statedQuantities("Physical therapy for 12 weeks.").durationYears).toBeCloseTo(12 / 52, 5);
    expect(statedQuantities("Continue for 6 months.").durationYears).toBeCloseTo(0.5, 5);
    expect(statedQuantities("Brace for 2 years.").durationYears).toBe(2);
  });

  it("derives duration from a stated visit count and frequency", () => {
    const q = statedQuantities("Physical therapy twice weekly x 12 visits.");
    expect(q.frequencyPerYear).toBe(104);
    expect(q.durationYears).toBeCloseTo(12 / 104, 5);
  });

  it("says nothing when the note says nothing — silence is never a number", () => {
    expect(statedQuantities("Recommend lumbar epidural steroid injection.")).toEqual({});
    expect(statedQuantities("Refer to pain management.")).toEqual({});
  });
});

describe("the report says which numbers came from where", () => {
  const p = (over: Partial<ProjectionInputs> = {}): ProjectionInputs => ({ ...ALL_ASSUMED, ...over });

  it("a purely conventional line disclaims record support for its quantities", () => {
    const note = projectionNote(p());
    expect(note).toMatch(/planning assumptions/);
    expect(note).toMatch(/No record citation supports these quantities/);
  });

  it("a record-supported service with conventional quantities says exactly that", () => {
    const note = projectionNote(p({ service: "RECORD_STATED", citation: { filename: "MR.pdf", page: 12, date: "2026-02-01", provider: "Dana Rivers, MD" } }));
    expect(note).toMatch(/the need for this service is stated in the treating records/);
    expect(note).toMatch(/frequency, duration and unit cost are planning assumptions/i);
    expect(note).toMatch(/the citation does not support them/);
  });

  it("a stated frequency is credited to the records and not to the planner", () => {
    const note = projectionNote(p({ service: "RECORD_STATED", frequency: "RECORD_STATED" }));
    expect(note).toMatch(/the need for this service and frequency are stated/);
    expect(note).toMatch(/Duration and unit cost are planning assumptions/);
  });

  it("a fully record-stated line carries its citation for everything", () => {
    const note = projectionNote({ service: "RECORD_STATED", frequency: "RECORD_STATED", duration: "RECORD_STATED", unitCost: "RECORD_STATED", citation: null });
    expect(note).toMatch(/all projected quantities are stated in the treating records/);
  });
});

describe("an assumption never carries a citation", () => {
  it("a citation on an all-assumed line is stripped structurally, not by convention", () => {
    const sealed = sealProvenance({ ...ALL_ASSUMED, citation: { filename: "MR.pdf", page: 4, date: null, provider: null } });
    expect(sealed.citation).toBeNull();
  });

  it("a citation survives when at least one input is record-stated", () => {
    const cite = { filename: "MR.pdf", page: 4, date: null, provider: null };
    expect(sealProvenance({ ...ALL_ASSUMED, service: "RECORD_STATED", citation: cite }).citation).toEqual(cite);
  });
});
