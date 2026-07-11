import { describe, it, expect } from "vitest";
import { findConditionsInRecords, parseConditions, serializeConditions } from "./preExisting";

describe("findConditionsInRecords — prior-history scoping", () => {
  it("detects conditions listed in a past-medical-history section", () => {
    const found = findConditionsInRecords("PAST MEDICAL HISTORY: Hypertension, type 2 diabetes mellitus, degenerative disc disease, and chronic low back pain.");
    expect(found).toContain("Hypertension");
    expect(found).toContain("Diabetes mellitus, Type 2");
    expect(found).toContain("Degenerative disc disease");
  });

  it("does NOT flag a post-injury diagnosis that isn't framed as prior history", () => {
    const found = findConditionsInRecords("MRI IMPRESSION: acute traumatic injury with degenerative disc disease at L4-L5 and post-traumatic peripheral neuropathy.");
    expect(found).not.toContain("Degenerative disc disease");
    expect(found).not.toContain("Peripheral neuropathy");
  });

  it("detects a condition carried by an explicit prior qualifier", () => {
    expect(findConditionsInRecords("The patient has a history of seizure disorder.")).toContain("Seizure disorder / epilepsy");
  });

  it("does not flag the current mechanism as a prior MVC", () => {
    expect(findConditionsInRecords("Back pain after a motor vehicle collision.")).not.toContain("Prior motor vehicle collision injury");
  });

  it("returns nothing for empty input", () => {
    expect(findConditionsInRecords("")).toHaveLength(0);
    expect(findConditionsInRecords(null)).toHaveLength(0);
  });
});

describe("parse/serialize conditions", () => {
  it("round-trips a delimited list without splitting on commas inside names", () => {
    const list = ["Diabetes mellitus, Type 2", "Hypertension"];
    expect(parseConditions(serializeConditions(list))).toEqual(list);
  });
});
