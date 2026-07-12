import { describe, it, expect } from "vitest";
import { buildSnapshotPayload, diffSnapshots, type SnapshotPayload } from "./snapshot";

const assumptions = { lifeExpectancyYears: 35, discountRate: 0.03, medicalInflation: 0.032, geographicFactor: 1 };

function snap(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    documents: [{ id: "d1", filename: "er.pdf", type: "ER_RECORD" }],
    chronology: [{ date: "2024-06-08", provider: "Dr. A", summary: "ER visit" }],
    conditions: [{ name: "L1 burst fracture", relatedness: "RELATED" }],
    items: [
      { service: "Pain visits", category: "PAIN_MANAGEMENT", cptCode: "99204", probability: "PROBABLE", frequencyPerYear: 4, durationYears: null, isLifetime: true, unitCost: 360, lifetimeCost: 90000, presentValue: 60000, pricingSource: "UCR", physicianStatus: "PENDING", literature: ["ESI cohort"] },
    ],
    assumptions,
    totals: { lifetime: 90000, presentValue: 60000 },
    ...overrides,
  };
}

describe("diffSnapshots", () => {
  it("reports records, diagnoses, and items added/removed", () => {
    const b = snap({
      documents: [{ id: "d1", filename: "er.pdf", type: "ER_RECORD" }, { id: "d2", filename: "mri.pdf", type: "IMAGING_REPORT" }],
      conditions: [{ name: "L1 burst fracture", relatedness: "RELATED" }, { name: "Neurogenic bladder", relatedness: "RELATED" }],
      items: [...snap().items, { ...snap().items[0], service: "Urology follow-up" }],
    });
    const d = diffSnapshots(snap(), b);
    expect(d.recordsAdded).toEqual(["mri.pdf"]);
    expect(d.recordsRemoved).toEqual([]);
    expect(d.diagnosesAdded).toEqual(["Neurogenic bladder"]);
    expect(d.itemsAdded).toEqual(["Urology follow-up"]);
  });

  it("reports frequency, code, pricing, review, and literature changes per item", () => {
    const b = snap({
      items: [{ ...snap().items[0], frequencyPerYear: 6, cptCode: "99214", pricingSource: "FAIR Health", physicianStatus: "APPROVED", literature: ["ESI cohort", "New RCT"] }],
      totals: { lifetime: 120000, presentValue: 80000 },
    });
    const d = diffSnapshots(snap(), b);
    const fields = d.fieldChanges.map((f) => f.field).sort();
    expect(fields).toEqual(["cptCode", "frequencyPerYear", "pricingSource"]);
    expect(d.reviewChanges).toEqual([{ service: "Pain visits", from: "PENDING", to: "APPROVED" }]);
    expect(d.literatureChanges[0].added).toEqual(["New RCT"]);
    expect(d.totalChange).toEqual({ lifetimeFrom: 90000, lifetimeTo: 120000, pvFrom: 60000, pvTo: 80000 });
  });

  it("reports assumption changes", () => {
    const b = snap({ assumptions: { ...assumptions, discountRate: 0.04 } });
    const d = diffSnapshots(snap(), b);
    expect(d.assumptionChanges).toEqual([{ field: "discountRate", from: 0.03, to: 0.04 }]);
  });

  it("is empty for identical snapshots (recalculation reproducibility)", () => {
    const d = diffSnapshots(snap(), snap());
    expect(d.fieldChanges).toEqual([]);
    expect(d.itemsAdded).toEqual([]);
    expect(d.assumptionChanges).toEqual([]);
  });
});

describe("buildSnapshotPayload", () => {
  it("excludes superseded items and captures citation titles", () => {
    const payload = buildSnapshotPayload(
      {
        documents: [], chronologyEvents: [], conditions: [],
        futureCareItems: [
          { service: "Current", category: "X", cptCode: null, probability: "PROBABLE", frequencyPerYear: 1, durationYears: 1, isLifetime: false, unitCost: 1, lifetimeCost: 1, presentValue: 1, pricingSource: null, physicianStatus: "PENDING", citation: [{ title: "T1" }], supersededAt: null },
          { service: "Old", category: "X", cptCode: null, probability: "PROBABLE", frequencyPerYear: 1, durationYears: 1, isLifetime: false, unitCost: 1, lifetimeCost: 1, presentValue: 1, pricingSource: null, physicianStatus: "APPROVED", citation: null, supersededAt: new Date() },
        ],
      },
      assumptions,
      { lifetime: 1, presentValue: 1 },
    );
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].literature).toEqual(["T1"]);
  });
});
