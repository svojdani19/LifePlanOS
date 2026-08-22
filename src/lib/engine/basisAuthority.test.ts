// The recorded basis is what the plan asserts.
//
// Two defects motivate this file. The report built its specification table from
// the LIVE item at export time and printed it beside a recorded narrative — each
// half internally consistent, the document as a whole asserting a combination
// that had never existed. And assessmentFromBasis delegated to a builder that
// derived every conclusion from the current record, so the panel and the report
// displayed re-derived conclusions under an identity claiming to certify
// recorded ones.
//
// Synthetic fixtures only — no PHI.

import { describe, it, expect } from "vitest";
import { basisHash, hashableCore, compareBasis, type BasisRecord } from "@/lib/engine/recommendationBasis";
import { assembleBasis, materialFrom } from "@/lib/engine/basisAssembly";
import { assessmentFromBasis, deriveWitnessAssessment, type ReasoningItem } from "@/lib/engine/clinicalReasoning";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const kase: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
const condition = {
  id: "c-1",
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss, medial femoral condyle" }],
} as unknown as DossierCondition & { id: string };
const chronology: DossierChronoEvent[] = [
  { eventDate: "2024-07-15", provider: "PT", functionalStatus: "Antalgic gait; stair negotiation limited to one flight", sourcePage: 5 } as never,
  { eventDate: "2024-08-01", imagingFindings: "MRI: high-grade chondral loss of the medial knee compartment", sourcePage: 4 } as never,
];
const ITEM = {
  id: "i-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", specialty: "Orthopedic surgery",
  probability: "PROBABLE", frequencyPerYear: 1, durationYears: null, isLifetime: false,
  unitCost: 42000, lifetimeCost: 42000, presentValue: 38000, cptCode: "27447",
  physicianStatus: "APPROVED", origin: "RECORD_RECOMMENDED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1",
  pricingSource: "CMS fee schedule", contingencyOnly: false,
  startTrigger: null, prerequisite: null, earliestTiming: null, replacesService: null,
};
const ASSUMPTIONS = {
  lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1.04,
  pricedAt: "2026-01-15T00:00:00.000Z", conditionName: condition.name,
};

const basisOf = (itemOver: Record<string, unknown> = {}, assumeOver: Record<string, unknown> = {}): BasisRecord => {
  const it = { ...ITEM, ...itemOver };
  return assembleBasis({
    item: it as never,
    dossier: buildRecommendationDossier(it as never, condition, chronology, kase),
    conditions: [condition as never],
    chronology,
    kase,
    assumptions: { ...ASSUMPTIONS, ...assumeOver },
  });
};

describe("every material projection input moves the hash", () => {
  const base = basisOf();

  // Each of these changes what the plan claims about quantity, duration or
  // money. A basis that stayed CURRENT across any of them would let a plan be
  // approved on one set of numbers and exported on another.
  const ITEM_MUTATIONS: [string, Record<string, unknown>][] = [
    ["frequency", { frequencyPerYear: 4 }],
    ["duration in years", { durationYears: 7 }],
    ["lifetime status", { isLifetime: true }],
    ["unit cost", { unitCost: 51000 }],
    ["pricing source identity", { pricingSource: "FAIR Health benchmark" }],
    ["lifetime cost", { lifetimeCost: 90000 }],
    ["present value", { presentValue: 41000 }],
    ["CPT code", { cptCode: "27486" }],
    ["specialty", { specialty: "Physical medicine and rehabilitation" }],
    ["physician review status", { physicianStatus: "PENDING" }],
    ["contingency-only disclosure", { contingencyOnly: true }],
    ["start trigger", { startTrigger: "progression to end-stage collapse" }],
    ["prerequisite", { prerequisite: "completion of conservative care" }],
    ["earliest timing", { earliestTiming: "no earlier than 2029" }],
    ["replaced service", { replacesService: "Unicompartmental knee replacement" }],
  ];

  it.each(ITEM_MUTATIONS)("changing the %s stales the basis", (_label, over) => {
    const after = basisOf(over);
    expect(after.basisHash).not.toBe(base.basisHash);
    expect(compareBasis({ basisHash: base.basisHash }, after).state).toBe("STALE");
  });

  const ASSUMPTION_MUTATIONS: [string, Record<string, unknown>][] = [
    ["discount rate", { discountRate: 0.05 }],
    ["medical inflation", { medicalInflation: 0.04 }],
    ["geographic factor", { geographicFactor: 1.22 }],
    ["pricing date", { pricedAt: "2026-06-01T00:00:00.000Z" }],
  ];

  it.each(ASSUMPTION_MUTATIONS)("changing the %s stales the basis", (_label, over) => {
    const after = basisOf({}, over);
    expect(after.basisHash).not.toBe(base.basisHash);
    expect(compareBasis({ basisHash: base.basisHash }, after).state).toBe("STALE");
  });

  it("changing the projection HORIZON stales a lifetime item", () => {
    // Life expectancy is only a projection input when the item is lifetime, so
    // the mutation has to be applied to an item where it can bite.
    const lifeBase = basisOf({ isLifetime: true });
    const longer = basisOf({ isLifetime: true }, { lifeExpectancyYears: 42 });
    expect(longer.basisHash).not.toBe(lifeBase.basisHash);
  });

  it("re-deriving an unchanged item is CURRENT — the gate is not simply always-stale", () => {
    expect(compareBasis({ basisHash: base.basisHash }, basisOf()).state).toBe("CURRENT");
  });
});

describe("the specification table is recorded, not re-derived at export", () => {
  it("records every row the exported grid prints", () => {
    const s = basisOf().specification;
    expect(s).toMatchObject({
      service: "Total knee arthroplasty",
      supportingDiagnosis: condition.name,
      responsibleSpecialty: "Orthopedic surgery",
      cptCode: "27447",
      unitCost: 42000,
      lifetimeCost: 42000,
      presentValue: 38000,
      physicianStatus: "APPROVED",
      contingencyOnly: false,
    });
    expect(s.frequencyText).toBeTruthy();
    expect(s.durationText).toBeTruthy();
  });

  it("computes the lifetime quantity from the recorded frequency and horizon", () => {
    expect(basisOf({ isLifetime: true, frequencyPerYear: 2 }).specification.lifetimeQuantity).toBe(60); // 2 × 30 yrs
    expect(basisOf().specification.lifetimeQuantity).toBe(1); // one-time
  });

  it("carries the support flag the review label is printed from", () => {
    expect(basisOf().specification.recordSupported).toBe(true);
    expect(basisOf({ supportClass: "CANDIDATE_REVIEW" }).specification.recordSupported).toBe(false);
  });
});

describe("an approved recommendation prints what was approved", () => {
  it("keeps the recorded values when the live row is changed afterwards", () => {
    // The scenario the report used to get wrong: a plan is approved, someone
    // edits frequency and price, and the document prints the new numbers under
    // the old narrative with nothing to warn the reader.
    const approved = basisOf();
    const recorded = approved.specification;

    // The mutable row moves.
    const afterEdit = basisOf({ frequencyPerYear: 6, unitCost: 99000, presentValue: 250000 });

    // What was recorded is untouched — this is the object the report renders.
    expect(recorded.frequencyText).toBe(approved.specification.frequencyText);
    expect(recorded.unitCost).toBe(42000);
    expect(recorded.presentValue).toBe(38000);

    // And the divergence is loud: STALE, which is an export-blocking finding.
    const cmp = compareBasis({ basisHash: approved.basisHash }, afterEdit);
    expect(cmp.state).toBe("STALE");
    expect(cmp.notice).toMatch(/recorded basis is shown/i);
  });

  it("a missing basis is MISSING, never silently the current values", () => {
    const cmp = compareBasis(null, basisOf());
    expect(cmp.state).toBe("MISSING");
    expect(cmp.notice).toMatch(/no basis has been recorded/i);
  });
});

describe("the material assessment is recorded and read back", () => {
  it("records the conclusions the panel and report display", () => {
    const m = basisOf().assessmentBasis!;
    expect(m).not.toBeNull();
    expect(m.probabilityClassification).toBeTruthy();
    expect(m.inclusionRationale).toBeTruthy();
    expect(m.evidenceStrength).toBeTruthy();
    expect(m.recommendationConfidence).toBeTruthy();
    expect(m.confidenceLevel).toBeTruthy();
    expect(typeof m.frequencySupported).toBe("boolean");
    expect(typeof m.durationSupported).toBe("boolean");
  });

  it("reads every displayed conclusion back OUT of the record, not off the item", () => {
    const b = basisOf();
    // Overwrite the recorded conclusions with values no derivation would ever
    // produce. If the reader re-derives, these cannot survive.
    const doctored: BasisRecord = {
      ...b,
      assessmentBasis: {
        ...b.assessmentBasis!,
        inclusionRationale: "RECORDED-ONLY-SENTINEL",
        residualUncertainty: "RECORDED-UNCERTAINTY-SENTINEL",
        confidenceExplanation: "RECORDED-CONFIDENCE-SENTINEL",
        medicalNecessityRationale: "RECORDED-NECESSITY-SENTINEL",
      },
    };
    const a = assessmentFromBasis(doctored)!;
    expect(a.inclusionRationale).toBe("RECORDED-ONLY-SENTINEL");
    expect(a.residualUncertainty).toBe("RECORDED-UNCERTAINTY-SENTINEL");
    expect(a.confidenceExplanation).toBe("RECORDED-CONFIDENCE-SENTINEL");
    expect(a.medicalNecessityRationale).toBe("RECORDED-NECESSITY-SENTINEL");
  });

  it("takes its identity from the record, so re-reading cannot move it", () => {
    const b = basisOf();
    expect(assessmentFromBasis(b)!.materialHash).toBe(b.basisHash);
    expect(assessmentFromBasis(b)!.materialHash).toBe(assessmentFromBasis(b)!.materialHash);
  });

  it("refuses rather than reconstructing when the record cannot support it", () => {
    // A basis written before the material conclusions existed. Returning a
    // plausible reconstruction here is exactly the behaviour being removed.
    const legacy: BasisRecord = { ...basisOf(), assessmentBasis: null };
    expect(assessmentFromBasis(legacy)).toBeNull();
  });

  it("keeps live workflow state live, and does not freeze it into the record", () => {
    const b = basisOf();
    const a = assessmentFromBasis(b, {
      conflictFlags: [{ type: "ALTERNATIVE_BOTH_INCLUDED", otherService: "Unicompartmental knee replacement" } as never],
      physicianReviewStatus: "PENDING",
    })!;
    expect(a.conflictFlags).toHaveLength(1);
    expect(a.physicianReviewStatus).toBe("PENDING");
    // And never claims to have been re-validated just because it was read.
    expect(a.lifecycleStatus).toBe("NEEDS_REVIEW");
  });

  it("a changed material conclusion stales the basis", () => {
    const b = basisOf();
    const doctored = { ...hashableCore(b), assessmentBasis: { ...b.assessmentBasis!, inclusionRationale: "something else entirely" } };
    expect(basisHash(doctored)).not.toBe(b.basisHash);
  });
});

describe("the witness stays a witness", () => {
  it("derives from the current record and is offered no basis", () => {
    const witness = deriveWitnessAssessment(ITEM as unknown as ReasoningItem, [condition as never], chronology, kase);
    expect(witness.recommendationService).toBe("Total knee arthroplasty");
    // Its identity is its own, never a recorded hash.
    expect(witness.materialHash).not.toBe(basisOf().basisHash);
  });

  it("materialFrom carries conclusions but not live workflow state", () => {
    const witness = deriveWitnessAssessment(ITEM as unknown as ReasoningItem, [condition as never], chronology, kase);
    const m = materialFrom(witness, buildRecommendationDossier(ITEM as never, condition, chronology, kase));
    expect(m).not.toHaveProperty("conflictFlags");
    expect(m).not.toHaveProperty("validationStatus");
    expect(m).not.toHaveProperty("lifecycleStatus");
    expect(m).not.toHaveProperty("physicianReviewStatus");
  });
});
