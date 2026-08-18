// ─────────────────────────────────────────────────────────────────────────────
// A panel may only claim what the record actually says.
//
// Three over-claims lived here, and each was the same shape: the EXISTENCE of
// something was read as a statement ABOUT it.
//
//   • any prior treatment, or any guideline, established the frequency —
//     even when neither said a word about how often;
//   • any prior treatment established that conservative care "has not
//     resolved the impairment";
//   • every causation quote was filed as an objective finding, including a
//     clinician's diagnosis, a past-medical-history mention (which argues the
//     condition PRE-DATES the incident) and a statement that no objective
//     finding exists at all.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { buildReasoningAssessment } from "@/lib/engine/clinicalReasoning";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase, type DossierItem } from "@/lib/engine/medicalNecessity";

const KASE: DossierCase = { subject: "the patient", pronounPoss: "their", lifeExpectancyYears: 40, adult: true };

const condition = (over: Partial<DossierCondition> = {}): DossierCondition =>
  ({
    id: "c-1",
    name: "Lumbar radiculopathy",
    relatedness: "RELATED",
    reasoning: "Injury-related.",
    objectiveEvidence: "\"MRI shows L5-S1 disc protrusion\" — diagnostic study, Imaging.pdf, p. 3 (2025-03-14)",
    evidenceSources: [],
    ...over,
  }) as DossierCondition;

const item = (over: Partial<DossierItem> = {}): DossierItem =>
  ({
    id: "i-1",
    service: "Lumbar epidural steroid injection",
    category: "SURGICAL_INTERVENTIONAL",
    specialty: "Pain Management",
    frequencyPerYear: 3,
    durationYears: 2,
    isLifetime: false,
    probability: "PROBABLE",
    confidence: 80,
    conditionId: "c-1",
    physicianStatus: "PENDING",
    ...over,
  }) as DossierItem;

const event = (over: Partial<DossierChronoEvent> = {}): DossierChronoEvent =>
  ({ eventDate: new Date("2025-03-14"), summary: "Lumbar visit", provider: "A. Rivera, MD", sourcePage: 1, ...over }) as DossierChronoEvent;

const assess = (it: DossierItem, chronology: DossierChronoEvent[], cond = condition()) =>
  buildReasoningAssessment(it as never, [cond as never], chronology, KASE);

describe("frequency needs a documented cadence, not a documented treatment", () => {
  it("does not call the frequency grounded when the record only shows that treatment happened", () => {
    const a = assess(item(), [event({ treatment: "Lumbar physical therapy was performed" })]);
    expect(a.frequencySupported).toBe(false);
    expect(a.frequencyRationale).toMatch(/assumption not yet grounded/);
  });

  it("accepts a cadence the record actually states FOR THIS SERVICE", () => {
    const a = assess(item(), [event({ treatment: "Lumbar epidural steroid injections twice weekly" })]);
    expect(a.frequencySupported).toBe(true);
    expect(a.frequencyRationale).toMatch(/cadence stated in the treatment record/);
  });

  it("accepts a numeric cadence in any of the usual forms", () => {
    for (const text of ["3 times per year", "every 6 months", "monthly", "q8h"]) {
      expect(assess(item(), [event({ treatment: `Lumbar epidural steroid injections ${text}` })]).frequencySupported, text).toBe(true);
    }
  });

  it("will not ground one service's frequency in another service's cadence", () => {
    // "Chiropractic three times weekly" states a cadence. It is not a cadence
    // for an epidural injection series, and matching on cadence alone let any
    // documented rate justify any assumed one.
    // Physical therapy classifies as THERAPY; the item is an INJECTION.
    const a = assess(item(), [event({ treatment: "Lumbar physical therapy twice weekly" })]);
    expect(a.frequencySupported).toBe(false);
    expect(a.frequencyRationale).toMatch(/assumption not yet grounded/);
  });

  it("a guideline silent on cadence cannot establish one", () => {
    const cond = condition({
      socAnalysis: { guidelines: [{ title: "Lumbar radiculopathy management", quote: "Epidural steroid injection may be considered for radicular pain.", year: "2024" }] },
    } as never);
    const a = assess(item(), [], cond);
    expect(a.frequencySupported).toBe(false);
  });
});

describe("treatment happening is not treatment failing", () => {
  it("does not summarise a treatment RESPONSE the record never stated", () => {
    // This read the LENGTH of the prior-treatment list, so any documented care
    // produced "treatment has not resolved the impairment" — a clinical
    // conclusion manufactured from the fact that treatment occurred.
    const a = assess(item(), [event({ treatment: "Lumbar epidural steroid injection performed" })]);
    expect(a.treatmentResponseSummary).not.toMatch(/did not resolve/);
    expect(a.treatmentResponseSummary).toMatch(/does not state what it achieved/);
  });

  it("says so plainly when the record does state it", () => {
    const a = assess(item(), [event({ treatment: "Epidural steroid injection with no lasting relief" })]);
    expect(a.treatmentResponseSummary).toMatch(/did not resolve the impairment/);
  });

  it("says nothing at all when there was no prior treatment", () => {
    expect(assess(item(), [event({ objectiveFindings: "Positive straight leg raise" })]).treatmentResponseSummary).toBeNull();
  });

  it("will not say conservative care failed to resolve the impairment from its existence alone", () => {
    const a = assess(item({ service: "Lumbar fusion surgery", category: "ORTHOPEDIC_SURGERY" }), [
      event({ treatment: "Lumbar physical therapy was performed" }),
    ]);
    expect(a.leastIntensiveRationale).not.toMatch(/has not resolved the impairment/);
    expect(a.leastIntensiveRationale).toMatch(/does not state whether it resolved/);
  });

  it("says it when the record does", () => {
    const a = assess(item({ service: "Lumbar fusion surgery", category: "ORTHOPEDIC_SURGERY" }), [
      event({ treatment: "Lumbar physical therapy was performed" }),
      event({ objectiveFindings: "Symptoms persisted despite a completed course of therapy" }),
    ]);
    expect(a.leastIntensiveRationale).toMatch(/the record states the impairment persisted/);
  });

  it("still asks for the basis when no conservative care is documented at all", () => {
    const a = assess(item({ service: "Lumbar fusion surgery", category: "ORTHOPEDIC_SURGERY" }), []);
    expect(a.leastIntensiveRationale).toMatch(/without documented exhaustion/);
  });
});

describe("causation evidence keeps the type it was graded as", () => {
  const build = (cond: DossierCondition) => buildRecommendationDossier(item(), cond, [], KASE);

  it("files a clinician's recorded assessment under diagnoses, not objective findings", () => {
    const d = build(condition({ objectiveEvidence: '"Chronic Pain Syndrome" — assessment, Clinic.pdf, p. 1 (2025-03-14)' }));
    expect(d.supportingEvidence.diagnoses.some((e) => /Chronic Pain Syndrome/.test(e.text))).toBe(true);
    expect(d.supportingEvidence.objectiveFindings.some((e) => /Chronic Pain Syndrome/.test(e.text))).toBe(false);
  });

  it("does not file a statement that NO objective finding exists as an objective finding", () => {
    const d = build(condition({ objectiveEvidence: "No objective finding for Chronic pain syndrome was located in the records." }));
    expect(d.supportingEvidence.objectiveFindings.some((e) => /No objective finding/.test(e.text))).toBe(false);
    // It is an absence, so it belongs with the unknowns.
    expect(d.unknowns.some((u) => /No objective finding/.test(u))).toBe(true);
  });

  it("keeps a past-medical-history mention out of support, where it would argue the opposite", () => {
    const d = build(condition({ evidenceSources: [{ filename: "Clinic.pdf", page: 3, quote: "PMH: chronic pain syndrome", field: "pastMedicalHistory" }] } as never));
    expect(d.supportingEvidence.objectiveFindings.some((e) => /PMH/.test(e.text))).toBe(false);
    expect(d.supportingEvidence.priorHistory.some((e) => /PMH/.test(e.text))).toBe(true);
  });

  it("still files a genuine objective finding as one", () => {
    const d = build(condition({ evidenceSources: [{ filename: "Imaging.pdf", page: 2, quote: "MRI shows L5-S1 disc protrusion", field: "diagnosticStudies" }] } as never));
    expect(d.supportingEvidence.objectiveFindings.some((e) => /disc protrusion/.test(e.text))).toBe(true);
  });
});

describe("what a line discloses about itself", () => {
  it("keeps the learned-prior disclosure alongside the confirmation notice", async () => {
    // The defect: `missingSupport` was assigned twice in one object literal —
    // the spread carrying the prior notes first, an explicit key second. The
    // later key won, so every item computed its adjustment disclosure and
    // stored nothing.
    const { composeMissingSupport } = await import("@/lib/engine/generate");
    const both = composeMissingSupport({
      needsPhysicianConfirmation: true,
      priorCaution: "Frequency reduced from the template default.",
      priorProvenance: "Adjusted from 4 prior physician corrections at this firm.",
    })!;
    expect(both).toMatch(/Physician confirmation/);
    expect(both).toMatch(/Frequency reduced/);
    expect(both).toMatch(/4 prior physician corrections/);
  });

  it("discloses a prior adjustment even on a line needing no confirmation", () => {
    // The exact case the duplicate key erased: nothing else to say, so the
    // second assignment wrote null over the disclosure.
    return import("@/lib/engine/generate").then(({ composeMissingSupport }) => {
      expect(composeMissingSupport({ needsPhysicianConfirmation: false, priorCaution: null, priorProvenance: "Adjusted from firm history." })).toBe(
        "Adjusted from firm history.",
      );
    });
  });

  it("says nothing when there is nothing to say", async () => {
    const { composeMissingSupport } = await import("@/lib/engine/generate");
    expect(composeMissingSupport({ needsPhysicianConfirmation: false, priorCaution: null, priorProvenance: null })).toBeNull();
  });
});
