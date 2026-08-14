import { describe, expect, it } from "vitest";
import { adjudicatePatientAttribution, candidatePatientAttributions, withinEdits } from "@/lib/records/patientAttribution";
import type { MergedEntry } from "@/lib/records/entryMerge";
import type { LlmProvider } from "@/lib/llm";

// Synthetic throughout. The scenario mirrors the real failure: a home-health
// PT evaluation whose "provider" was the patient's own name, OCR-mangled two
// edits away — past the deterministic exclusion's one-edit reach.

const note = (over: Partial<MergedEntry> = {}): MergedEntry => ({
  rowIds: ["r1"],
  sourceDocumentId: "doc-1",
  klass: "THERAPY_COURSE" as MergedEntry["klass"],
  encounterDate: new Date("2024-03-22T00:00:00Z"),
  provider: "Demick MCHENRY",
  facility: null,
  pageStart: 1010,
  pageEnd: 1010,
  claims: [
    { id: "c1", field: "objectiveFindings", value: "Physical therapy evaluation post lumbar laminectomy", excerpt: "PT eval post laminectomy", page: 1010 },
  ],
  mergedClasses: [],
  ...over,
});

const PATIENT = "Derrick DeWayne McHenry";

describe("who resembles the patient closely enough to ask about", () => {
  it("flags an OCR-mangled patient name two edits off", () => {
    expect(candidatePatientAttributions([note()], PATIENT)).toHaveLength(1);
  });

  it("never flags an unrelated clinician", () => {
    expect(candidatePatientAttributions([note({ provider: "Paul English, MD" })], PATIENT)).toHaveLength(0);
    expect(candidatePatientAttributions([note({ provider: "Fernando Techy" })], PATIENT)).toHaveLength(0);
  });

  it("flags a shared surname — the model decides, not the filter", () => {
    // A clinician relative is possible; candidacy only means the question is
    // worth asking with the entry's text in front of the model.
    expect(candidatePatientAttributions([note({ provider: "Sarah McHenry, RN" })], PATIENT)).toHaveLength(1);
  });

  it("ignores unattributed entries and empty patient names", () => {
    expect(candidatePatientAttributions([note({ provider: null })], PATIENT)).toHaveLength(0);
    expect(candidatePatientAttributions([note()], null)).toHaveLength(0);
  });

  it("does not stretch short tokens to two edits", () => {
    // Two edits in a short name is a different name, not OCR noise.
    expect(withinEdits("chan", "chen", 1)).toBe(true);
    expect(withinEdits("cole", "kale", 1)).toBe(false);
  });
});

const modelSaying = (reply: string): LlmProvider =>
  ({ complete: async () => reply, name: "fake", model: "fake" }) as unknown as LlmProvider;

describe("clearing an attribution takes a confident verdict", () => {
  it("strips the provider when the model is confident it is the patient", async () => {
    const n = note({ appearances: [{ documentId: "doc-1", pageStart: 1010, pageEnd: 1010, rowIds: ["r1"], provider: "Demick MCHENRY", contentHash: "x" }] });
    const outcome = await adjudicatePatientAttribution([n], PATIENT, {
      provider: modelSaying('{"is_patient": true, "confidence": "high", "reason": "OCR variant of the patient\'s own name in a home PT note."}'),
    });
    expect(outcome.cleared).toHaveLength(1);
    expect(n.provider).toBeNull();
    expect(n.appearances?.[0].provider).toBeNull();
  });

  it("keeps the provider on anything short of high confidence", async () => {
    const n = note();
    const outcome = await adjudicatePatientAttribution([n], PATIENT, {
      provider: modelSaying('{"is_patient": true, "confidence": "medium", "reason": "Could be a relative."}'),
    });
    expect(outcome.cleared).toHaveLength(0);
    expect(n.provider).toBe("Demick MCHENRY");
  });

  it("keeps the provider on a malformed answer, counting the failure", async () => {
    const n = note();
    const outcome = await adjudicatePatientAttribution([n], PATIENT, { provider: modelSaying("I think it is the patient.") });
    expect(outcome.failed).toBe(1);
    expect(n.provider).toBe("Demick MCHENRY");
  });

  it("keeps the provider when the model call throws", async () => {
    const n = note();
    const boom = { complete: async () => { throw new Error("timeout"); } } as unknown as LlmProvider;
    const outcome = await adjudicatePatientAttribution([n], PATIENT, { provider: boom });
    expect(outcome.failed).toBe(1);
    expect(n.provider).toBe("Demick MCHENRY");
  });

  it("asks nothing when no entry resembles the patient", async () => {
    const n = note({ provider: "Paul English, MD" });
    const outcome = await adjudicatePatientAttribution([n], PATIENT, {
      provider: { complete: async () => { throw new Error("must not be called"); } } as unknown as LlmProvider,
    });
    expect(outcome.asked).toBe(0);
    expect(n.provider).toBe("Paul English, MD");
  });
});
