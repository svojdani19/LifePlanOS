import { describe, it, expect } from "vitest";
import { classifyAssertion, claimsAssertedBy, assertionSupportsClaim, CLAIM_REQUIRES } from "@/lib/engine/assertionClassifier";
import { buildLedgerForItem, EVIDENCE_CLAIMS, type CandidateSource } from "@/lib/engine/evidenceLedger";

// The defect this module exists for: on the reference case the ledger held 698
// rows under NECESSITY, 698 under FREQUENCY and 698 under DURATION — one pool
// of pertinent quotes, filed three times, because the strength gate cannot ask
// whether a sentence SAYS anything about how often a service is needed.

describe("a source is read for what it actually says", () => {
  it("does not let an imaging finding speak to frequency or duration", () => {
    const a = classifyAssertion({ quote: "MRI shows a full-thickness supraspinatus tear with retraction" });
    expect(a.supportsSpecificIntervention).toBe(true);
    expect(a.statesCadence).toBe(false);
    expect(a.statesDuration).toBe(false);
  });

  it("reads a cadence when one is stated, in the several ways clinicians state it", () => {
    for (const q of [
      "Physical therapy 3x per week",
      "Attends therapy twice weekly",
      "Injections every 3 months",
      "Gabapentin 300 mg TID",
      "Home exercise program daily",
    ]) {
      expect(classifyAssertion({ quote: q }).statesCadence, q).toBe(true);
    }
  });

  it("reads a duration when one is stated, and not otherwise", () => {
    expect(classifyAssertion({ quote: "Continue therapy for 12 weeks" }).statesDuration).toBe(true);
    expect(classifyAssertion({ quote: "6-week course of physical therapy" }).statesDuration).toBe(true);
    expect(classifyAssertion({ quote: "Expected to require bracing lifelong" }).statesDuration).toBe(true);
    expect(classifyAssertion({ quote: "Patient seen in clinic today" }).statesDuration).toBe(false);
  });

  it("separates a symptom from a functional deficit", () => {
    // Pain is a symptom. FUNCTIONAL_NEED asks what the patient cannot do, and
    // treating every complaint as a deficit is how a claim gets over-supported.
    expect(classifyAssertion({ quote: "Reports ongoing low back pain" }).statesFunctionalDeficit).toBe(false);
    expect(classifyAssertion({ quote: "Unable to climb stairs without assistance" }).statesFunctionalDeficit).toBe(true);
    expect(classifyAssertion({ quote: "Lifting restriction of 10 pounds" }).statesFunctionalDeficit).toBe(true);
  });

  it("separates treatment delivered from what the treatment achieved", () => {
    const delivered = classifyAssertion({ quote: "Underwent right L4-5 epidural steroid injection" });
    expect(delivered.statesPriorTreatment).toBe(true);
    expect(delivered.statesTreatmentResponse).toBe(false);

    const response = classifyAssertion({ quote: "Completed 12 sessions of physical therapy with no lasting relief" });
    expect(response.statesPriorTreatment).toBe(true);
    expect(response.statesTreatmentResponse).toBe(true);
  });

  it("recognises a cost basis only from an actual price or billed code", () => {
    expect(classifyAssertion({ quote: "CPT 27447 allowed amount $28,400" }).providesCostBasis).toBe(true);
    expect(classifyAssertion({ quote: "Total knee arthroplasty recommended" }).providesCostBasis).toBe(false);
  });

  it("treats a NEGATIVE finding as speaking to the same question", () => {
    // Direction is the `stance` column's job. If an absence asserted nothing,
    // every finding that argues AGAINST a recommendation would vanish — the
    // same silent-deletion failure, in reverse.
    const a = classifyAssertion({ quote: "MRI of the lumbar spine is unremarkable; no structural abnormality" });
    expect(a.supportsSpecificIntervention).toBe(true);
  });
});

describe("structure beats lexicon", () => {
  it("takes the recorded field's word for what a quote is", () => {
    // No lexical cue whatsoever; the extraction already parsed the field.
    const a = classifyAssertion({ quote: "Ambulates 40 feet before stopping", field: "functionalStatus" });
    expect(a.statesFunctionalDeficit).toBe(true);
  });

  it("still adds what the sentence says beyond its field", () => {
    const a = classifyAssertion({ quote: "Therapy twice weekly, no meaningful improvement", field: "treatment" });
    expect(a.statesPriorTreatment).toBe(true); // from the field
    expect(a.statesCadence).toBe(true); // from the text
    expect(a.statesTreatmentResponse).toBe(true); // from the text
  });

  it("lets a caller's structured knowledge override both", () => {
    // A guideline whose duration claim was parsed upstream states a duration
    // whatever its prose looks like.
    const a = classifyAssertion({ quote: "Clinical practice guideline for knee osteoarthritis", asserts: { statesDuration: true } });
    expect(a.statesDuration).toBe(true);
  });
});

describe("the gate composes with the strength gate rather than replacing it", () => {
  const PT = { id: "i", service: "Physical therapy", category: "PHYSICAL_THERAPY", conditionId: "c" };
  const s = (over: Partial<CandidateSource> & { strength: CandidateSource["strength"]; quote: string }): CandidateSource => ({
    sourceKind: "CHRONOLOGY_EVENT",
    ...over,
  });

  it("refuses a claim the source is the right STRENGTH for but says nothing about", () => {
    // GUIDELINE strength may establish frequency for therapy. This guideline
    // does not mention one, so it establishes none.
    const rows = buildLedgerForItem(PT, [s({ strength: "GUIDELINE", sourceKind: "GUIDELINE", quote: "Exercise therapy is recommended for chronic low back pain" })]);
    expect(rows.some((r) => r.claim === "FREQUENCY")).toBe(false);
  });

  it("admits it when the same source does mention one", () => {
    const rows = buildLedgerForItem(PT, [s({ strength: "GUIDELINE", sourceKind: "GUIDELINE", quote: "Supervised exercise therapy twice weekly for 8 weeks" })]);
    expect(rows.some((r) => r.claim === "FREQUENCY")).toBe(true);
    expect(rows.some((r) => r.claim === "DURATION")).toBe(true);
  });

  it("still refuses a claim the source SAYS something about but is too weak to carry", () => {
    // A patient's own account of a cadence is not evidence of the required
    // frequency of care. Semantics passes; strength does not.
    const rows = buildLedgerForItem(PT, [s({ strength: "REPORTED", sourceKind: "INTERVIEW", quote: "Says he does his exercises daily" })]);
    expect(rows.some((r) => r.claim === "FREQUENCY")).toBe(false);
  });

  it("no longer files one quote under three claims at once", () => {
    // The shape of the original defect, at the smallest scale that shows it.
    const rows = buildLedgerForItem(PT, [s({ strength: "OBJECTIVE", quote: "MRI shows L4-5 disc herniation with nerve root contact" })]);
    expect(rows.map((r) => r.claim)).toEqual(["NECESSITY"]);
  });
});

describe("every claim is reachable, and none is reachable by everything", () => {
  it("has a stated semantic requirement for each claim", () => {
    for (const claim of EVIDENCE_CLAIMS) expect(CLAIM_REQUIRES[claim].length, claim).toBeGreaterThan(0);
  });

  it("finds a real quote that satisfies each claim's requirement", () => {
    const witnesses: Record<string, string> = {
      NECESSITY: "Assessment: right knee osteoarthritis, Kellgren grade 4",
      FREQUENCY: "Therapy 2x per week",
      DURATION: "Continue for 12 weeks",
      FUNCTIONAL_NEED: "Unable to climb stairs without assistance",
      PRIOR_TREATMENT: "Underwent arthroscopy in 2019",
      COST: "CPT 27447 allowed amount $28,400",
    };
    for (const claim of EVIDENCE_CLAIMS) {
      expect(claimsAssertedBy({ quote: witnesses[claim] }), claim).toContain(claim);
    }
  });

  it("asserts nothing at all for text that asserts nothing at all", () => {
    const profile = classifyAssertion({ quote: "Patient presented to the office and was seen by the provider." });
    expect(EVIDENCE_CLAIMS.every((c) => !assertionSupportsClaim(profile, c))).toBe(true);
  });
});

describe("a statement of preserved function is not a functional deficit", () => {
  it("does not read independence as a deficit, even from the functionalStatus field", () => {
    // Seen on the reference case: "The patient was independent with activities
    // of daily living" appeared under FUNCTIONAL NEED — a finding of preserved
    // function offered as support for the care that addresses its loss.
    const a = classifyAssertion({ quote: "The patient was independent with activities of daily living", field: "functionalStatus" });
    expect(a.statesFunctionalDeficit).toBe(false);
  });

  it("covers the several ways a record states preserved function", () => {
    // All seen on the reference case, all filed as functional NEED because the
    // field was called `functionalStatus`.
    for (const q of [
      "The patient was able to care for self",
      "The patient was independent with activities of daily living",
      "Ambulates independently without assistance",
      "Returned to full duty without restriction",
    ]) {
      expect(classifyAssertion({ quote: q, field: "functionalStatus" }).statesFunctionalDeficit, q).toBe(false);
    }
  });

  it("keeps the deficit when the same sentence also states one", () => {
    const a = classifyAssertion({ quote: "Independent with self-care but unable to climb stairs", field: "functionalStatus" });
    expect(a.statesFunctionalDeficit).toBe(true);
  });

  it("still reads a deficit stated in ADL terms", () => {
    expect(classifyAssertion({ quote: "Requires assistance with activities of daily living" }).statesFunctionalDeficit).toBe(true);
    expect(classifyAssertion({ quote: "Difficulty with ADLs since the injury" }).statesFunctionalDeficit).toBe(true);
  });
});
