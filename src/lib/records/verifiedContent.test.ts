// A verification is a statement about specific content. These tests pin that
// the hash tracks MEANING — changing a fact invalidates it, reordering or
// re-reviewing does not. Synthetic data only.
import { describe, it, expect } from "vitest";
import { encounterContentHash, detectVerificationDrift, type HashableEncounter } from "./verifiedContent";

const base = (over: Partial<HashableEncounter> = {}): HashableEncounter => ({
  dateStatus: "DOCUMENTED",
  encounterDate: new Date("2025-03-14T00:00:00Z"),
  provider: "Dana Rivers, MD",
  facility: null,
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit — Lumbar radiculopathy.",
  synthesis: null,
  claims: [
    { field: "assessment", claimType: "DIAGNOSIS", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 },
    { field: "treatment", claimType: "RECOMMENDED_TREATMENT", value: "Physical therapy recommended", excerpt: "Plan: recommend physical therapy", page: 1 },
  ],
  ...over,
});

describe("content hashing tracks meaning", () => {
  it("is stable for identical content", () => {
    expect(encounterContentHash(base())).toBe(encounterContentHash(base()));
  });

  it("ignores claim ORDER — the same facts are the same facts", () => {
    const reordered = base({ claims: [...(base().claims as unknown[])].reverse() });
    expect(encounterContentHash(reordered)).toBe(encounterContentHash(base()));
  });

  it("accepts an ISO string or a Date for the encounter date", () => {
    expect(encounterContentHash(base({ encounterDate: "2025-03-14" }))).toBe(encounterContentHash(base()));
  });

  it("changes when a claim VALUE changes", () => {
    const altered = base({
      claims: [
        { field: "assessment", claimType: "DIAGNOSIS", value: "Cervical radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 },
        { field: "treatment", claimType: "RECOMMENDED_TREATMENT", value: "Physical therapy recommended", excerpt: "Plan: recommend physical therapy", page: 1 },
      ],
    });
    expect(encounterContentHash(altered)).not.toBe(encounterContentHash(base()));
  });

  it("changes when a claim TYPE changes — recommended vs delivered is a different fact", () => {
    const altered = base({
      claims: [
        { field: "assessment", claimType: "DIAGNOSIS", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 },
        { field: "treatment", claimType: "COMPLETED_TREATMENT", value: "Physical therapy recommended", excerpt: "Plan: recommend physical therapy", page: 1 },
      ],
    });
    expect(encounterContentHash(altered)).not.toBe(encounterContentHash(base()));
  });

  it("changes when the date, provider or summary changes", () => {
    expect(encounterContentHash(base({ encounterDate: "2025-03-15" }))).not.toBe(encounterContentHash(base()));
    expect(encounterContentHash(base({ provider: "Someone Else, MD" }))).not.toBe(encounterContentHash(base()));
    expect(encounterContentHash(base({ factualSummary: "Clinic visit — something else." }))).not.toBe(encounterContentHash(base()));
  });

  it("changes when a claim's PAGE citation changes", () => {
    const altered = base({
      claims: [
        { field: "assessment", claimType: "DIAGNOSIS", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 7 },
        { field: "treatment", claimType: "RECOMMENDED_TREATMENT", value: "Physical therapy recommended", excerpt: "Plan: recommend physical therapy", page: 1 },
      ],
    });
    expect(encounterContentHash(altered)).not.toBe(encounterContentHash(base()));
  });
});

describe("verification drift", () => {
  it("no drift when verified content is unchanged", () => {
    const e = { ...base(), status: "VERIFIED", verifiedContentHash: encounterContentHash(base()) };
    expect(detectVerificationDrift([e])).toEqual({ drifted: false, changed: 0, unhashed: 0 });
  });

  it("detects content changed after verification", () => {
    const e = { ...base({ factualSummary: "Edited after verification." }), status: "VERIFIED", verifiedContentHash: encounterContentHash(base()) };
    const d = detectVerificationDrift([e]);
    expect(d.drifted).toBe(true);
    expect(d.changed).toBe(1);
  });

  it("a legacy verified row with no hash blocks a final export without claiming drift", () => {
    const e = { ...base(), status: "VERIFIED", verifiedContentHash: null };
    const d = detectVerificationDrift([e]);
    expect(d.drifted).toBe(true);
    expect(d.unhashed).toBe(1);
    expect(d.changed).toBe(0);
  });

  it("unverified rows are not drift — they are simply not verified", () => {
    const e = { ...base(), status: "AI_DRAFT", verifiedContentHash: null };
    expect(detectVerificationDrift([e])).toEqual({ drifted: false, changed: 0, unhashed: 0 });
  });
});
