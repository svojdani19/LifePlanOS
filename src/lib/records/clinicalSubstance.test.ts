import { describe, expect, it } from "vitest";
import { claimIsSubstantive, clinicalSubstanceOf, explainInsubstantial } from "@/lib/records/clinicalSubstance";

const claim = (field: string, value: string) => ({ field, value });

describe("records that do not document care", () => {
  // Each of these was listed as a clinical encounter, between a laminectomy and
  // a discharge summary, with the same weight.
  it("refuses a demographic line from a chart header", () => {
    const v = clinicalSubstanceOf([claim("subjective", "47-year-old male patient record.")]);
    expect(v).toMatchObject({ meaningful: false, reason: "DEMOGRAPHIC_ONLY" });
  });

  it("refuses a statement that a visit happened", () => {
    // An ICD code read back as a sentence: it names the reason and stops.
    const v = clinicalSubstanceOf([
      claim("assessment", "Aftercare visit documented with encounter for other specified aftercare."),
    ]);
    expect(v.meaningful).toBe(false);
  });

  it("refuses a list of study categories with no result", () => {
    const v = clinicalSubstanceOf([
      claim("diagnosticStudies", "Laboratory and imaging studies included CBC, CMP and radiographs."),
    ]);
    expect(v).toMatchObject({ meaningful: false, reason: "STUDY_CATEGORIES_ONLY" });
  });

  it("refuses record identifiers and transmission furniture", () => {
    expect(clinicalSubstanceOf([claim("subjective", "Medical record number 375067")]).meaningful).toBe(false);
    expect(clinicalSubstanceOf([claim("subjective", "Page 3 of 284")]).meaningful).toBe(false);
  });

  it("refuses a demographic claim however the extractor worded it", () => {
    // The first attempt matched the SHAPE of the sentence in the bug report and
    // missed "Male patient, age 47" — which is what the extractor actually
    // produces, and begins with neither a number nor "patient is".
    for (const value of [
      "Male patient, age 47",
      "47-year-old male patient record.",
      "Patient is male, age 47",
      "47-year-old male patient contact.",
    ]) {
      expect(claimIsSubstantive(claim("subjective", value))).toBe(false);
    }
  });

  it("refuses a billing code read back as a clinical statement", () => {
    // These come off claim lines: the words are the code's official descriptor,
    // not anything a clinician wrote about this patient.
    for (const value of [
      "Encounter for aftercare (Z4889) noted on claim",
      "Diagnoses coded: M5450, M5126",
      "Urinalysis (82962)",
      "Therapeutic, prophylactic, or diagnostic injection (96374)",
    ]) {
      expect(claimIsSubstantive(claim("procedure", value))).toBe(false);
    }
    expect(clinicalSubstanceOf([claim("procedure", "Venipuncture (36415)")])).toMatchObject({
      meaningful: false,
      reason: "CODED_CLAIM_DATA",
    });
  });

  it("keeps a real note that happens to cite its code", () => {
    // The narrative is what distinguishes a note from a ledger line.
    expect(
      claimIsSubstantive(
        claim("procedure", "Bilateral L2-S1 laminectomy, facetectomy and foraminotomy performed for spinal stenosis (CPT 63047)"),
      ),
    ).toBe(true);
  });

  it("refuses a patient-education handout printed into the chart", () => {
    // About the condition in general, and about what may happen rather than
    // what did.
    for (const value of [
      "Noncardiac chest pain - pain or discomfort in chest not caused by a heart problem",
      "Medicines may be given to treat the cause of chest pain",
      "Educational material on possible causes of chest pain",
    ]) {
      expect(claimIsSubstantive(claim("assessment", value))).toBe(false);
    }
  });

  it("refuses content carrying no clinical field at all", () => {
    const v = clinicalSubstanceOf([claim("documentContent", "Sworn to and subscribed before me")]);
    expect(v).toMatchObject({ meaningful: false, reason: "NO_CLINICAL_FIELD" });
  });

  it("refuses an empty record", () => {
    expect(clinicalSubstanceOf([])).toMatchObject({ meaningful: false, reason: "NO_CONTENT" });
  });
});

describe("records that do document care", () => {
  it("keeps a study list once it carries a result", () => {
    // The distinction is what came back, not what was ordered.
    expect(
      clinicalSubstanceOf([
        claim("diagnosticStudies", "Laboratory studies: lactic acid 1.9 mmol/L; abdominal radiograph showed no acute finding."),
      ]).meaningful,
    ).toBe(true);
  });

  it("keeps a diagnosis", () => {
    expect(
      clinicalSubstanceOf([claim("assessment", "Lumbar radiculopathy with L5-S1 disc protrusion")]).meaningful,
    ).toBe(true);
  });

  it("keeps a procedure, a medication action and a disposition", () => {
    for (const c of [
      claim("procedure", "Bilateral L2-S1 laminectomy, facetectomy and foraminotomy performed"),
      claim("medications", "Hydromorphone 0.5 mg IV administered for pain 8/10"),
      claim("disposition", "Discharged home with home health and physical therapy"),
    ]) {
      expect(claimIsSubstantive(c)).toBe(true);
    }
  });

  it("keeps an entry whose other claims are vacuous", () => {
    // One real fact is enough; the chart header alongside it does not remove it.
    const v = clinicalSubstanceOf([
      claim("subjective", "47-year-old male patient record."),
      claim("objectiveFindings", "Straight leg raise positive on the right at 40 degrees"),
    ]);
    expect(v).toMatchObject({ meaningful: true });
  });

  it("keeps a patient-reported complaint", () => {
    expect(
      clinicalSubstanceOf([claim("subjective", "Reports low back pain radiating into the right leg, 8/10")]).meaningful,
    ).toBe(true);
  });
});

describe("explaining a refusal to the reviewer", () => {
  it("gives a reason for every kind of refusal", () => {
    for (const reason of [
      "DEMOGRAPHIC_ONLY",
      "ADMINISTRATIVE_ONLY",
      "GENERIC_VISIT_ONLY",
      "STUDY_CATEGORIES_ONLY",
      "NO_CLINICAL_FIELD",
      "NO_CONTENT",
    ] as const) {
      expect(explainInsubstantial(reason)).toMatch(/\w/);
    }
  });
});
