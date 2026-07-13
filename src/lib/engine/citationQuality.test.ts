import { describe, it, expect } from "vitest";
import {
  citationCompatible,
  evaluateArticle,
  evidenceTier,
  selectPrimary,
  structuredConfidence,
  validateEvidenceQuality,
  isManagementService,
  claimFor,
} from "./citationQuality";

// Clinical Evidence Sprint — every citation must be clinically appropriate,
// relevant, transparent, and defensible. Keyword overlap alone never qualifies.

describe("citationCompatible — hard display gate", () => {
  it("a knee arthroplasty article cannot appear under lumbar fusion", () => {
    const r = citationCompatible(
      { title: "Outcomes of total knee arthroplasty in osteoarthritis" },
      { diagnosis: "L1 burst fracture", service: "Lumbar fusion revision" },
    );
    expect(r.compatible).toBe(false);
    expect(r.reason).toMatch(/body-region mismatch/);
  });

  it("a rotator cuff article cannot appear under total hip arthroplasty", () => {
    const r = citationCompatible(
      { title: "Arthroscopic rotator cuff repair: five-year outcomes" },
      { diagnosis: "Hip osteoarthritis", service: "Total hip arthroplasty" },
    );
    expect(r.compatible).toBe(false);
  });

  it("a pediatric article cannot support an adult recommendation", () => {
    const r = citationCompatible(
      { title: "Management of congenital neurogenic bladder in children" },
      { diagnosis: "Neurogenic bladder", service: "Urology follow-up", adult: true },
    );
    expect(r.compatible).toBe(false);
    expect(r.reason).toMatch(/population/);
  });

  it("pediatric literature IS acceptable when the case is explicitly pediatric", () => {
    const r = citationCompatible(
      { title: "Management of pediatric neurogenic bladder" },
      { diagnosis: "Neurogenic bladder", service: "Urology follow-up", adult: false },
    );
    expect(r.compatible).toBe(true);
  });

  it("a procedure-family mismatch is rejected even in the same region (keyword overlap is not enough)", () => {
    const r = citationCompatible(
      { title: "Lumbar interbody fusion instrumentation outcomes" },
      { diagnosis: "Lumbar radiculopathy", service: "Lumbar transforaminal epidural steroid injection" },
    );
    expect(r.compatible).toBe(false);
    expect(r.reason).toMatch(/procedure mismatch/);
  });

  it("accepts a same-region, same-procedure, adult-population article", () => {
    const r = citationCompatible(
      { title: "Total knee arthroplasty survivorship in adults: registry analysis" },
      { diagnosis: "Post-traumatic knee osteoarthritis", service: "Total knee arthroplasty" },
    );
    expect(r.compatible).toBe(true);
  });
});

describe("recommendation-centric literature (Refactor Sprint)", () => {
  const officeVisits = { diagnosis: "Lumbar burst fracture", service: "Pain management office visits", adult: true };

  it("recognizes a management / office-visit recommendation", () => {
    expect(isManagementService("Pain management office visits")).toBe(true);
    expect(isManagementService("Physiatry (PM&R) management visits")).toBe(true);
    expect(isManagementService("Total knee arthroplasty")).toBe(false);
    expect(isManagementService("Lumbar transforaminal epidural steroid injection")).toBe(false);
  });

  it("pain management office visits cannot cite a lumbar fusion trial", () => {
    const r = citationCompatible({ title: "Lumbar interbody fusion for degenerative stenosis: a randomized controlled trial" }, officeVisits);
    expect(r.compatible).toBe(false);
    expect(r.reason).toMatch(/scope mismatch/);
  });

  it("pain management office visits cannot cite a peripheral nerve stimulation trial", () => {
    const r = citationCompatible({ title: "Percutaneous 60-day peripheral nerve stimulation of the lumbar medial branches: RCT" }, officeVisits);
    expect(r.compatible).toBe(false);
  });

  it("pain management office visits CAN cite management / follow-up literature", () => {
    expect(citationCompatible({ title: "Longitudinal management and follow-up frequency in chronic low back pain: a guideline" }, officeVisits).compatible).toBe(true);
    expect(citationCompatible({ title: "Conservative management of osteoporotic vertebral fracture: a prospective cohort" }, officeVisits).compatible).toBe(true);
  });

  it("a procedural recommendation still draws its own procedural literature", () => {
    const inj = { diagnosis: "Lumbar radiculopathy", service: "Lumbar transforaminal epidural steroid injection", adult: true };
    expect(citationCompatible({ title: "Transforaminal epidural steroid injection efficacy: a randomized trial" }, inj).compatible).toBe(true);
  });
});

describe("evaluateArticle — explicit relevance scoring", () => {
  const ctx = { diagnosis: "Post-traumatic knee osteoarthritis", service: "Total knee arthroplasty" };

  it("accepts an on-point guideline with a stored reason, claim, and score", () => {
    const r = evaluateArticle(
      { title: "Clinical practice guideline for total knee arthroplasty in osteoarthritis", year: "2024", citationCount: 200 },
      ctx,
    );
    expect(r.accepted).toBe(true);
    expect(r.evidenceLevel).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(45);
    expect(r.whyRelevant).toMatch(/guideline/i);
    expect(r.supports).toBe(claimFor(ctx.service, ctx.diagnosis));
  });

  it("rejects a keyword-only article (diagnosis and procedure both unaddressed)", () => {
    const r = evaluateArticle({ title: "Chronic pain management strategies in primary care", year: "2024" }, ctx);
    expect(r.accepted).toBe(false);
  });

  it("states limitations honestly for weak evidence", () => {
    const r = evaluateArticle({ title: "A case report of total knee arthroplasty after tibial plateau fracture", year: "2005" }, ctx);
    expect(r.evidenceLevel).toBe(10);
    expect(r.limitations).toMatch(/case report/i);
    expect(r.limitations).toMatch(/older literature/i);
  });
});

describe("literature hierarchy", () => {
  it("classifies the 10 tiers", () => {
    expect(evidenceTier("Clinical practice guideline for X").level).toBe(1);
    expect(evidenceTier("Expert consensus statement on X").level).toBe(2);
    expect(evidenceTier("A systematic review of X").level).toBe(3);
    expect(evidenceTier("Meta-analysis of X trials").level).toBe(4);
    expect(evidenceTier("A randomized controlled trial of X").level).toBe(5);
    expect(evidenceTier("Prospective evaluation of X").level).toBe(6);
    expect(evidenceTier("National registry survivorship of X").level).toBe(7);
    expect(evidenceTier("Retrospective cohort of X").level).toBe(8);
    expect(evidenceTier("Case series of X").level).toBe(9);
    expect(evidenceTier("A case report of X").level).toBe(10);
  });

  it("selectPrimary puts the strongest evidence first — weak evidence is never primary when stronger exists", () => {
    const cites = [
      { title: "case report", relevance: { evidenceLevel: 10, score: 90 } },
      { title: "guideline", relevance: { evidenceLevel: 1, score: 60 } },
      { title: "cohort", relevance: { evidenceLevel: 8, score: 80 } },
    ];
    const ordered = selectPrimary(cites);
    expect(ordered[0].title).toBe("guideline");
    expect(ordered[ordered.length - 1].title).toBe("case report");
  });
});

describe("validateEvidenceQuality — automated evidence validation", () => {
  it("flags an incompatible stored citation as Critical/export-blocking", () => {
    const f = validateEvidenceQuality(
      [{ service: "Lumbar fusion revision", condition: { name: "L1 burst fracture" }, citation: [{ title: "Total knee arthroplasty outcomes" }] }],
      true,
    );
    expect(f.some((x) => x.result === "Incompatible citation" && x.exportBlocking)).toBe(true);
  });

  it("flags weak evidence held as primary while stronger exists", () => {
    const f = validateEvidenceQuality(
      [{
        service: "Knee surveillance radiographs",
        condition: { name: "Knee osteoarthritis" },
        citation: [
          { title: "A case report of knee imaging", relevance: { evidenceLevel: 10 } },
          { title: "Knee imaging guideline", relevance: { evidenceLevel: 1 } },
        ],
      }],
      true,
    );
    expect(f.some((x) => x.result === "Weak primary citation")).toBe(true);
  });

  it("flags the same article reused across different body regions", () => {
    const f = validateEvidenceQuality(
      [
        { service: "Knee brace", condition: { name: "Knee osteoarthritis" }, citation: [{ title: "Bracing outcomes", pmid: "111" }] },
        { service: "Lumbar orthosis", condition: { name: "Lumbar fracture" }, citation: [{ title: "Bracing outcomes", pmid: "111" }] },
      ],
      true,
    );
    expect(f.some((x) => x.result === "Cross-region article reuse")).toBe(true);
  });

  it("does not flag legitimate same-region reuse", () => {
    const f = validateEvidenceQuality(
      [
        { service: "Knee injections", condition: { name: "Knee osteoarthritis" }, citation: [{ title: "Knee injection outcomes", pmid: "222" }] },
        { service: "Knee arthroplasty", condition: { name: "Post-traumatic knee arthritis" }, citation: [{ title: "Knee injection outcomes", pmid: "222" }] },
      ],
      true,
    );
    expect(f.some((x) => x.result === "Cross-region article reuse")).toBe(false);
  });
});

describe("structuredConfidence", () => {
  it("Very High: strong records + physician + guideline + objective + top-tier evidence", () => {
    const c = structuredConfidence({ recordEvidenceCount: 3, hasObjectiveFindings: true, physicianSupport: true, guidelineSupport: true, bestEvidenceLevel: 1, hasContradictoryEvidence: false, hasMissingInfo: false });
    expect(c.level).toBe("Very High");
  });
  it("High: solid support without the full top-tier stack", () => {
    const c = structuredConfidence({ recordEvidenceCount: 2, hasObjectiveFindings: true, physicianSupport: true, guidelineSupport: false, bestEvidenceLevel: 6, hasContradictoryEvidence: false, hasMissingInfo: false });
    expect(c.level).toBe("High");
  });
  it("contradictory evidence lowers confidence", () => {
    const base = { recordEvidenceCount: 2, hasObjectiveFindings: true, physicianSupport: false, guidelineSupport: false, bestEvidenceLevel: 5, hasMissingInfo: false };
    const clean = structuredConfidence({ ...base, hasContradictoryEvidence: false });
    const contra = structuredConfidence({ ...base, hasContradictoryEvidence: true });
    expect(contra.score).toBeLessThan(clean.score);
    expect(contra.factors.join(" ")).toMatch(/contradictory/);
  });
  it("Indeterminate when there is nothing to reason from", () => {
    const c = structuredConfidence({ recordEvidenceCount: 0, hasObjectiveFindings: false, physicianSupport: false, guidelineSupport: false, bestEvidenceLevel: null, hasContradictoryEvidence: false, hasMissingInfo: true });
    expect(c.level).toBe("Indeterminate");
  });
  it("Low when support is thin", () => {
    const c = structuredConfidence({ recordEvidenceCount: 1, hasObjectiveFindings: false, physicianSupport: false, guidelineSupport: false, bestEvidenceLevel: 10, hasContradictoryEvidence: true, hasMissingInfo: true });
    expect(c.level).toBe("Low");
  });
});
