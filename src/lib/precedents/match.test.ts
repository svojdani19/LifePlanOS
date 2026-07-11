import { describe, it, expect } from "vitest";
import { scorePrecedent, rankPrecedents } from "./match";

const spineCase = {
  injurySpecialty: "SPINE",
  icd10Code: "S32.010A",
  diagnosis: "L1 burst fracture with incomplete spinal cord injury",
  jurisdiction: "CA — Orange County",
  mechanism: "Motor vehicle collision",
  age: 46,
  careCategories: ["PHYSICIAN_VISIT", "PHYSICAL_THERAPY", "IMAGING", "INJECTION", "MEDICATION"],
  presentValue: 4_000_000,
};

describe("scorePrecedent", () => {
  it("gives a near-identical precedent a very high likeness", () => {
    const { likeness } = scorePrecedent(spineCase, { ...spineCase });
    expect(likeness).toBeGreaterThanOrEqual(95);
  });

  it("scores an unrelated case low", () => {
    const { likeness } = scorePrecedent(spineCase, {
      injurySpecialty: "AMPUTATION",
      icd10Code: "S88.112A",
      diagnosis: "transtibial amputation",
      jurisdiction: "NV — Clark County",
      mechanism: "Industrial machinery",
      age: 25,
      careCategories: ["ORTHOTICS_PROSTHETICS"],
      presentValue: 9_000_000,
    });
    expect(likeness).toBeLessThan(25);
  });

  it("awards full weight for a matching injury specialty", () => {
    const spec = scorePrecedent(spineCase, { injurySpecialty: "SPINE" }).factors.find((f) => f.label === "Injury specialty")!;
    expect(spec.got).toBe(spec.weight);
    expect(spec.got).toBe(25);
  });

  it("distinguishes exact vs category ICD-10 vs none", () => {
    const exact = scorePrecedent(spineCase, { icd10Code: "S32.010A" }).factors.find((f) => f.label === "ICD-10")!;
    const cat = scorePrecedent(spineCase, { icd10Code: "S32.999X" }).factors.find((f) => f.label === "ICD-10")!;
    const none = scorePrecedent(spineCase, { icd10Code: "M17.11" }).factors.find((f) => f.label === "ICD-10")!;
    expect(exact.got).toBe(20);
    expect(cat.got).toBe(12);
    expect(none.got).toBe(0);
  });

  it("scores same jurisdiction above same state above different", () => {
    const same = scorePrecedent(spineCase, { jurisdiction: "CA — Orange County" }).factors.find((f) => f.label === "Jurisdiction")!;
    const state = scorePrecedent(spineCase, { jurisdiction: "CA — Los Angeles County" }).factors.find((f) => f.label === "Jurisdiction")!;
    const diff = scorePrecedent(spineCase, { jurisdiction: "NV — Clark County" }).factors.find((f) => f.label === "Jurisdiction")!;
    expect(same.got).toBe(15);
    expect(state.got).toBe(8);
    expect(diff.got).toBe(0);
  });

  it("keeps likeness within 0–100", () => {
    const { likeness } = scorePrecedent(spineCase, {});
    expect(likeness).toBeGreaterThanOrEqual(0);
    expect(likeness).toBeLessThanOrEqual(100);
  });
});

describe("rankPrecedents", () => {
  it("sorts precedents by descending likeness", () => {
    const ranked = rankPrecedents(spineCase, [
      { id: "far", title: "TBI", injurySpecialty: "TBI", careCategories: [] },
      { id: "near", title: "Spine twin", ...spineCase },
      { id: "mid", title: "Other spine", injurySpecialty: "SPINE", icd10Code: "S32.020A", jurisdiction: "CA — San Diego County", careCategories: [] },
    ]);
    expect(ranked.map((p) => p.id)).toEqual(["near", "mid", "far"]);
    expect(ranked[0].match.likeness).toBeGreaterThan(ranked[1].match.likeness);
    expect(ranked[1].match.likeness).toBeGreaterThan(ranked[2].match.likeness);
  });
});
