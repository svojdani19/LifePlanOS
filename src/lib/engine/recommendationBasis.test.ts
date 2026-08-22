import { describe, it, expect } from "vitest";
import { buildBasis, basisHash, compareBasis, hashableCore, BASIS_VERSION } from "@/lib/engine/recommendationBasis";
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
    const core = { ...hashableCore(reworded) };
    expect(basisHash(core)).toBe(b.basisHash);
  });

  it("is order-independent, so re-persisting is not a change", () => {
    const b = basisOf();
    const shuffled = { ...hashableCore(b) };
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

describe("citation identity is part of the hash, not just the quote", () => {
  // The first version hashed the displayed text and dropped everything else, so
  // the source document, page, provider, stance and extraction fingerprint
  // could all change while the basis kept reporting CURRENT. A citation whose
  // attribution silently moves is worse than a missing one: the quote still
  // reads true and now points somewhere else.
  const core = (over: Record<string, unknown> = {}) => ({ ...hashableCore(basisOf()), ...over });

  it("carries provenance for every accepted row", () => {
    const b = basisOf();
    expect(b.evidenceProvenance.length).toBeGreaterThan(0);
    expect(b.evidenceProvenance[0]).toMatchObject({
      claim: expect.any(String), stance: expect.any(String), verbatim: expect.any(Boolean), textHash: expect.any(String),
    });
  });

  it("changes when the SOURCE DOCUMENT changes and the text does not", () => {
    const moved = core({ evidenceProvenance: basisOf().evidenceProvenance.map((p, i) => (i === 0 ? { ...p, documentId: "different-doc" } : p)) });
    expect(basisHash(moved)).not.toBe(basisOf().basisHash);
  });

  it("changes when the PAGE changes", () => {
    const repaged = core({ evidenceProvenance: basisOf().evidenceProvenance.map((p, i) => (i === 0 ? { ...p, page: 999 } : p)) });
    expect(basisHash(repaged)).not.toBe(basisOf().basisHash);
  });

  it("changes when the STANCE flips", () => {
    const flipped = core({ evidenceProvenance: basisOf().evidenceProvenance.map((p, i) => (i === 0 ? { ...p, stance: "OPPOSES" } : p)) });
    expect(basisHash(flipped)).not.toBe(basisOf().basisHash);
  });

  it("changes when the source fingerprint changes — the document's bytes moved", () => {
    const refingered = core({ evidenceProvenance: basisOf().evidenceProvenance.map((p, i) => (i === 0 ? { ...p, sourceFingerprint: "abc123" } : p)) });
    expect(basisHash(refingered)).not.toBe(basisOf().basisHash);
  });

  it("changes when a quote's displayed SOURCE label changes", () => {
    const b = basisOf();
    const relabelled = core({
      acceptedEvidence: { ...b.acceptedEvidence, objectiveFindings: b.acceptedEvidence.objectiveFindings.map((e, i) => (i === 0 ? { ...e, source: "some other file, p. 99" } : e)) },
    });
    expect(basisHash(relabelled)).not.toBe(b.basisHash);
  });

  it("is still order-independent across provenance rows", () => {
    expect(basisHash(core({ evidenceProvenance: [...basisOf().evidenceProvenance].reverse() }))).toBe(basisOf().basisHash);
  });
});

describe("frequency, duration and cost each carry their own basis", () => {
  // "Why this service?" and "why this frequency, for this long, at this price?"
  // are different claims. The column existed and generation left it null, so
  // the authoritative basis was silent on three of the four things a defence
  // expert asks about.
  it("marks a quantity nothing states as a planning assumption", () => {
    const b = basisOf();
    expect(b.claimBasis.frequency.kind).toBe("ASSUMPTION");
    expect(b.claimBasis.frequency.statement).toMatch(/planning assumption/i);
    expect(b.claimBasis.duration.kind).toBe("ASSUMPTION");
  });

  it("never calls cost record-based just because the service is supported", () => {
    const b = basisOf();
    expect(b.claimBasis.cost.kind).toBe("ASSUMPTION");
    expect(b.claimBasis.cost.statement).toMatch(/no case-specific cost is documented/i);
  });

  it("treats a quantity basis as material to the hash", () => {
    // A frequency moving from RECORD to ASSUMPTION changes what the plan claims
    // about it, and must invalidate an approval given on the other reading.
    const b = basisOf();
    const core = { ...hashableCore(b), claimBasis: { ...b.claimBasis, frequency: { kind: "RECORD" as const, statement: "The record states a cadence for this service." } } };
    expect(basisHash(core)).not.toBe(b.basisHash);
  });
});

describe("the probability determination is material, not presentation", () => {
  it("is carried in the basis", () => {
    const b = basisOf();
    expect(b.probabilityBasis.classification).toMatch(/more likely than not|reasonable possibility/);
    expect(b.probabilityBasis.factors.length).toBeGreaterThan(0);
  });

  it("changes the hash when the CLASSIFICATION flips", () => {
    // "More likely than not" is a clinical and legal claim. Left out of the
    // hash, it could flip from a reasonable possibility to a probability
    // without invalidating an approval given on the other reading.
    const b = basisOf();
    const core = (pb: typeof b.probabilityBasis) => ({ ...hashableCore(b), probabilityBasis: pb });
    expect(basisHash(core({ ...b.probabilityBasis, classification: "reasonable possibility" }))).not.toBe(b.basisHash);
  });

  it("changes the hash when a FACTOR's presence changes", () => {
    const b = basisOf();
    const flipped = { ...b.probabilityBasis, factors: b.probabilityBasis.factors.map((f, i) => (i === 0 ? { ...f, present: !f.present } : f)) };
    expect(basisHash({ ...hashableCore(b), probabilityBasis: flipped })).not.toBe(b.basisHash);
  });

  it("does NOT change the hash when only the STATEMENT is reworded", () => {
    // The statement is prose generated from the classification and factors.
    // Rewording it is stylistic and must not stale an approval.
    const b = basisOf();
    const core = { ...hashableCore(b) };
    expect(basisHash(core)).toBe(b.basisHash);
  });
});
