// Both readings, in terms a clinician can judge.
//
// The reconciliation panel showed two hashes under the labels "Basis on file"
// and "Record derives now", and the test that was supposed to catch that only
// regex-matched the two labels — a false positive by construction. A hash is an
// identity, not a reading. Asking a physician to sign one is asking for a
// signature, not an opinion.
//
// These tests exercise the returned DATA.

import { describe, it, expect } from "vitest";
import { snapshotOf, snapshotDifferences } from "@/lib/engine/basisReconciliation";
import { assembleBasis } from "@/lib/engine/basisAssembly";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const KASE: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
const CONDITION = {
  id: "c-1",
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss" }],
} as unknown as DossierCondition & { id: string };
const CHRONO: DossierChronoEvent[] = [
  { eventDate: "2024-08-01", imagingFindings: "MRI of the right knee: high-grade chondral loss", sourcePage: 4 } as never,
];
const ITEM = {
  id: "i-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", specialty: "Orthopedic surgery",
  probability: "PROBABLE", frequencyPerYear: 1, durationYears: null, isLifetime: false,
  unitCost: 42000, lifetimeCost: 42000, presentValue: 38000, cptCode: "27447",
  physicianStatus: "APPROVED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1",
  pricingSource: "CMS fee schedule", contingencyOnly: false,
  startTrigger: null, prerequisite: null, earliestTiming: null, replacesService: null,
};
const ASSUMPTIONS = { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1.04, pricedAt: "2026-01-15T00:00:00.000Z", conditionName: CONDITION.name };

const basisFor = (over: Record<string, unknown> = {}) => {
  const it = { ...ITEM, ...over };
  return assembleBasis({
    item: it as never,
    dossier: buildRecommendationDossier(it as never, CONDITION, CHRONO, KASE),
    conditions: [CONDITION as never],
    chronology: CHRONO,
    kase: KASE,
    assumptions: ASSUMPTIONS,
  });
};

describe("a snapshot carries clinical values, not an identity", () => {
  const snap = snapshotOf(basisFor() as never)!;

  it("names the recommendation, diagnosis and specialty", () => {
    expect(snap.service).toBe("Total knee arthroplasty");
    expect(snap.supportingDiagnosis).toBe(CONDITION.name);
    expect(snap.responsibleSpecialty).toBe("Orthopedic surgery");
  });

  it("carries the specification a reviewer would compare", () => {
    expect(snap.frequencyText).toBeTruthy();
    expect(snap.durationText).toBeTruthy();
    expect(snap.cptCode).toBe("27447");
    expect(snap.unitCost).toBe(42000);
    expect(snap.presentValue).toBe(38000);
    expect(snap.physicianStatus).toBe("APPROVED");
  });

  it("carries the necessity narrative and the probability determination", () => {
    expect(snap.necessityNarrative && snap.necessityNarrative.length).toBeGreaterThan(40);
    expect(snap.probabilityClassification).toBeTruthy();
    expect(snap.probabilityStatement).toBeTruthy();
  });

  it("carries the material assessment conclusions", () => {
    expect(snap.evidenceStrength).toBeTruthy();
    expect(snap.recommendationConfidence).toBeTruthy();
    expect(snap.inclusionRationale).toBeTruthy();
  });

  it("summarises the accepted evidence by count rather than reprinting it", () => {
    // The panel is a comparison, not a second report.
    expect(snap.acceptedEvidenceCounts).toMatchObject({
      diagnoses: expect.any(Number),
      objectiveFindings: expect.any(Number),
      functionalLimitations: expect.any(Number),
      priorTreatment: expect.any(Number),
      guidelines: expect.any(Number),
    });
  });

  it("keeps the hash, as secondary metadata", () => {
    expect(snap.basisHash).toMatch(/^basis-1:/);
  });

  it("leaks nothing beyond this recommendation", () => {
    // The patient's own name may appear inside their own necessity narrative —
    // the reviewer is already looking at this case, so that is not unrelated
    // data. What must not appear is another RECOMMENDATION's values, or any
    // field outside the declared shape.
    const other = snapshotOf(basisFor({ id: "i-2", service: "OTHER-ITEM-SERVICE", cptCode: "99999" }) as never)!;
    expect(other.service).toBe("OTHER-ITEM-SERVICE"); // the fixture really differs
    const blob = JSON.stringify(snap);
    expect(blob).not.toContain("OTHER-ITEM-SERVICE");
    expect(blob).not.toContain("99999");
    expect(Object.keys(snap).sort()).toEqual([
      "acceptedEvidenceCounts", "basisHash", "contradictions", "cptCode", "durationText",
      "evidenceStrength", "frequencyText", "inclusionRationale", "lifetimeQuantity",
      "missingPremises", "necessityNarrative", "physicianStatus", "presentValue",
      "probabilityClassification", "probabilityStatement", "recommendationConfidence",
      "responsibleSpecialty", "service", "supportingDiagnosis", "unitCost",
    ]);
  });

  it("is null when there is nothing on that side", () => {
    expect(snapshotOf(null)).toBeNull();
  });
});

describe("A and B are distinguishable, field by field", () => {
  it("reports exactly what moved and nothing that did not", () => {
    const a = snapshotOf(basisFor() as never);
    const b = snapshotOf(basisFor({ unitCost: 99000, cptCode: "27486", physicianStatus: "PENDING" }) as never);
    const diffs = snapshotDifferences(a, b);
    const fields = diffs.map((d) => d.field).sort();
    expect(fields).toContain("unitCost");
    expect(fields).toContain("cptCode");
    expect(fields).toContain("physicianStatus");
    // Untouched fields are absent.
    expect(fields).not.toContain("service");
    expect(fields).not.toContain("supportingDiagnosis");
  });

  it("shows the approved value AND the current one for each difference", () => {
    const a = snapshotOf(basisFor() as never);
    const b = snapshotOf(basisFor({ unitCost: 99000 }) as never);
    const d = snapshotDifferences(a, b).find((x) => x.field === "unitCost")!;
    expect(d.recorded).toBe("42000");
    expect(d.current).toBe("99000");
  });

  it("says 'not recorded' rather than blank for an absent value", () => {
    const a = snapshotOf({ ...(basisFor() as never as object), specification: { ...(basisFor().specification as object), cptCode: null } } as never);
    const b = snapshotOf(basisFor() as never);
    const d = snapshotDifferences(a, b).find((x) => x.field === "cptCode")!;
    expect(d.recorded).toBe("not recorded");
    expect(d.current).toBe("27447");
  });

  it("is empty when the two readings agree", () => {
    expect(snapshotDifferences(snapshotOf(basisFor() as never), snapshotOf(basisFor() as never))).toEqual([]);
  });

  it("returns nothing when either side is missing", () => {
    expect(snapshotDifferences(null, snapshotOf(basisFor() as never))).toEqual([]);
    expect(snapshotDifferences(snapshotOf(basisFor() as never), null)).toEqual([]);
  });
});

describe("the endpoint and the panel carry them through", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    return readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");
  };

  it("the divergences route returns the detailed form", async () => {
    const src = await read("src/app/api/cases/[caseId]/basis/divergences/route.ts");
    expect(src).toMatch(/basisDivergencesDetailed\(/);
    expect(src).not.toMatch(/await basisDivergences\(/);
  });

  it("the panel renders clinical rows, and the hash only as small metadata", async () => {
    const src = await read("src/components/case/CaseWorkspace.tsx");
    const panel = src.slice(src.indexOf("function BasisSnapshotPanel"), src.indexOf("Reconcile one stale recorded basis"));
    for (const label of ["Recommendation", "Diagnosis", "Frequency", "Duration", "CPT", "Unit cost", "Present value", "Probability", "Evidence strength", "Confidence", "Accepted evidence"]) {
      expect(panel, label).toContain(`"${label}"`);
    }
    expect(panel).toMatch(/text-\[10px\] text-ink-400/); // the hash line, de-emphasised
  });

  it("submission still carries the exact hashes, so stale-tab protection survives", async () => {
    const src = await read("src/components/case/CaseWorkspace.tsx");
    expect(src).toMatch(/recordedHash: mine\.recordedHash/);
    expect(src).toMatch(/derivedHash: mine\.derivedHash/);
    expect(await read("src/app/api/cases/[caseId]/basis/reconcile/route.ts")).toMatch(/STALE_VIEW/);
  });
});
