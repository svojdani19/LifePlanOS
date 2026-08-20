import { describe, it, expect } from "vitest";
import { buildBasis, basisHash, compareBasis, BASIS_VERSION } from "@/lib/engine/recommendationBasis";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const kase: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
const condition: DossierCondition = {
  id: "c-1",
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss, medial femoral condyle" }],
};
const chronology: DossierChronoEvent[] = [
  { eventDate: "2024-07-15", provider: "PT", functionalStatus: "Antalgic gait; stair negotiation limited to one flight", sourcePage: 5 },
  { eventDate: "2024-08-01", imagingFindings: "MRI: high-grade chondral loss of the medial knee compartment", sourcePage: 4 },
];
const item = {
  id: "i-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY",
  probability: "PROBABLE", frequencyPerYear: 1, isLifetime: false, unitCost: 42000, presentValue: 38000,
  physicianStatus: "PENDING", origin: "RECORD_RECOMMENDED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1",
};
const basisOf = (over: Record<string, unknown> = {}) => {
  const it = { ...item, ...over };
  return buildBasis(it as never, buildRecommendationDossier(it as never, condition, chronology, kase));
};

describe("one basis, computed once", () => {
  it("captures the intervention identity, anatomy and classification", () => {
    const b = basisOf();
    expect(b.interventionId).toBe("ARTHROPLASTY");
    expect(b.serviceFamily).toBe("SURGERY");
    expect(b.bodyRegion).toBe("knee");
    expect(b.supportClass).toBe("RECORD_RECOMMENDED");
    expect(b.necessityNarrative.length).toBeGreaterThan(80);
    expect(b.producerVersion).toBe(BASIS_VERSION);
  });

  it("accepts only ITEM-scoped evidence as support", () => {
    // Condition background is shown on the panel and is not what the
    // recommendation rests on.
    const b = basisOf();
    const blob = JSON.stringify(b.acceptedEvidence);
    expect(blob).not.toContain("causation analysis");
  });
});

describe("the hash decides staleness, and decides it on the right things", () => {
  it("is stable across identical rebuilds", () => {
    expect(basisOf().basisHash).toBe(basisOf().basisHash);
  });

  it("changes when the accepted evidence changes", () => {
    const before = basisOf();
    const after = buildBasis(item as never, buildRecommendationDossier(
      item as never, condition,
      // Names the knee so it passes the pertinence and anatomy gates — the
      // point under test is the hash, not the gates.
      [...chronology, { eventDate: "2024-09-02", imagingFindings: "MRI of the right knee: full-thickness cartilage defect of the lateral femoral condyle", sourcePage: 6 }],
      kase,
    ));
    expect(after.basisHash).not.toBe(before.basisHash);
  });

  it("changes when the support classification changes", () => {
    expect(basisOf({ supportClass: "PROFESSIONALLY_ADOPTED" }).basisHash).not.toBe(basisOf().basisHash);
  });

  it("is NOT changed by the narrative alone", () => {
    // A wording change must not stale every basis in the system; a change to
    // the evidence must stale exactly the ones affected.
    const b = basisOf();
    const reworded = { ...b, necessityNarrative: "Entirely different prose about the same evidence." };
    const core = {
      futureCareItemId: reworded.futureCareItemId, lineageId: reworded.lineageId, interventionId: reworded.interventionId,
      serviceFamily: reworded.serviceFamily, conditionId: reworded.conditionId, bodyRegion: reworded.bodyRegion,
      spinalLevels: reworded.spinalLevels, laterality: reworded.laterality, supportClass: reworded.supportClass,
      supportReason: reworded.supportReason, acceptedEvidence: reworded.acceptedEvidence, missingPremises: reworded.missingPremises,
    };
    expect(basisHash(core)).toBe(b.basisHash);
  });

  it("is order-independent, so re-persisting is not a change", () => {
    const b = basisOf();
    const shuffled = {
      futureCareItemId: b.futureCareItemId, lineageId: b.lineageId, interventionId: b.interventionId,
      serviceFamily: b.serviceFamily, conditionId: b.conditionId, bodyRegion: b.bodyRegion,
      spinalLevels: [...b.spinalLevels].reverse(), laterality: b.laterality, supportClass: b.supportClass,
      supportReason: b.supportReason,
      acceptedEvidence: { ...b.acceptedEvidence, objectiveFindings: [...b.acceptedEvidence.objectiveFindings].reverse() },
      missingPremises: [...b.missingPremises].reverse(),
    };
    expect(basisHash(shuffled)).toBe(b.basisHash);
  });
});

describe("a divergence is disclosed, never resolved", () => {
  it("reports MISSING when nothing was recorded", () => {
    const c = compareBasis(null, basisOf());
    expect(c.state).toBe("MISSING");
    expect(c.notice).toMatch(/No basis has been recorded/);
  });

  it("reports CURRENT when they agree, and says nothing", () => {
    const b = basisOf();
    const c = compareBasis({ basisHash: b.basisHash }, b);
    expect(c.state).toBe("CURRENT");
    expect(c.notice).toBeNull();
  });

  it("reports STALE without preferring either side", () => {
    const c = compareBasis({ basisHash: "basis-1:something-else" }, basisOf());
    expect(c.state).toBe("STALE");
    // The RECORDED basis is what is shown; the reader is told, and decides.
    expect(c.notice).toMatch(/recorded basis is shown/i);
    expect(c.notice).not.toMatch(/automatically|resolved for you/i);
  });
});
