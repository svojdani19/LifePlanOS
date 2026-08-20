import { describe, it, expect } from "vitest";
import { assessLifetimeSupport, hasDocumentedChronicity, describeLifetimeBasis, deriveGuidelineDurationClaim, guidelineServiceMatches } from "./lifetimeSupport";
import { buildReasoningAssessment, reasoningFindings, type ReasoningItem } from "./clinicalReasoning";
import { buildRecommendationDossier } from "./medicalNecessity";
import type { DossierCase, DossierCondition } from "./medicalNecessity";
import type { CondInput } from "./integrity";
import { project, type CaseAssumptions } from "./cost";

// ═════════════════════════════════════════════════════════════════════════════
// Lifetime-Honesty sprint — `isLifetime` is a projection horizon, never
// clinical evidence. These tests pin the decoupling: no chronicity, trajectory,
// support, probability, or validation status may flow FROM the flag; lifetime
// financial scenarios stay fully calculated and disclosed either way.
// ═════════════════════════════════════════════════════════════════════════════

const kase: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };

type Cond = CondInput & DossierCondition & { id: string };

// An anchored ACUTE condition: real objective evidence of the injury, but no
// documented chronicity/permanence/progression language anywhere.
const fractureAcute: Cond = {
  id: "cond-tp",
  name: "Tibial plateau fracture of the right knee, initial encounter",
  relatedness: "RELATED",
  supportingRecords: "ED records; CT report",
  objectiveEvidence: "Comminuted tibial plateau fracture on CT",
  evidenceSources: [{ filename: "ct.pdf", page: 3, quote: "comminuted fracture of the tibial plateau" }],
  missingInfo: null,
  reasoning: "Attributed to the incident.",
  physicianConfirmed: false,
};

// The same condition with a SOURCE-LINKED chronic/permanent prognosis quote.
const fractureChronicPrognosis: Cond = {
  ...fractureAcute,
  evidenceSources: [
    { filename: "ct.pdf", page: 3, quote: "comminuted fracture of the tibial plateau" },
    { filename: "prognosis.pdf", page: 12, quote: "permanent impairment; the condition is chronic and will not improve" },
  ],
};

// The same acute condition carrying a diagnosis-keyed guideline.
const fractureWithGuideline: Cond = {
  ...fractureAcute,
  socAnalysis: {
    guidelines: [
      { title: "Long-term management of post-traumatic knee injury", year: "2023", quote: "Lifelong surveillance is recommended after intra-articular fracture.", relevance: { evidenceLevel: 1, evidenceLabel: "Clinical practice guideline" } },
    ],
  },
};

function item(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    service: "Attendant care",
    category: "ATTENDANT_CARE",
    rationale: "assistance with mobility and self-care",
    probability: "PROBABLE",
    frequencyPerYear: 12,
    durationYears: null,
    isLifetime: true,
    unitCost: 500,
    presentValue: 150_000,
    physicianStatus: "PENDING",
    // Explicit: this fixture is a patient-specific item whose LIFETIME horizon
    // is the thing under test. It used to omit `origin` and rely on the old
    // grounding check reading an absent origin as grounded — a legacy branch
    // no real row could reach, since the column is non-nullable with a default
    // of TEMPLATE_CONDITION.
    origin: "RECORD_RECOMMENDED",
    ...overrides,
  };
}

// ── (1) Flipping ONLY isLifetime changes no clinical fact ────────────────────
describe("isLifetime is a projection horizon only (#1, #15 regression)", () => {
  it("flipping only isLifetime changes no chronicity, trajectory, sufficiency, or confidence", () => {
    const off = buildReasoningAssessment(item({ isLifetime: false, durationYears: 3 }), [fractureAcute], [], kase);
    const on = buildReasoningAssessment(item({ isLifetime: true, durationYears: null }), [fractureAcute], [], kase);
    expect(on.conditionChronicity).toBe(off.conditionChronicity);
    expect(on.conditionChronicity).toBe("acute"); // from the documented record, not the horizon
    expect(on.conditionTrajectory).toBe(off.conditionTrajectory);
    expect(on.conditionTrajectory).toBe("undetermined");
    expect(on.evidenceSufficiency.score).toBe(off.evidenceSufficiency.score);
    expect(on.recommendationConfidence).toBe(off.recommendationConfidence);
    expect(on.evidenceStrength).toBe(off.evidenceStrength);
  });

  it("does not increase medical probability merely because the projection is lifetime", () => {
    const off = buildRecommendationDossier(item({ isLifetime: false, durationYears: 3 }), fractureAcute, [], kase);
    const on = buildRecommendationDossier(item({ isLifetime: true }), fractureAcute, [], kase);
    expect(on.probability.percentage).toBeLessThanOrEqual(off.probability.percentage);
    const course = on.probability.factors.find((f) => f.label === "Expected clinical course");
    expect(course?.present).toBe(false); // no independent duration support
    expect(course?.detail).toMatch(/projection assumption/i);
  });

  // The explicit circular-sequence regression: isLifetime=true → "chronic /
  // progressive" → "lifetime supported" is now impossible without independent
  // support.
  it("#15 the circular chain isLifetime → chronic/progressive → lifetime-supported is broken", () => {
    const a = buildReasoningAssessment(item({ isLifetime: true }), [fractureAcute], [], kase);
    expect(a.conditionChronicity).toBe("acute");
    expect(a.conditionTrajectory).toBe("undetermined");
    expect(a.durationSupport.clinicallySupported).toBe(false);
    expect(a.durationRationale).not.toMatch(/chronic and progressive/i);
    expect(a.lifecycleStatus).not.toBe("VALIDATED");
    // …and the chain closes only through independent evidence:
    const b = buildReasoningAssessment(item({ isLifetime: true }), [fractureChronicPrognosis], [], kase);
    expect(b.durationSupport.clinicallySupported).toBe(true);
  });
});

// ── (2) No manufactured progression ──────────────────────────────────────────
describe("no manufactured progression (#2)", () => {
  it("never invents a progressive trajectory or a chronic-progression narrative from the horizon", () => {
    const a = buildReasoningAssessment(item({ isLifetime: true }), [fractureAcute], [], kase);
    expect(a.conditionTrajectory).toBe("undetermined");
    expect(a.medicalNecessityRationale).not.toMatch(/chronic and (expected to )?progress/i);
    expect(a.medicalNecessityRationale).toMatch(/projection assumption|planning assumption/i);
  });

  it("states a stable-to-worsening trajectory only from documented condition evidence", () => {
    const degen: Cond = { ...fractureAcute, id: "cond-deg", name: "Post-traumatic osteoarthritis of the right knee, progressive on serial imaging" };
    const a = buildReasoningAssessment(item({ isLifetime: false, durationYears: 3 }), [degen], [], kase);
    expect(a.conditionTrajectory).toMatch(/per documented condition evidence/i);
  });
});

// ── (3)–(8) The duration-support decision model ──────────────────────────────
describe("assessLifetimeSupport — decision model (#3–#8)", () => {
  it("#3 isLifetime alone is never duration support", () => {
    const r = assessLifetimeSupport({ isLifetime: true });
    expect(r.status).toBe("ASSUMPTION_PENDING_REVIEW");
    expect(r.clinicallySupported).toBe(false);
    expect(r.bases.length).toBe(0);
    expect(r.mayEnterFinalizedTotals).toBe(false);
    expect(r.professionalReviewRequired).toBe(true);
  });

  it("#4 a generic objective finding (MRI/CT proving the injury) is NOT lifetime-duration support", () => {
    const r = assessLifetimeSupport({ isLifetime: true, condition: fractureAcute, objectiveFindingCount: 2 });
    expect(r.clinicallySupported).toBe(false);
    expect(r.status).toBe("ASSUMPTION_PENDING_REVIEW");
    expect(r.uncertaintyNotes.join(" ")).toMatch(/objective findings document the injury but do not themselves establish/i);
    expect(hasDocumentedChronicity(fractureAcute)).toBe(false);
  });

  it("#5 explicit source-linked permanence/chronic prognosis supports it, with the source cited", () => {
    const r = assessLifetimeSupport({ isLifetime: true, condition: fractureChronicPrognosis });
    expect(r.status).toBe("SUPPORTED_BY_RECORD");
    expect(r.clinicallySupported).toBe(true);
    const basis = r.bases.find((b) => b.kind === "record_chronicity");
    expect(basis?.source).toBe("prognosis.pdf, p. 12");
    expect(hasDocumentedChronicity(fractureChronicPrognosis)).toBe(true);
  });

  it("#6 diagnosis-keyed clinical guidance supports it ONLY through a verified duration claim", () => {
    const r = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureAcute,
      guidelineEvidence: [
        {
          text: "Lifelong surveillance is recommended after intra-articular fracture — Long-term management of post-traumatic knee injury (2023)",
          source: "clinical practice guideline",
          duration: {
            supportsDuration: true,
            durationType: "long_term_surveillance",
            durationClaim: "Lifelong surveillance is recommended after intra-articular fracture.",
            sourceId: "Long-term management of post-traumatic knee injury",
            sourceVersion: "2023",
            quote: "Lifelong surveillance is recommended after intra-articular fracture.",
          },
        },
      ],
    });
    expect(r.status).toBe("SUPPORTED_BY_GUIDELINE");
    expect(r.clinicallySupported).toBe(true);
    // The SAME guideline without its duration claim never supports the duration.
    const silent = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureAcute,
      guidelineEvidence: [{ text: "Lifelong surveillance is recommended after intra-articular fracture — Long-term management of post-traumatic knee injury (2023)", source: "clinical practice guideline" }],
    });
    expect(silent.clinicallySupported).toBe(false);
    expect(silent.status).toBe("ASSUMPTION_PENDING_REVIEW");
  });

  it("#7 a bare approval flag is professional adoption — never record evidence or chronicity", () => {
    const r = assessLifetimeSupport({ isLifetime: true, condition: fractureAcute, physicianStatus: "APPROVED" });
    expect(r.professionalAdoption).toBe(true);
    expect(r.clinicallySupported).toBe(false); // adoption is not evidence
    expect(r.status).toBe("INSUFFICIENT");
    expect(r.mayEnterFinalizedTotals).toBe(true); // existing adoption policy preserved
    expect(r.uncertaintyNotes.join(" ")).toMatch(/professional adoption .* not treating-record evidence/i);
    // And the condition itself stays acute in the assessment:
    const a = buildReasoningAssessment(item({ physicianStatus: "APPROVED" }), [fractureAcute], [], kase);
    expect(a.conditionChronicity).toBe("acute");
  });

  it("#8 an attributed professional duration rationale counts as professional adoption of the duration", () => {
    const r = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureAcute,
      physicianStatus: "MODIFIED",
      physicianNote: "Lifetime attendant support is required given the permanent nature of the deficit.",
    });
    expect(r.status).toBe("SUPPORTED_BY_PROFESSIONAL_OPINION");
    expect(r.bases[0].source).toMatch(/attributed duration rationale/i);
    // A note that never speaks to duration is NOT a duration opinion:
    const silent = assessLifetimeSupport({ isLifetime: true, condition: fractureAcute, physicianStatus: "MODIFIED", physicianNote: "Please verify the unit pricing." });
    expect(silent.status).toBe("INSUFFICIENT");
  });

  it("multiple independent kinds combine to MULTIPLE_SUPPORTS and name every basis", () => {
    const r = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureChronicPrognosis,
      guidelineEvidence: [
        {
          text: "Long-term management guideline",
          source: "clinical practice guideline",
          duration: { supportsDuration: true, durationType: "natural_history", durationClaim: "The natural history is progressive post-traumatic degeneration.", sourceId: "Long-term management guideline" },
        },
      ],
    });
    expect(r.status).toBe("MULTIPLE_SUPPORTS");
    expect(describeLifetimeBasis(r)).toMatch(/documented chronicity in the condition record .* and diagnosis-keyed clinical guidance/i);
  });

  it("a non-lifetime item is NOT_APPLICABLE and unconstrained", () => {
    const r = assessLifetimeSupport({ isLifetime: false, condition: fractureAcute });
    expect(r.status).toBe("NOT_APPLICABLE");
    expect(r.mayEnterFinalizedTotals).toBe(true);
  });

  it("an unanchored asserted chronic label alone does not establish duration support", () => {
    const asserted: Cond = { ...fractureAcute, id: "cond-x", name: "Chronic pain syndrome", supportingRecords: null, objectiveEvidence: null, evidenceSources: [] };
    const r = assessLifetimeSupport({ isLifetime: true, condition: asserted });
    expect(r.clinicallySupported).toBe(false);
  });
});

// ── (21)–(26) Guideline duration claims — a guideline is necessity evidence,
//    never duration evidence, until it carries a VERIFIED duration claim ──────
describe("guideline duration claims (#21–#26)", () => {
  const durationGuideline = {
    text: "“Lifelong surveillance is recommended after intra-articular fracture.” — Long-term management of post-traumatic knee injury (2023)",
    source: "Clinical practice guideline",
    duration: deriveGuidelineDurationClaim({
      title: "Long-term management of post-traumatic knee injury",
      year: "2023",
      quote: "Lifelong surveillance is recommended after intra-articular fracture.",
    }),
  };

  it("#21 a generic treatment-efficacy guideline never establishes duration support", () => {
    // The archetype: diagnosis-matched, hierarchy-topping, duration-silent.
    const claim = deriveGuidelineDurationClaim({ title: "AAOS knee osteoarthritis guideline", year: "2023", quote: "Arthroplasty is recommended for end-stage disease." });
    expect(claim).toBeUndefined();
    const r = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureAcute,
      service: "Total knee arthroplasty",
      guidelineEvidence: [{ text: "“Arthroplasty is recommended for end-stage disease.” — AAOS knee osteoarthritis guideline (2023)", source: "Clinical practice guideline", duration: claim }],
    });
    expect(r.clinicallySupported).toBe(false);
    expect(r.bases.length).toBe(0);
    expect(r.status).toBe("ASSUMPTION_PENDING_REVIEW");
  });

  it("#22 a diagnosis-compatible but duration-silent guideline does not support the duration", () => {
    // End-to-end: the dossier keeps the guideline for MEDICAL NECESSITY, but
    // the lifetime verdict stays unsupported.
    const genericGuideline: Cond = {
      ...fractureAcute,
      socAnalysis: { guidelines: [{ title: "Knee injury rehabilitation guideline", year: "2022", quote: "Supervised rehabilitation improves functional outcomes after knee injury.", relevance: { evidenceLevel: 1, evidenceLabel: "Clinical practice guideline" } }] },
    };
    const a = buildReasoningAssessment(item(), [genericGuideline], [], kase);
    expect(a.durationSupport.clinicallySupported).toBe(false);
    expect(a.durationSupport.status).toBe("ASSUMPTION_PENDING_REVIEW");
    // …while the guideline still supports necessity elsewhere:
    const d = buildRecommendationDossier(item(), genericGuideline, [], kase);
    expect(d.supportingEvidence.guidelines.length).toBe(1);
    expect(d.supportingEvidence.guidelines[0].duration).toBeUndefined();
  });

  it("#23 a verified duration claim supports it, and the basis carries sourceId + quote", () => {
    const a = buildReasoningAssessment(item(), [fractureWithGuideline], [], kase);
    expect(a.durationSupport.status).toBe("SUPPORTED_BY_GUIDELINE");
    expect(a.durationSupport.clinicallySupported).toBe(true);
    const basis = a.durationSupport.bases.find((b) => b.kind === "guideline_natural_history");
    expect(basis?.source).toBe("Long-term management of post-traumatic knee injury (2023)");
    expect(basis?.text).toMatch(/lifelong surveillance is recommended after intra-articular fracture/i);
    expect(a.durationRationale).toMatch(/remaining-lifetime projection is based on diagnosis-keyed clinical guidance/i);
    // The derived claim itself is structured and attributed:
    const claim = deriveGuidelineDurationClaim({ title: "Long-term management of post-traumatic knee injury", year: "2023", quote: "Lifelong surveillance is recommended after intra-articular fracture." });
    expect(claim?.supportsDuration).toBe(true);
    expect(claim?.durationType).toBe("long_term_surveillance");
    expect(claim?.sourceId).toBe("Long-term management of post-traumatic knee injury");
    expect(claim?.quote).toBe("Lifelong surveillance is recommended after intra-articular fracture.");
  });

  it("#24 a wrong-anatomy guideline is dropped at construction; a wrong-service claim fails the service match", () => {
    // Wrong anatomy: a shoulder guideline with genuine duration language never
    // reaches a knee item's duration verdict (upstream anatomy gate).
    const shoulderGuideline: Cond = {
      ...fractureAcute,
      socAnalysis: { guidelines: [{ title: "Rotator cuff tear management guideline", year: "2021", quote: "Progressive degeneration of the shoulder is expected; lifelong surveillance is recommended.", relevance: { evidenceLevel: 1 } }] },
    };
    const a = buildReasoningAssessment(item({ service: "Knee brace replacement", category: "MOBILITY_AID" }), [shoulderGuideline], [], kase);
    expect(a.durationSupport.clinicallySupported).toBe(false);
    // Wrong service: a service-specific claim counts only when the item's
    // service matches its stated scope.
    const serviceClaim = {
      text: "Prosthesis replacement every 15 years — Arthroplasty implant survivorship guideline (2020)",
      source: "Clinical practice guideline",
      duration: {
        supportsDuration: true,
        durationType: "lifetime_replacement" as const,
        durationClaim: "Prosthesis replacement is expected every 15 years within the patient's lifetime.",
        sourceId: "Arthroplasty implant survivorship guideline",
        serviceSpecific: true,
        applicability: "total knee arthroplasty prosthesis replacement",
      },
    };
    const wrongService = assessLifetimeSupport({ isLifetime: true, condition: fractureAcute, service: "Attendant care", guidelineEvidence: [serviceClaim] });
    expect(wrongService.clinicallySupported).toBe(false);
    const rightService = assessLifetimeSupport({ isLifetime: true, condition: fractureAcute, service: "Total knee arthroplasty", guidelineEvidence: [serviceClaim] });
    expect(rightService.status).toBe("SUPPORTED_BY_GUIDELINE");
  });

  it("#25 an attributed professional duration opinion stays a separately labeled basis, never a guideline", () => {
    const r = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureAcute,
      guidelineEvidence: [durationGuideline],
      providerOpinions: [{ text: "She will require lifelong assistance with transfers.", providerName: "Dr. Brandt" }],
    });
    expect(r.status).toBe("MULTIPLE_SUPPORTS");
    const prof = r.bases.find((b) => b.kind === "professional_duration_opinion");
    expect(prof?.source).toBe("Dr. Brandt (attributed professional opinion)");
    const guide = r.bases.find((b) => b.kind === "guideline_natural_history");
    expect(guide?.source).toMatch(/Long-term management of post-traumatic knee injury/);
  });

  it("#26 a bare approval remains adoption-only even when a duration-silent guideline is present", () => {
    const r = assessLifetimeSupport({
      isLifetime: true,
      condition: fractureAcute,
      physicianStatus: "APPROVED",
      guidelineEvidence: [{ text: "“Arthroplasty is recommended for end-stage disease.” — AAOS knee osteoarthritis guideline (2023)", source: "Clinical practice guideline" }],
    });
    expect(r.professionalAdoption).toBe(true);
    expect(r.clinicallySupported).toBe(false);
    expect(r.status).toBe("INSUFFICIENT");
    expect(r.mayEnterFinalizedTotals).toBe(true); // adoption policy unchanged
  });
});

// ── Contradictory duration language policy ───────────────────────────────────
describe("contradictory guideline duration language", () => {
  const supporting = {
    text: "Natural-history guideline",
    duration: { supportsDuration: true, durationType: "natural_history" as const, durationClaim: "The natural history is progressive degeneration.", sourceId: "Natural-history guideline" },
  };
  const contradicting = {
    text: "“Long-term bracing is not recommended.” — Bracing guideline (2024)",
    duration: deriveGuidelineDurationClaim({ title: "Bracing guideline", year: "2024", quote: "Long-term bracing is not recommended; use should be time-limited." }),
  };

  it("derives contradictsDuration from contradicting guidance text", () => {
    expect(contradicting.duration?.contradictsDuration).toBe(true);
    expect(contradicting.duration?.supportsDuration).toBe(false);
  });

  it("withdraws guideline-only support when a contradicting guideline exists, and says so", () => {
    const r = assessLifetimeSupport({ isLifetime: true, condition: fractureAcute, guidelineEvidence: [supporting, contradicting] });
    expect(r.clinicallySupported).toBe(false);
    expect(r.status).toBe("ASSUMPTION_PENDING_REVIEW");
    expect(r.uncertaintyNotes.join(" ")).toMatch(/contradictory duration language \(Bracing guideline\).*withdrawn pending reconciliation/i);
  });

  it("keeps support only on an independent non-guideline basis, with the conflict still surfaced", () => {
    const r = assessLifetimeSupport({ isLifetime: true, condition: fractureChronicPrognosis, guidelineEvidence: [supporting, contradicting] });
    expect(r.clinicallySupported).toBe(true);
    expect(r.bases.some((b) => b.kind === "record_chronicity")).toBe(true);
    expect(r.bases.some((b) => b.kind === "guideline_natural_history")).toBe(true); // retained, not silent — the note discloses it
    expect(r.uncertaintyNotes.join(" ")).toMatch(/contradictory duration language.*disclosed for reconciliation/i);
  });

  it("a newly appearing contradiction changes the fingerprint even when the bases stand", () => {
    const without = assessLifetimeSupport({ isLifetime: true, condition: fractureChronicPrognosis });
    const withContradiction = assessLifetimeSupport({ isLifetime: true, condition: fractureChronicPrognosis, guidelineEvidence: [contradicting] });
    expect(withContradiction.fingerprint).not.toBe(without.fingerprint);
  });
});

// ── The deterministic duration-claim detector ────────────────────────────────
describe("deriveGuidelineDurationClaim — construction-site derivation", () => {
  it("never manufactures a claim from a title alone", () => {
    expect(deriveGuidelineDurationClaim({ title: "Lifetime management of chronic progressive knee disease" })).toBeUndefined();
    expect(deriveGuidelineDurationClaim({ title: "Lifetime management of chronic progressive knee disease", quote: "Weight loss is advised." })).toBeUndefined();
  });

  it("maps duration-relevant guidance text to its claim type", () => {
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "The natural history of post-traumatic arthritis is gradual joint deterioration." })?.durationType).toBe("natural_history");
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "The impairment is permanent." })?.durationType).toBe("permanence");
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "The condition follows a progressive course." })?.durationType).toBe("progressive_course");
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "Prosthesis replacement is expected every 15 years." })?.durationType).toBe("lifetime_replacement");
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "Symptoms are chronic with episodic recurrence over decades." })?.durationType).toBe("chronic_recurrence");
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "Indefinite maintenance treatment is indicated." })?.durationType).toBe("indefinite_treatment");
    expect(deriveGuidelineDurationClaim({ title: "G", quote: "Continuing utilization of attendant services is expected." })?.durationType).toBe("continuing_utilization");
  });

  it("extracts the claim sentence and attributes the source", () => {
    const c = deriveGuidelineDurationClaim({ title: "Fracture guideline", year: "2023", quote: "Fixation is standard of care. Lifelong surveillance is recommended thereafter." });
    expect(c?.durationClaim).toBe("Lifelong surveillance is recommended thereafter.");
    expect(c?.sourceId).toBe("Fracture guideline");
    expect(c?.sourceVersion).toBe("2023");
  });

  it("passes explicit per-entry source metadata through, normalized", () => {
    const c = deriveGuidelineDurationClaim({
      title: "Implant survivorship guideline",
      year: "2020",
      quote: "Revision is anticipated within the patient's lifetime.",
      duration: { supportsDuration: true, durationType: "lifetime_replacement", durationClaim: "Revision is anticipated within the patient's lifetime.", serviceSpecific: true, applicability: "knee arthroplasty" },
    });
    expect(c?.supportsDuration).toBe(true);
    expect(c?.durationType).toBe("lifetime_replacement");
    expect(c?.sourceId).toBe("Implant survivorship guideline"); // defaulted from the title
    expect(c?.serviceSpecific).toBe(true);
  });

  it("matches service scope conservatively", () => {
    expect(guidelineServiceMatches("total knee arthroplasty prosthesis replacement", "Total knee arthroplasty")).toBe(true);
    expect(guidelineServiceMatches("physical therapy maintenance program", "Occupational therapy")).toBe(false);
    expect(guidelineServiceMatches("", "Attendant care")).toBe(false);
  });
});

// ── (9)–(10) Narrative honesty ───────────────────────────────────────────────
describe("narrative honesty (#9–#10)", () => {
  it("#9 unsupported lifetime narratives use projection/assumption language and never claim chronic progression", () => {
    const a = buildReasoningAssessment(item(), [fractureAcute], [], kase);
    expect(a.durationRationale).toMatch(/remaining-lifetime scenario is shown as a projection assumption/i);
    expect(a.durationRationale).toMatch(/not itself evidence of permanence/i);
    expect(a.durationRationale).not.toMatch(/chronic|progressive/i);
    const w = a.weakeningEvidence.find((x) => x.claim === "duration");
    expect(w?.detail).toMatch(/projection assumption/i);
    expect(a.selfCritique.assumptions.join(" ")).toMatch(/remaining-lifetime horizon is a projection assumption/i);
  });

  it("#10 supported lifetime narratives name the independent basis", () => {
    const a = buildReasoningAssessment(item(), [fractureChronicPrognosis], [], kase);
    expect(a.durationRationale).toMatch(/remaining-lifetime projection is based on documented chronicity in the condition record \(prognosis\.pdf, p\. 12\)/i);
    expect(a.durationRationale).toMatch(/remaining life-expectancy horizon/i);
    expect(a.weakeningEvidence.some((x) => x.claim === "duration")).toBe(false); // nothing manufactured
  });
});

// ── (11) Financial determinism — lifetime math untouched ─────────────────────
describe("financial scenarios preserved (#11)", () => {
  const assumptions: CaseAssumptions = { lifeExpectancyYears: 30, medicalInflation: 0.03, discountRate: 0.02, geographicFactor: 1.0 } as CaseAssumptions;
  const input = { category: "ATTENDANT_CARE", unitCost: 500, unitIsVenueFinal: true, frequencyPerYear: 12, durationYears: null, isLifetime: true } as const;

  it("identical financial inputs yield identical lifetime costs — clinical support is not a cost input", () => {
    const p1 = project({ ...input } as never, assumptions);
    const p2 = project({ ...input } as never, assumptions);
    expect(p2).toEqual(p1);
    expect(p1.years).toBe(30); // the full projection horizon, regardless of duration-support status
    expect(p1.lifetimeCost).toBeGreaterThan(0);
  });
});

// ── (12) Unsupported lifetime items follow existing policy, never disappear ──
describe("unsupported lifetime scenarios stay disclosed (#12)", () => {
  it("a totaled unsupported lifetime line raises the finding (blocking unless adopted) but keeps its projection", () => {
    const pending = item({ id: "p", physicianStatus: "PENDING", presentValue: 250_000 });
    const findings = reasoningFindings([pending], [fractureAcute], [], kase, new Set(["p"]));
    const f = findings.find((x) => x.result === "Unsupported lifetime duration");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("Critical"); // financially material — unchanged policy
    expect(f?.exportBlocking).toBe(true);
    expect(f?.issue).toMatch(/projection assumption/i);
    // The assessment still carries the full lifetime projection — nothing dropped.
    const a = buildReasoningAssessment(pending, [fractureAcute], [], kase);
    expect(a.durationClass).toBe("LIFETIME");
    expect(["included", "excluded", "contingency"]).toContain(a.inclusionInTotalsStatus);
  });

  it("professional adoption lifts the export block per existing policy while the disclosure remains", () => {
    const approved = item({ id: "a", physicianStatus: "APPROVED", presentValue: 250_000 });
    const findings = reasoningFindings([approved], [fractureAcute], [], kase, new Set(["a"]));
    const f = findings.find((x) => x.result === "Unsupported lifetime duration");
    expect(f).toBeTruthy(); // still disclosed — adoption is not evidence
    expect(f?.exportBlocking).toBe(false); // but the existing adoption policy governs export
  });
});

// ── (13) Lifecycle — duration-support changes are material ───────────────────
describe("duration-support changes are material (#13)", () => {
  it("new duration-support evidence changes the material hash (supersede + approval invalidation trigger)", () => {
    const before = buildReasoningAssessment(item(), [fractureAcute], [], kase);
    const after = buildReasoningAssessment(item(), [fractureChronicPrognosis], [], kase);
    expect(after.materialHash).not.toBe(before.materialHash);
    expect(after.durationSupport.fingerprint).not.toBe(before.durationSupport.fingerprint);
  });

  it("a new attributed professional duration rationale changes the material hash", () => {
    const noOpinion = buildReasoningAssessment(item({ physicianStatus: "MODIFIED", physicianNote: "Please verify the unit pricing." }), [fractureAcute], [], kase);
    const withOpinion = buildReasoningAssessment(item({ physicianStatus: "MODIFIED", physicianNote: "Lifetime support is required given the permanent deficit." }), [fractureAcute], [], kase);
    expect(withOpinion.materialHash).not.toBe(noOpinion.materialHash);
  });

  it("an unchanged item re-runs to an identical hash (idempotent cache key)", () => {
    const a = buildReasoningAssessment(item(), [fractureAcute], [], kase);
    const b = buildReasoningAssessment(item(), [fractureAcute], [], kase);
    expect(b.materialHash).toBe(a.materialHash);
  });
});

// ── (14) Non-lifetime duration classes unchanged ─────────────────────────────
describe("short-term / fixed / episodic / conditional items unchanged (#14)", () => {
  it("keeps the existing classes and rationales for every non-lifetime duration", () => {
    const one = buildReasoningAssessment(item({ isLifetime: false, durationYears: 0 }), [fractureAcute], [], kase);
    expect(one.durationClass).toBe("ONE_TIME");
    const short = buildReasoningAssessment(item({ isLifetime: false, durationYears: 1 }), [fractureAcute], [], kase);
    expect(short.durationClass).toBe("SHORT_TERM");
    const episodic = buildReasoningAssessment(item({ isLifetime: false, durationYears: 5, service: "Physical therapy", category: "PHYSICAL_THERAPY" }), [fractureAcute], [], kase);
    expect(episodic.durationClass).toBe("EPISODIC");
    const multi = buildReasoningAssessment(item({ isLifetime: false, durationYears: 5 }), [fractureAcute], [], kase);
    expect(multi.durationClass).toBe("MULTI_YEAR");
    expect(multi.durationRationale).toMatch(/multi-year course/i);
    const conditional = buildReasoningAssessment(item({ isLifetime: false, startTrigger: "loss of caregiver support" }), [fractureAcute], [], kase);
    expect(conditional.durationClass).toBe("CONDITIONAL");
    expect(conditional.durationRationale).toMatch(/excluded from finalized totals until the trigger is met/i);
  });
});
