import { describe, it, expect } from "vitest";
import { buildRecommendationDossier, validateRecommendationCompleteness, type DossierItem, type DossierCondition, type DossierChronoEvent, type DossierCase } from "./medicalNecessity";

const kase: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };

const condition: DossierCondition = {
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss, medial femoral condyle" }],
  opposingRecords: "A prior note attributes some degeneration to age.",
  missingInfo: "Updated weight-bearing films recommended.",
  reasoning: "Attributed to the tibial plateau fracture.",
  physicianConfirmed: false,
  socAnalysis: { guidelines: [{ title: "AAOS knee osteoarthritis guideline", year: "2023", quote: "Arthroplasty is recommended for end-stage disease.", relevance: { evidenceLevel: 1, evidenceLabel: "Clinical practice guideline", whyRelevant: "guideline; addresses the diagnosis and intervention" } }] },
};

const chronology: DossierChronoEvent[] = [
  { eventDate: "2024-06-12", provider: "Dr. Nadia Brandt", procedure: "Open reduction internal fixation of the tibial plateau", diagnosis: "tibial plateau fracture", sourcePage: 2 },
  { eventDate: "2024-07-15", provider: "PT", functionalStatus: "Antalgic gait; stair negotiation limited to a single flight with rail", diagnosis: "knee", sourcePage: 5 },
  { eventDate: "2024-08-01", imagingFindings: "MRI: high-grade chondral loss of the medial knee compartment", sourcePage: 4 },
];

const tka: DossierItem = {
  service: "Total knee arthroplasty",
  category: "ORTHOPEDIC_SURGERY",
  rationale: "end-stage post-traumatic arthritis of the knee",
  cptCode: "27447",
  probability: "PROBABLE",
  frequencyPerYear: 1,
  durationYears: null,
  isLifetime: false,
  unitCost: 42000,
  presentValue: 38000,
  physicianStatus: "PENDING",
  citation: [
    { title: "Total knee arthroplasty survivorship after tibial plateau fracture: a cohort study", year: "2022", pmid: "111", relevance: { evidenceLevel: 8, evidenceLabel: "Cohort study", supports: "the necessity of knee arthroplasty for post-traumatic arthritis", whyRelevant: "cohort; addresses the diagnosis and intervention", limitations: null } },
    { title: "Congenital knee deformity in children: a case report", year: "2019", pmid: "222", relevance: { evidenceLevel: 10, evidenceLabel: "Case report" } },
  ],
};

describe("buildRecommendationDossier", () => {
  const d = buildRecommendationDossier(tka, condition, chronology, kase);

  it("writes a medical-necessity narrative that does NOT merely restate the diagnosis", () => {
    expect(d.medicalNecessity.length).toBeGreaterThan(120);
    expect(d.medicalNecessity).toMatch(/objective|residual|functional|reasonable and necessary/i);
    // It leads with pathology / reasoning, not "Ms. Trice has X." alone.
    expect(d.medicalNecessity).not.toBe(condition.name);
  });

  it("organizes supporting evidence into source-traceable buckets", () => {
    expect(d.supportingEvidence.diagnoses[0].text).toMatch(/osteoarthritis/i);
    expect(d.supportingEvidence.objectiveFindings.length).toBeGreaterThan(0);
    expect(d.supportingEvidence.imaging.some((x) => /chondral/i.test(x.text))).toBe(true);
    expect(d.supportingEvidence.functionalLimitations.some((x) => /antalgic|stair/i.test(x.text))).toBe(true);
    expect(d.supportingEvidence.priorTreatment.some((x) => /orif|internal fixation/i.test(x.text))).toBe(true);
    expect(d.supportingEvidence.guidelines.length).toBe(1);
    // Every evidence item is traceable to a source.
    expect(d.supportingEvidence.imaging[0].source).toContain("p.");
  });

  it("gives a structured probability with a percentage and factors", () => {
    expect(d.probability.percentage).toBeGreaterThan(50);
    expect(d.probability.factors.length).toBeGreaterThanOrEqual(5);
    expect(d.probability.statement).toMatch(/more likely than not/i);
  });

  it("surfaces potential challenges transparently (pending review, assumptions)", () => {
    expect(d.potentialChallenges.join(" ")).toMatch(/physician review is pending/i);
    expect(d.potentialChallenges.join(" ")).toMatch(/frequency/i);
  });

  it("actively surfaces contradictory evidence, including the opposing note", () => {
    expect(d.contradictoryEvidence.join(" ")).toMatch(/age/i);
  });

  it("states unknowns without implying certainty", () => {
    expect(d.unknowns.join(" ")).toMatch(/weight-bearing films|natural history|updated/i);
  });

  it("orders literature strongest-first and never lets a case report be primary; excludes incompatible pediatric article", () => {
    expect(d.literature[0].studyType).toBe("Cohort study"); // cohort (8) beats case report (10)
    // The pediatric congenital case report is population-incompatible → excluded.
    expect(d.literature.some((l) => /congenital/i.test(l.title))).toBe(false);
    // Each article states exactly what it supports + applicability + why selected.
    expect(d.literature[0].supports).toMatch(/necessity|arthroplasty/i);
    expect(d.literature[0].applicability).toMatch(/Ms\. Trice/);
    expect(d.literature[0].whySelected).toBeTruthy();
  });

  it("produces a structured confidence with an explanation", () => {
    expect(["High", "Moderate", "Low", "Indeterminate"]).toContain(d.confidence.level);
    expect(d.confidence.explanation).toMatch(/confidence is/i);
  });
});

describe("interview weaving (EPIC-011)", () => {
  const itemWithId = { ...tka, id: "item-1" };
  const condWithId = { ...condition, id: "cond-1" };

  it("weaves a patient complaint linked to the item into the narrative and functional evidence", () => {
    const d = buildRecommendationDossier(itemWithId, condWithId, chronology, kase, [
      { subject: "PATIENT", category: "Pain", text: "constant knee pain that limits standing to ten minutes", quote: "my knee gives out on stairs", futureCareItemId: "item-1" },
    ]);
    expect(d.medicalNecessity).toMatch(/on interview, ms\. trice reports/i);
    expect(d.supportingEvidence.functionalLimitations.some((e) => /patient reports/i.test(e.text) && /gives out on stairs/i.test(e.text))).toBe(true);
  });

  it("weaves a treating-provider opinion into physician documentation", () => {
    const d = buildRecommendationDossier(itemWithId, condWithId, chronology, kase, [
      { subject: "PROVIDER", providerName: "Dr. Brandt", text: "expects the patient will require arthroplasty within two years", futureCareItemId: "item-1" },
    ]);
    expect(d.supportingEvidence.physicianDocumentation.some((e) => /Dr\. Brandt/.test(e.text))).toBe(true);
    expect(d.medicalNecessity).toMatch(/consistent with the opinion of Dr\. Brandt/i);
  });

  it("an item-specific finding does NOT bleed onto a different item of the same diagnosis", () => {
    const other = { ...tka, id: "item-2", service: "Knee injections" };
    const d = buildRecommendationDossier(other, condWithId, chronology, kase, [
      { subject: "PATIENT", text: "pain", futureCareItemId: "item-1", conditionId: "cond-1" },
    ]);
    expect(d.supportingEvidence.functionalLimitations.some((e) => /patient reports/i.test(e.text))).toBe(false);
  });

  it("a diagnosis-level finding (no item link) applies to every item of that diagnosis", () => {
    const d = buildRecommendationDossier(itemWithId, condWithId, chronology, kase, [
      { subject: "PATIENT", text: "diffuse knee pain", conditionId: "cond-1" },
    ]);
    expect(d.supportingEvidence.functionalLimitations.some((e) => /diffuse knee pain/i.test(e.text))).toBe(true);
  });
});

describe("validateRecommendationCompleteness", () => {
  it("flags a recommendation with no supporting diagnosis as Critical/blocking", () => {
    const d = buildRecommendationDossier({ service: "Mystery item", frequencyPerYear: 1 }, null, [], kase);
    const f = validateRecommendationCompleteness({ service: "Mystery item" }, d, false);
    expect(f.some((x) => x.result === "No supporting diagnosis" && x.exportBlocking)).toBe(true);
  });

  it("flags missing objective evidence (non-blocking) when the record is thin", () => {
    const d = buildRecommendationDossier({ service: "Home aide", frequencyPerYear: 1, rationale: "ADL dependence" }, { name: "Spastic quadriparesis" }, [], kase);
    const f = validateRecommendationCompleteness({ service: "Home aide", rationale: "ADL dependence" }, d, true);
    expect(f.some((x) => x.result === "No objective evidence" && !x.exportBlocking)).toBe(true);
  });

  it("passes a complete recommendation with no findings", () => {
    const d = buildRecommendationDossier(tka, condition, chronology, kase);
    const f = validateRecommendationCompleteness(tka, d, true);
    expect(f).toHaveLength(0);
  });
});

describe("physician-narrative variation & recommendation-specific literature (Report Quality Sprint)", () => {
  const k: DossierCase = { subject: "Mr. Doe", pronounPoss: "his", lifeExpectancyYears: 30, adult: true };
  const knee: DossierCondition = {
    name: "Post-traumatic osteoarthritis of the right knee",
    relatedness: "RELATED",
    objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
    evidenceSources: [],
  } as unknown as DossierCondition;
  const mk = (o: Partial<DossierItem> & { service: string }): DossierItem => ({ probability: "PROBABLE", frequencyPerYear: 1, ...o });
  const firstSentence = (s: string) => s.split(/\.\s/)[0];

  it("opens different recommendations with different phrasing (no identical boilerplate)", () => {
    const a = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", presentValue: 38000 }), knee, [], k);
    const b = buildRecommendationDossier(mk({ service: "Pain management office visits", presentValue: 9000 }), knee, [], k);
    const c = buildRecommendationDossier(mk({ service: "Revision knee arthroplasty", presentValue: 52000, startTrigger: "on implant failure" }), knee, [], k);
    const opens = [firstSentence(a.medicalNecessity), firstSentence(b.medicalNecessity), firstSentence(c.medicalNecessity)];
    // At least two distinct opening structures across three recommendations.
    expect(new Set(opens).size).toBeGreaterThanOrEqual(2);
    // Probability statements are not all identical templates either.
    const probs = [a, b, c].map((d) => d.probability.statement);
    expect(new Set(probs).size).toBeGreaterThanOrEqual(2);
  });

  it("is reproducible — the same recommendation renders identical narrative each time", () => {
    const one = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", presentValue: 38000 }), knee, [], k);
    const two = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", presentValue: 38000 }), knee, [], k);
    expect(two.medicalNecessity).toBe(one.medicalNecessity);
    expect(two.probability.statement).toBe(one.probability.statement);
  });

  it("is concise for simple low-cost items and fuller for complex ones (§15)", () => {
    const chrono = [{ eventDate: "2024-01-01", functionalStatus: "Antalgic gait; stair negotiation limited to one flight", procedure: "Arthroscopic debridement of the knee" }] as unknown as DossierChronoEvent[];
    const simple = buildRecommendationDossier(mk({ service: "Elastic knee sleeve", presentValue: 200 }), knee, chrono, k);
    const complex = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", presentValue: 120000, isLifetime: true }), knee, chrono, k);
    expect(complex.medicalNecessity.length).toBeGreaterThan(simple.medicalNecessity.length);
  });

  it("does not select a knee-arthroplasty study for a pain-management office-visit recommendation (§4 scope)", () => {
    const item = mk({ service: "Pain management office visits", presentValue: 9000, citation: [{ title: "Total knee arthroplasty survivorship: a registry study", relevance: { evidenceLevel: 7 } }] });
    const d = buildRecommendationDossier(item, knee, [], k);
    expect(d.literature.some((l) => /arthroplasty/i.test(l.title))).toBe(false);
  });
});

describe("functional-domain link (§12) and staged inclusion (§10)", () => {
  const k: DossierCase = { subject: "Ms. Roe", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
  const knee: DossierCondition = { name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED", objectiveEvidence: "Joint-space narrowing", evidenceSources: [] } as unknown as DossierCondition;
  const gaitChrono = [{ eventDate: "2024-01-01", functionalStatus: "Right knee antalgic gait limited to 100 feet, with stair difficulty" }] as unknown as DossierChronoEvent[];

  it("links a mobility recommendation to the documented gait limitation, with quantified detection", () => {
    const d = buildRecommendationDossier({ service: "Rolling walker", category: "MOBILITY_AID", frequencyPerYear: 1 }, knee, gaitChrono, k);
    expect(d.functionalLink).not.toBeNull();
    expect(d.functionalLink!.domain).toBe("Mobility");
    expect(d.functionalLink!.limitation).toMatch(/gait|stair/i);
    expect(d.functionalLink!.quantified).toBe(true); // "1 flight"
    expect(d.functionalLink!.relationship).toMatch(/rolling walker/i);
  });

  it("does not invent a functional link when none is documented", () => {
    const d = buildRecommendationDossier({ service: "Surveillance knee MRI", category: "IMAGING", frequencyPerYear: 1 }, knee, [], k);
    expect(d.functionalLink).toBeNull();
  });
});

describe("specialty-specific, function-driven narrative (Clinical Intelligence Sprint)", () => {
  const k: DossierCase = { subject: "Mr. Poe", pronounPoss: "his", lifeExpectancyYears: 30, adult: true };
  const knee: DossierCondition = { name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED", objectiveEvidence: "Tricompartmental joint-space narrowing", evidenceSources: [] } as unknown as DossierCondition;
  const chrono = [{ eventDate: "2024-01-01", functionalStatus: "Right knee antalgic gait limited to 100 feet" }] as unknown as DossierChronoEvent[];
  const mk = (o: Partial<DossierItem> & { service: string }): DossierItem => ({ probability: "PROBABLE", frequencyPerYear: 1, ...o });

  it("writes pain-management and orthopedic recommendations in their own specialty voices", () => {
    const pain = buildRecommendationDossier(mk({ service: "Pain management visits", category: "PAIN_MANAGEMENT", presentValue: 9000, isLifetime: true }), knee, chrono, k);
    const ortho = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", presentValue: 80000 }), knee, chrono, k);
    expect(pain.medicalNecessity).toMatch(/pain-management standpoint|opioid|symptom control/i);
    expect(ortho.medicalNecessity).toMatch(/orthopedic|revision risk|post-traumatic arthritis/i);
    expect(pain.medicalNecessity).not.toBe(ortho.medicalNecessity);
  });

  it("connects the recommendation to the DOCUMENTED functional limitation (§5)", () => {
    const d = buildRecommendationDossier(mk({ service: "Pain management visits", category: "PAIN_MANAGEMENT", presentValue: 9000 }), knee, chrono, k);
    expect(d.medicalNecessity).toMatch(/antalgic gait limited to 100 feet/i);
    expect(d.medicalNecessity).toMatch(/functional|function/i);
  });

  it("states probability qualitatively with NO numeric percentage in the report (§12)", () => {
    const d = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", presentValue: 80000 }), knee, chrono, k);
    expect(d.probability.statement).not.toMatch(/\d+\s*%|approximately \d/);
    expect(d.probability.statement).toMatch(/more likely than not/i);
    // The numeric percentage remains available internally for thresholding.
    expect(typeof d.probability.percentage).toBe("number");
  });

  it("closes complex recommendations with an integrated synthesis (§8)", () => {
    const d = buildRecommendationDossier(mk({ service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", presentValue: 120000, isLifetime: true }), knee, chrono, k);
    expect(d.medicalNecessity).toMatch(/taken together|integrating the diagnosis/i);
    expect(d.medicalNecessity).toMatch(/reasonable degree of medical probability/i);
  });
});
