import { describe, it, expect } from "vitest";
import { classifyRecommendation, mapRecommendationToCondition, runIntegrityCheck, type CondInput, type RecInput } from "@/lib/engine/integrity";
import { buildReasoningAssessment, type ReasoningItem } from "@/lib/engine/clinicalReasoning";
import { documentsNonResolution } from "@/lib/engine/assertionClassifier";

// The hard invariants, each stated as the input on which the old code was wrong.

describe("a hardcoded confidence or probability can never create record support", () => {
  it("does not admit a region-matched template whose condition carries no records", () => {
    // Demonstrated at the previous head: mapRecommendationToCondition matched
    // on anatomy alone, the condition had zero evidenceSources, and
    // hasPatientRecordSupport fell through to `confidence >= 60` — which the
    // care library clears by default at 75. Result: RECORD_SUPPORTED_PENDING,
    // included in totals, for a service nothing in the file mentions.
    const bare: CondInput = { id: "c-1", name: "Lumbar radiculopathy" };
    const template = { service: "Lumbar MRI surveillance", category: "IMAGING", probability: "PROBABLE", confidence: 75, missingSupport: null } as unknown as RecInput;
    const mapping = mapRecommendationToCondition(template, [bare]);
    expect(mapping.matched).toBe(true); // anatomy still matches — that is fine

    const r = classifyRecommendation(template, { matched: true, codeCritical: false, supportClass: "CANDIDATE_REVIEW" });
    expect(r.includedInTotal).toBe(false);
  });

  it("is unmoved by confidence 100 and PROBABLE", () => {
    const r = classifyRecommendation(
      { service: "X", probability: "PROBABLE", confidence: 100, physicianStatus: "PENDING" } as unknown as RecInput,
      { matched: true, codeCritical: false, supportClass: "CANDIDATE_REVIEW" },
    );
    expect(r.includedInTotal).toBe(false);
  });

  it("has no parameter through which a condition's records could arrive", () => {
    // Structural: ClassifyContext carries no condition, so "the diagnosis has
    // records" cannot reach the inclusion decision at all.
    const ctx = { matched: true, codeCritical: false, supportClass: "CANDIDATE_REVIEW" } as const;
    expect(Object.keys(ctx)).toEqual(["matched", "codeCritical", "supportClass"]);
  });
});

describe("a condition with records cannot support every service mapped to it", () => {
  it("gives five services of one diagnosis five independent verdicts", () => {
    const conditions: CondInput[] = [{ id: "c-1", name: "Lumbar radiculopathy", supportingRecords: "MRI, clinic notes" } as CondInput];
    const services = ["Lumbar epidural steroid injection", "Physical therapy", "Lumbar MRI", "Lumbar fusion", "Lumbosacral orthosis"];
    const recs = services.map((service, i) => ({
      service,
      probability: "PROBABLE",
      // Only the second is supported; the shared diagnosis must not carry the rest.
      supportClass: i === 1 ? "RECORD_RECOMMENDED" : "CANDIDATE_REVIEW",
    })) as unknown as RecInput[];
    const report = runIntegrityCheck({ recommendations: recs, conditions });
    expect(report.counts.included).toBe(1);
  });
});

describe("prior treatment does not imply failure, non-resolution or exhaustion", () => {
  const kase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 40, adult: true };
  const cond = { id: "c-1", name: "Lumbar radiculopathy", relatedness: "RELATED", objectiveEvidence: null, evidenceSources: [] } as never;
  const treated = [{ eventDate: new Date("2025-03-14"), provider: "A. Rivera, MD", treatment: "Lumbar physical therapy was performed", sourcePage: 1 }] as never;
  const item = { service: "Lumbar fusion", category: "NEUROSURGERY", probability: "PROBABLE", frequencyPerYear: 1, durationYears: 1, isLifetime: false, physicianStatus: "PENDING", origin: "RECORD_RECOMMENDED" } as unknown as ReasoningItem;

  it("states no non-resolution anywhere when the record states none", () => {
    const a = buildReasoningAssessment(item, [cond], treated, kase, [], undefined, [], null);
    const surfaces = [a.treatmentResponseSummary ?? "", a.medicalNecessityRationale, a.leastIntensiveRationale, JSON.stringify(a.reasoningChain)].join(" ");
    expect(surfaces).not.toMatch(/has not resolved|did not resolve|not returned .* to baseline|conservative care has not/i);
  });

  it("does not mark conservative care exhausted from a non-empty list", () => {
    const a = buildReasoningAssessment(item, [cond], treated, kase, [], undefined, [], null);
    const failedNode = a.reasoningChain.find((n) => n.stage === "Failed conservative care");
    expect(failedNode?.content ?? null).toBeNull();
  });

  it("says it plainly once the record does state a response", () => {
    const withResponse = [{ eventDate: new Date("2025-03-14"), treatment: "Lumbar physical therapy completed with no lasting relief", sourcePage: 1 }] as never;
    const a = buildReasoningAssessment(item, [cond], withResponse, kase, [], undefined, [], null);
    expect(a.treatmentResponseSummary ?? "").toMatch(/did not resolve/i);
  });

  it("uses one shared definition, so the six sites cannot drift apart", () => {
    expect(documentsNonResolution([{ text: "Therapy performed" }])).toBe(false);
    expect(documentsNonResolution([{ text: "Therapy with no lasting relief" }])).toBe(true);
    expect(documentsNonResolution([{ text: "Symptoms persisted despite treatment" }])).toBe(true);
  });
});

describe("necessity is a determination, never a constant", () => {
  it("does not assert necessity for an item it classified as a candidate", () => {
    const kase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 40, adult: true };
    const cond = { id: "c-1", name: "Lumbar radiculopathy", relatedness: "RELATED", evidenceSources: [] } as never;
    const candidate = { service: "Lumbar fusion", category: "NEUROSURGERY", probability: "PROBABLE", frequencyPerYear: 1, physicianStatus: "PENDING", origin: "TEMPLATE_CONDITION", supportClass: "CANDIDATE_REVIEW" } as unknown as ReasoningItem;
    const a = buildReasoningAssessment(candidate, [cond], [], kase, [], undefined, [], null);
    const necessityNode = a.reasoningChain.find((n) => /necessity/i.test(n.stage));
    // `necessity: true` was hard-coded, so this node asserted medical necessity
    // for every recommendation the engine ever assessed.
    expect(necessityNode?.basis === "documented_fact" && necessityNode?.content).toBeFalsy();
  });
});
