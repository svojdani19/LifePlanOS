import { describe, it, expect } from "vitest";
import {
  buildAttestationScope,
  attestationStatement,
  attestationContentHash,
  verifyAttestation,
  type AttestableItem,
} from "./attestation";

const item = (over: Partial<AttestableItem> = {}): AttestableItem => ({
  id: "i1",
  lineageId: "L1",
  version: 1,
  service: "Pain management office visits",
  category: "PAIN_MANAGEMENT",
  probability: "PROBABLE",
  frequencyPerYear: 12,
  durationYears: null,
  isLifetime: true,
  unitCost: 360,
  presentValue: 42_000,
  physicianStatus: "APPROVED",
  supersededAt: null,
  ...over,
});

describe("buildAttestationScope", () => {
  it("covers only current, physician-acted items — never pending or rejected", () => {
    const scope = buildAttestationScope([
      item(),
      item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED" }),
      item({ id: "i3", lineageId: "L3", service: "Future surgery", physicianStatus: "PENDING" }),
      item({ id: "i4", lineageId: "L4", service: "Injections", physicianStatus: "REJECTED" }),
      item({ id: "i5", lineageId: "L5", service: "Old version", supersededAt: new Date() }),
    ]);
    expect(scope.map((s) => s.lineageId).sort()).toEqual(["L1", "L2"]);
  });
});

describe("attestationStatement", () => {
  const scope = buildAttestationScope([item(), item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED" })]);

  it("states the counts it actually covers, discloses modifications, and pins the versions", () => {
    const s = attestationStatement({ physicianName: "Sam Okafor, MD", credentialSummary: "board certified in PM&R", clientName: "David Chen", caseNumber: "LCP-2026-0001", scope, totalPresentValue: 84_000 });
    expect(s).toContain("Sam Okafor, MD");
    expect(s).toContain("board certified in PM&R");
    expect(s).toContain("2 recommendations");
    expect(s).toContain("1 approved as proposed and 1 approved as modified");
    expect(s).toContain("$84,000");
    expect(s).toContain("invalidates this attestation");
  });

  it("never claims coverage of the whole plan — only the itemized scope", () => {
    const s = attestationStatement({ physicianName: "X", credentialSummary: null, clientName: "C", caseNumber: "N", scope, totalPresentValue: 1 });
    expect(s).toContain("covered by this attestation");
    expect(s.toLowerCase()).not.toContain("all recommendations");
  });
});

describe("attestationContentHash", () => {
  it("is stable for identical content and changes when any material field changes", () => {
    const scope = buildAttestationScope([item()]);
    const h1 = attestationContentHash("stmt", scope);
    expect(attestationContentHash("stmt", buildAttestationScope([item()]))).toBe(h1);
    const bumped = buildAttestationScope([item({ frequencyPerYear: 13 })]);
    expect(attestationContentHash("stmt", bumped)).not.toBe(h1);
    expect(attestationContentHash("other stmt", scope)).not.toBe(h1);
  });
});

describe("verifyAttestation", () => {
  const signedScope = buildAttestationScope([item(), item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED", presentValue: 9_000 })]);

  it("holds while the covered items are materially unchanged", () => {
    const v = verifyAttestation(signedScope, [item(), item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED", presentValue: 9_000 })]);
    expect(v.valid).toBe(true);
    expect(v.drift).toHaveLength(0);
  });

  it("a material change to a covered item invalidates, naming the field", () => {
    const v = verifyAttestation(signedScope, [
      item({ id: "i1b", version: 2, frequencyPerYear: 24 }), // same lineage, new version, frequency doubled
      item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED", presentValue: 9_000 }),
    ]);
    expect(v.valid).toBe(false);
    expect(v.drift[0].reason).toContain("frequency");
  });

  it("a covered item vanishing or regressing to pending invalidates", () => {
    const gone = verifyAttestation(signedScope, [item()]); // L2 missing
    expect(gone.valid).toBe(false);
    expect(gone.drift[0].reason).toContain("no longer exists");

    const regressed = verifyAttestation(signedScope, [item(), item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "PENDING", presentValue: 9_000 })]);
    expect(regressed.valid).toBe(false);
    expect(regressed.drift[0].reason).toContain("regressed");
  });

  it("items ADDED after signing do not invalidate — they are simply not covered", () => {
    const v = verifyAttestation(signedScope, [
      item(),
      item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED", presentValue: 9_000 }),
      item({ id: "i9", lineageId: "L9", service: "New attendant care", physicianStatus: "PENDING", presentValue: 500_000 }),
    ]);
    expect(v.valid).toBe(true);
  });

  it("presentValue drift alone does not invalidate (it moves with assumption edits), but unit cost does", () => {
    const pvOnly = verifyAttestation(signedScope, [item({ presentValue: 55_000 }), item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED", presentValue: 12_000 })]);
    expect(pvOnly.valid).toBe(true);
    const unit = verifyAttestation(signedScope, [item({ unitCost: 500 }), item({ id: "i2", lineageId: "L2", service: "MRI surveillance", physicianStatus: "MODIFIED", presentValue: 9_000 })]);
    expect(unit.valid).toBe(false);
    expect(unit.drift[0].reason).toContain("unit cost");
  });
});
