import { describe, it, expect } from "vitest";
import { buildReasoningAssessment, detectSetConflicts, reasoningFindings, filterLiterature, lateralityOf, type ReasoningItem } from "./clinicalReasoning";
import type { DossierCase, DossierChronoEvent, DossierCondition } from "./medicalNecessity";
import type { CondInput } from "./integrity";

const kase: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };

// A well-documented knee diagnosis: objective imaging, treating records, guideline.
const kneeStrong: CondInput & DossierCondition & { id: string } = {
  id: "cond-knee",
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  supportingRecords: "ORIF operative note; PT gait assessment",
  objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
  evidenceSources: [
    { filename: "mri.pdf", page: 4, quote: "high-grade chondral loss, medial femoral condyle" },
    { filename: "xray.pdf", page: 2, quote: "tricompartmental narrowing" },
  ],
  missingInfo: null,
  reasoning: "Attributed to the tibial plateau fracture.",
  physicianConfirmed: false,
  socAnalysis: { guidelines: [{ title: "AAOS knee osteoarthritis guideline", year: "2023", quote: "Arthroplasty is recommended for end-stage disease.", relevance: { evidenceLevel: 1, evidenceLabel: "Clinical practice guideline", whyRelevant: "guideline; addresses the diagnosis and intervention" } }] },
};

// A knee diagnosis with NO patient-specific support (no records, no objective).
const kneeBare: CondInput & DossierCondition & { id: string } = {
  id: "cond-knee-bare",
  name: "Osteoarthritis of the right knee",
  relatedness: "RELATED",
  supportingRecords: null,
  objectiveEvidence: null,
  evidenceSources: [],
  missingInfo: "No imaging or examination on file.",
  reasoning: "Asserted.",
  physicianConfirmed: false,
};

const chronology: DossierChronoEvent[] = [
  { eventDate: "2024-06-12", provider: "Dr. Brandt", procedure: "Open reduction internal fixation of the tibial plateau", diagnosis: "tibial plateau fracture", sourcePage: 2 },
  { eventDate: "2024-07-15", provider: "PT", functionalStatus: "Antalgic gait; stair negotiation limited to a single flight with rail", diagnosis: "knee", sourcePage: 5 },
  { eventDate: "2024-08-01", imagingFindings: "MRI: high-grade chondral loss of the medial knee compartment", sourcePage: 4 },
];

const strongLiterature = [
  { title: "Total knee arthroplasty survivorship after tibial plateau fracture: a systematic review", year: "2022", pmid: "111", relevance: { evidenceLevel: 3, evidenceLabel: "Systematic review", supports: "the necessity of knee arthroplasty for post-traumatic arthritis", whyRelevant: "systematic review; addresses the diagnosis and intervention", limitations: null } },
];

function tka(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
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
    ...overrides,
  };
}

describe("buildReasoningAssessment — probability classification (§7)", () => {
  it("classifies a well-supported, non-staged recommendation as PROBABLE_INCLUDED", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.probabilityClassification).toBe("PROBABLE_INCLUDED");
    expect(a.inclusionInTotalsStatus).toBe("included");
    expect(a.supportingDiagnosisIds).toContain("cond-knee");
  });

  it("classifies a triggered recommendation as CONDITIONAL_STAGED and excludes it from totals", () => {
    const a = buildReasoningAssessment(tka({ startTrigger: "progression to end-stage collapse" }), [kneeStrong], chronology, kase);
    expect(a.probabilityClassification).toBe("CONDITIONAL_STAGED");
    expect(a.inclusionInTotalsStatus).toBe("contingency");
    expect(a.durationClass).toBe("UNTIL_SURGERY");
  });

  it("marks a physician-rejected recommendation REJECTED_BY_REVIEWER", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "REJECTED" }), [kneeStrong], chronology, kase);
    expect(a.probabilityClassification).toBe("REJECTED_BY_REVIEWER");
  });
});

describe("buildReasoningAssessment — frequency support (§10, test #6)", () => {
  it("does NOT treat a frequency as supported when there is no cadence, guideline, or physician review", () => {
    const injections: ReasoningItem = { service: "Genicular nerve block injections", category: "INJECTION", frequencyPerYear: 4, durationYears: 5, isLifetime: false, probability: "POSSIBLE", physicianStatus: "PENDING", cptCode: "64454" };
    const a = buildReasoningAssessment(injections, [kneeBare], [], kase);
    expect(a.frequencySupported).toBe(false);
    expect(a.frequencyRationale).toMatch(/pending review|not yet grounded/i);
  });

  it("treats frequency as supported once a physician has approved it", () => {
    const a = buildReasoningAssessment(tka({ frequencyPerYear: 1, physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.frequencySupported).toBe(true);
    expect(a.frequencyRationale).toMatch(/physician review/i);
  });
});

describe("buildReasoningAssessment — lifetime duration (§11, test #7)", () => {
  it("flags a lifetime duration that rests on limited support", () => {
    const a = buildReasoningAssessment(tka({ service: "Attendant care", category: "ATTENDANT_CARE", isLifetime: true, physicianStatus: "PENDING" }), [kneeBare], [], kase);
    expect(a.durationClass).toBe("LIFETIME");
    expect(a.durationRationale).toMatch(/limited support|needed|defensible/i);
  });

  it("accepts a lifetime duration backed by objective evidence and a guideline", () => {
    const a = buildReasoningAssessment(tka({ service: "Home-based maintenance therapy", category: "PHYSICAL_THERAPY", isLifetime: true, physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.durationClass).toBe("LIFETIME");
    expect(a.durationRationale).toMatch(/supported|chronic|progressive/i);
  });
});

describe("buildReasoningAssessment — evidence strength vs. recommendation confidence (§8, tests #11–#12)", () => {
  it("#11 strong patient-specific evidence yields HIGH confidence even when literature is limited", () => {
    // Records + objective + physician + guideline, but no cited literature study.
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.recommendationConfidence).toBe("HIGH");
    // Literature was NOT the basis — evidence strength rests on expert consensus/guideline, not STRONG literature.
    expect(a.evidenceStrength).not.toBe("STRONG");
    expect(a.supportingLiteratureAssessments.length).toBe(0);
  });

  it("#12 strong literature cannot rescue confidence when there is no patient-specific support", () => {
    // Level-1 literature attached, but the diagnosis has no records/objective/physician support.
    const a = buildReasoningAssessment(tka({ physicianStatus: "PENDING", citation: strongLiterature }), [kneeBare], [], kase);
    expect(a.evidenceStrength).toBe("STRONG"); // the literature itself is strong
    expect(["LOW", "INDETERMINATE"]).toContain(a.recommendationConfidence); // but confidence is not
  });

  it("keeps evidence strength (about the literature) distinct from confidence (about this patient)", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED", citation: strongLiterature }), [kneeStrong], chronology, kase);
    expect(a.evidenceStrength).toBe("STRONG");
    expect(a.recommendationConfidence).toBe("HIGH");
    expect(a.materialHash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("Phase B — clinical pathway (§8)", () => {
  it("places a surgery on the definitive-surgical pathway and a therapy on conservative management", () => {
    const surg = buildReasoningAssessment(tka(), [kneeStrong], chronology, kase);
    expect(surg.clinicalPathway).toBe("definitive surgical");
    const pt = buildReasoningAssessment(tka({ service: "Physical therapy", category: "PHYSICAL_THERAPY" }), [kneeStrong], chronology, kase);
    expect(pt.clinicalPathway).toBe("conservative management");
  });

  it("prefixes a staged recommendation's pathway with 'contingent'", () => {
    const a = buildReasoningAssessment(tka({ startTrigger: "failure of conservative care" }), [kneeStrong], chronology, kase);
    expect(a.clinicalPathway).toMatch(/^contingent /);
  });
});

describe("Phase B — cross-recommendation conflicts (§9)", () => {
  const A = tka({ id: "a", service: "Total knee arthroplasty" });
  it("flags two active lines for the same service as duplicates", () => {
    const B = tka({ id: "b", service: "Total knee arthroplasty" });
    const { flags } = detectSetConflicts([A, B]);
    expect(flags.get("a")?.some((f) => f.type === "DUPLICATE")).toBe(true);
    expect(flags.get("b")?.some((f) => f.type === "DUPLICATE")).toBe(true);
  });

  it("marks a replaced line and excludes it from totals when the replacement is active", () => {
    const revision = tka({ id: "rev", service: "Revision arthroplasty", category: "REVISION_SURGERY", replacesService: "Total knee arthroplasty" });
    const { flags, replacedByActive } = detectSetConflicts([A, revision]);
    expect(flags.get("a")?.some((f) => f.type === "REPLACED_BY")).toBe(true);
    expect(replacedByActive.has("a")).toBe(true);
    const assessed = buildReasoningAssessment(A, [kneeStrong], chronology, kase, [], { conflicts: flags.get("a") ?? [], replacedByActive: true });
    expect(assessed.inclusionInTotalsStatus).toBe("excluded");
    expect(assessed.inclusionRationale).toMatch(/replaces|double/i);
  });

  it("flags a recommendation included alongside its own lower-cost alternative", () => {
    const primary = tka({ id: "p", service: "Total knee arthroplasty", lowerCostAlternative: "Unicompartmental knee replacement" });
    const alt = tka({ id: "alt", service: "Unicompartmental knee replacement" });
    const { flags } = detectSetConflicts([primary, alt]);
    expect(flags.get("p")?.some((f) => f.type === "ALTERNATIVE_BOTH_INCLUDED")).toBe(true);
  });

  it("surfaces a lower-cost alternative in the assessment's alternativesConsidered", () => {
    const a = buildReasoningAssessment(tka({ lowerCostAlternative: "Unicompartmental knee replacement" }), [kneeStrong], chronology, kase);
    expect(a.alternativesConsidered[0].alternative).toMatch(/unicompartmental/i);
    expect(a.alternativesConsidered[0].rationale).toMatch(/only one belongs in totals/i);
  });
});

describe("Phase C — literature synthesis (§15)", () => {
  it("states plainly when no published literature was located", () => {
    const a = buildReasoningAssessment(tka(), [kneeStrong], chronology, kase);
    expect(a.supportingLiteratureAssessments.length).toBe(0);
    expect(a.literatureSynthesis).toMatch(/no (accepted )?(published|individual) /i);
  });

  it("synthesizes the strength and applicability of cited literature", () => {
    const a = buildReasoningAssessment(tka({ citation: strongLiterature }), [kneeStrong], chronology, kase);
    expect(a.literatureSynthesis).toMatch(/systematic review/i);
    expect(a.literatureSynthesis).toMatch(/directly addresses|pairing/i);
  });
});

describe("Phase C — counter-analysis and missing evidence (§13–§14)", () => {
  it("enumerates concrete weaknesses when support is thin", () => {
    const a = buildReasoningAssessment(tka({ service: "Genicular nerve block injections", category: "INJECTION", frequencyPerYear: 4, physicianStatus: "PENDING" }), [kneeBare], [], kase);
    const w = a.weakeningEvidence.map((x) => x.detail).join(" | ").toLowerCase();
    expect(w).toMatch(/no independent objective finding/);
    expect(w).toMatch(/physician/);
    expect(w).toMatch(/frequency is assumed/);
    // Structured: each item carries materiality and effect flags (§9).
    const objective = a.weakeningEvidence.find((x) => x.claim === "objective basis");
    expect(objective?.materiality).toBe("HIGH");
    expect(objective?.changesInclusion).toBe(true);
  });

  it("turns gaps into actionable missing-evidence requests", () => {
    const a = buildReasoningAssessment(tka({ category: "INJECTION", physicianStatus: "PENDING" }), [kneeBare], [], kase);
    const m = a.missingEvidenceRequests.join(" | ").toLowerCase();
    expect(m).toMatch(/obtain current imaging|obtain objective/);
    expect(m).toMatch(/physician review/);
    // Structured unknowns state what, why, source, and action (§10).
    const u = a.unknowns.find((x) => /no current objective study/i.test(x.missing));
    expect(u?.whyItMatters.length).toBeGreaterThan(20);
    expect(u?.blocksInclusion).toBe(true);
    expect(u?.likelySource).toMatch(/imaging|examination/i);
  });

  it("does not manufacture weaknesses when the recommendation is well supported", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED", citation: strongLiterature }), [kneeStrong], chronology, kase);
    const w = a.weakeningEvidence.map((x) => x.detail).join(" ").toLowerCase();
    expect(w).not.toMatch(/no independent objective finding/);
    expect(w).not.toMatch(/not yet confirmed/);
  });
});

describe("Phase D — export-gating findings", () => {
  it("blocks export when a line is totaled alongside its own lower-cost alternative", () => {
    const primary = tka({ id: "p", service: "Total knee arthroplasty", lowerCostAlternative: "Unicompartmental knee replacement" });
    const alt = tka({ id: "alt", service: "Unicompartmental knee replacement" });
    const findings = reasoningFindings([primary, alt], [kneeStrong], chronology, kase, new Set(["p", "alt"]));
    const blocker = findings.find((f) => f.exportBlocking);
    expect(blocker?.result).toMatch(/double-counted|replaced/i);
  });

  it("blocks final export for an included line with unsupported frequency, unless reviewer-approved (§7)", () => {
    const inj = tka({ id: "i", service: "Genicular nerve block injections", category: "INJECTION", frequencyPerYear: 4, physicianStatus: "PENDING" });
    const findings = reasoningFindings([inj], [kneeBare], [], kase, new Set(["i"]));
    const freq = findings.find((f) => f.result === "Frequency unsupported");
    expect(freq).toBeTruthy();
    expect(freq?.exportBlocking).toBe(true); // not reviewer-approved → final export blocked
    // The same line, explicitly physician-approved → documented reviewer rationale lifts the block.
    const approved = reasoningFindings([tka({ id: "i2", service: "Genicular nerve block injections", category: "INJECTION", frequencyPerYear: 4, physicianStatus: "APPROVED" })], [kneeBare], [], kase, new Set(["i2"]));
    const freq2 = approved.find((f) => f.result === "Frequency unsupported");
    expect(freq2 ?? null).toBeNull(); // physician approval supports the frequency
  });

  it("emits nothing for a well-supported, physician-approved, singular line", () => {
    const a = tka({ id: "s", physicianStatus: "APPROVED" });
    const findings = reasoningFindings([a], [kneeStrong], chronology, kase, new Set(["s"]));
    expect(findings.length).toBe(0);
  });
});

describe("Phase C — residual uncertainty", () => {
  it("reads as low uncertainty for a high-confidence recommendation", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(a.recommendationConfidence).toBe("HIGH");
    expect(a.residualUncertainty).toMatch(/little material uncertainty/i);
  });

  it("names what would strengthen a weakly-supported recommendation", () => {
    const a = buildReasoningAssessment(tka({ category: "INJECTION", physicianStatus: "PENDING" }), [kneeBare], [], kase);
    expect(a.residualUncertainty).toMatch(/uncertainty remains|cannot yet be assessed/i);
    expect(a.residualUncertainty).toMatch(/would strengthen most with/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CRE v1 sprint tests (§20)
// ═════════════════════════════════════════════════════════════════════════════

const lumbarOnly: typeof kneeStrong = {
  id: "cond-lumbar",
  name: "Lumbar disc herniation L4-L5",
  relatedness: "RELATED",
  supportingRecords: "MRI lumbar spine",
  objectiveEvidence: "L4-L5 disc herniation with nerve root compression",
  evidenceSources: [{ filename: "mri-lumbar.pdf", page: 3, quote: "L4-L5 herniation" }],
  missingInfo: null,
  reasoning: "Attributed to the incident.",
  physicianConfirmed: false,
};

describe("CRE v1 §3 — condition definition", () => {
  it("#1 a knee recommendation cannot use a lumbar diagnosis", () => {
    const a = buildReasoningAssessment(tka(), [lumbarOnly], chronology, kase);
    expect(a.supportingDiagnosisIds).not.toContain("cond-lumbar");
    expect(a.supportingDiagnosisIds.length).toBe(0);
    expect(a.lifecycleStatus).toBe("INVALID"); // structural defect — no diagnosis in the region
    expect(a.weakeningEvidence.some((w) => /no diagnosis in the relevant body region/i.test(w.detail))).toBe(true);
  });

  it("flags a laterality mismatch between the service and its diagnosis", () => {
    expect(lateralityOf("Left total knee arthroplasty")).toBe("left");
    expect(lateralityOf("Osteoarthritis of the right knee")).toBe("right");
    const leftTka = tka({ service: "Left total knee arthroplasty" });
    const a = buildReasoningAssessment(leftTka, [kneeStrong], chronology, kase); // kneeStrong is RIGHT knee
    expect(a.laterality).toBe("left");
    expect(a.lifecycleStatus).toBe("INVALID");
    expect(a.weakeningEvidence.some((w) => w.claim === "anatomic laterality")).toBe(true);
  });

  it("derives severity, chronicity, and current clinical status from the record", () => {
    const a = buildReasoningAssessment(tka(), [kneeStrong], chronology, kase);
    expect(a.conditionSeverity).toBe("severe"); // "high-grade chondral loss"
    expect(a.conditionChronicity).toBe("chronic"); // post-traumatic osteoarthritis
    expect(a.currentClinicalStatus).toBe("under active treatment"); // prior treatment documented
  });
});

describe("CRE v1 §4 — epistemic evidence classification", () => {
  it("#2 subjective symptoms are never labeled as objective findings", () => {
    const chronoWithReport: typeof chronology = [
      ...chronology,
      { eventDate: "2024-09-01", provider: "PT", functionalStatus: "Patient reports pain with prolonged standing", diagnosis: "knee", sourcePage: 7 },
    ];
    const a = buildReasoningAssessment(tka(), [kneeStrong], chronoWithReport, kase);
    const reported = a.evidenceItems.filter((e) => /patient reports/i.test(e.text));
    expect(reported.length).toBeGreaterThan(0);
    for (const r of reported) {
      expect(r.objective).toBe(false);
      expect(r.epistemic).toBe("patient_report");
    }
    // Imaging stays a documented, objective fact.
    const img = a.evidenceItems.find((e) => e.category === "imaging");
    expect(img?.objective).toBe(true);
    expect(img?.epistemic).toBe("documented_fact");
    // Physician documentation is provider OPINION, not documented fact.
    for (const e of a.evidenceItems.filter((x) => x.category === "treating_provider_recommendation")) {
      expect(e.epistemic).toBe("provider_opinion");
    }
  });
});

describe("CRE v1 §12 — recommendation-specific literature filter", () => {
  const asLit = (title: string) => ({ title, supports: "the claim", applicability: "", evidenceLevel: 5, limitations: null });

  it("#3 pain-management follow-up rejects unrelated surgery and machine-learning articles", () => {
    const { accepted, rejected } = filterLiterature(
      [
        asLit("Machine learning prediction of outcomes after lumbar fusion surgery"),
        asLit("Long-term opioid management and monitoring in chronic low back pain: follow-up outcomes"),
      ],
      { service: "Pain management follow-up visits", diagnosis: "Chronic lumbar radiculopathy", adult: true },
    );
    expect(rejected.some((r) => /machine learning/i.test(r.title))).toBe(true);
    expect(rejected.find((r) => /machine learning/i.test(r.title))?.reason).toMatch(/mismatch/i);
    expect(accepted.some((a2) => /opioid management/i.test(a2.title))).toBe(true);
  });

  it("#4 adult urology care rejects pediatric and pregnancy evidence", () => {
    const { accepted, rejected } = filterLiterature(
      [
        asLit("Pediatric neurogenic bladder management guideline"),
        asLit("Urinary retention in pregnancy: a case report"),
        asLit("Urodynamic surveillance in adult neurogenic bladder: consensus recommendations"),
      ],
      { service: "Urology follow-up with urodynamics", diagnosis: "Neurogenic bladder", adult: true },
    );
    expect(rejected.some((r) => /pediatric/i.test(r.title))).toBe(true);
    expect(rejected.some((r) => /pregnancy/i.test(r.title))).toBe(true);
    expect(rejected.find((r) => /pregnancy/i.test(r.title))?.reason).toMatch(/pregnan|obstetric/i);
    expect(accepted.some((a2) => /adult neurogenic bladder/i.test(a2.title))).toBe(true);
  });

  it("rejected literature never feeds evidence strength", () => {
    // A single incompatible citation (pediatric) attached to an adult knee rec:
    const pedLit = [{ title: "Congenital knee deformity in children: management guideline", year: "2020", pmid: "999", relevance: { evidenceLevel: 1, evidenceLabel: "Clinical practice guideline", supports: "x", whyRelevant: "keyword", limitations: null } }];
    const a = buildReasoningAssessment(tka({ citation: pedLit, physicianStatus: "PENDING" }), [kneeBare], [], kase);
    expect(a.rejectedLiterature.length).toBe(1);
    expect(a.supportingLiteratureAssessments.length).toBe(0);
    expect(a.evidenceStrength).toBe("INSUFFICIENT"); // the rejected guideline did not count
  });
});

describe("CRE v1 §7–§10 — findings for duration, gaps, and confidence", () => {
  it("#8 unsupported lifetime duration creates a finding, severity scaled by materiality", () => {
    const big = tka({ id: "b", service: "Attendant care", category: "ATTENDANT_CARE", isLifetime: true, physicianStatus: "PENDING", presentValue: 250_000 });
    const small = tka({ id: "s", service: "Home exercise supplies", category: "DME", isLifetime: true, physicianStatus: "PENDING", presentValue: 4_000 });
    const findings = reasoningFindings([big, small], [kneeBare], [], kase, new Set(["b", "s"]));
    const fBig = findings.find((f) => f.service === "Attendant care" && f.result === "Unsupported lifetime duration");
    const fSmall = findings.find((f) => f.service === "Home exercise supplies" && f.result === "Unsupported lifetime duration");
    expect(fBig?.severity).toBe("Critical"); // financially material
    expect(fSmall?.severity).toBe("High");
    expect(fBig?.exportBlocking).toBe(true);
  });

  it("#9 material unknowns block inclusion-worthiness and reduce confidence", () => {
    const a = buildReasoningAssessment(tka({ physicianStatus: "PENDING" }), [kneeBare], [], kase);
    const blocking = a.unknowns.find((u) => u.blocksInclusion);
    expect(blocking).toBeTruthy(); // no objective study on file
    expect(a.lifecycleStatus).not.toBe("VALIDATED");
    expect(["LOW", "INDETERMINATE"]).toContain(a.recommendationConfidence);
    const findings = reasoningFindings([tka({ id: "g", physicianStatus: "PENDING" })], [kneeBare], [], kase, new Set(["g"]));
    expect(findings.some((f) => f.result === "Material evidence gap")).toBe(true);
  });

  it("#11 a material change produces a different material hash (approval-invalidation trigger)", () => {
    const base = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    const freqChanged = buildReasoningAssessment(tka({ physicianStatus: "APPROVED", frequencyPerYear: 12 }), [kneeStrong], chronology, kase);
    const durChanged = buildReasoningAssessment(tka({ physicianStatus: "APPROVED", isLifetime: true }), [kneeStrong], chronology, kase);
    expect(freqChanged.materialHash).not.toBe(base.materialHash);
    expect(durChanged.materialHash).not.toBe(base.materialHash);
    // And an immaterial rerun is stable (idempotent cache key).
    const rerun = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(rerun.materialHash).toBe(base.materialHash);
  });

  it("#14 reassessment is deterministic — repeated runs yield identical findings (no duplicates)", () => {
    const items = [tka({ id: "x", physicianStatus: "PENDING" })];
    const run1 = reasoningFindings(items, [kneeBare], [], kase, new Set(["x"]));
    const run2 = reasoningFindings(items, [kneeBare], [], kase, new Set(["x"]));
    expect(run2).toEqual(run1); // persisted findings are replaced atomically, so equality ⇒ no duplication
  });

  it("#18 an assessment is never VALIDATED merely because it was computed", () => {
    // Unsupported item (backfill scenario): computed, but gates fail → NEEDS_REVIEW/INVALID, not VALIDATED.
    const a = buildReasoningAssessment(tka({ physicianStatus: "PENDING", category: "INJECTION", frequencyPerYear: 6 }), [kneeBare], [], kase);
    expect(a.lifecycleStatus).not.toBe("VALIDATED");
    // Fully supported item: gates pass → VALIDATED.
    const good = buildReasoningAssessment(tka({ physicianStatus: "APPROVED" }), [kneeStrong], chronology, kase);
    expect(good.lifecycleStatus).toBe("VALIDATED");
  });
});
