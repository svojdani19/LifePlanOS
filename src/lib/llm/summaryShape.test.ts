// A chronology summary has to help a reviewer reconstruct a course of care.
// Every case here is a way a real summary failed to: discharge boilerplate
// leading the line, a field label restated as a finding, or a record
// summarized in the wrong vocabulary for what it is. Synthetic text only.
import { describe, it, expect } from "vitest";
import { composeSummary, isBoilerplate, isIntakeRecital, isNonSubstantive } from "./summaryShape";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const c = (field: string, value: string) => ({ field, value });

describe("text that must never lead a summary", () => {
  it("recognizes discharge and patient-education boilerplate", () => {
    for (const t of [
      "Keep the injured part elevated above the level of the heart.",
      "Apply ice to the area for 20 minutes at a time.",
      "Call your doctor if the pain worsens.",
      "Take medication as directed.",
      "Return to the emergency department if you develop numbness.",
      "Keep the wound clean and dry.",
    ]) {
      expect(isBoilerplate(t), t).toBe(true);
    }
  });

  it("recognizes field labels restated as findings", () => {
    for (const t of [
      "Encounter Date: Jul 18, 2023",
      "Date of Service: 03/14/2025",
      "MRN: 0099231",
      "Account Number: 55512",
      "Patient Name: redacted",
      "Page 4 of 12",
    ]) {
      expect(isNonSubstantive(t), t).toBe(true);
    }
  });

  it("recognizes the intake questions every chart asks at every visit", () => {
    // Real on a real record: "Emergency Department — Never smoker" summarized a
    // visit for a fall, because the smoking question is answered in the
    // subjective of every note in the chart.
    for (const t of [
      "Never smoker",
      "Does not use illicit or recreational drugs",
      "No known drug allergies",
      "NKDA",
      "Denies tobacco use",
      "Family history of diabetes",
      "Patient completed COVID-19 vaccine series (Moderna)",
      "Lives alone in a single-story home",
    ]) {
      expect(isIntakeRecital(t), t).toBe(true);
    }
  });

  it("does not mistake a presenting complaint for an intake recital", () => {
    for (const t of [
      "Reports low back pain radiating to the left leg since the fall",
      "Chief complaint: neck pain 7/10",
      "Denies relief from six weeks of physical therapy",
      "Smoking cessation counselling provided after the injury",
    ]) {
      expect(isIntakeRecital(t), t).toBe(false);
    }
  });

  it("keeps an intake recital out of the summary and lets the day's facts lead", () => {
    const out = composeSummary("CLINICAL_ENCOUNTER", "Emergency Department", [
      c("subjective", "Never smoker"),
      c("subjective", "Fall from standing, left hip pain"),
      c("assessment", "Contusions"),
    ], clip);
    expect(out).toBe("Emergency Department — Fall from standing, left hip pain; assessment: Contusions.");
  });

  it("does not mistake real clinical content for either", () => {
    for (const t of [
      "Lumbar radiculopathy with left-sided foot drop.",
      "Non-weight bearing on the right lower extremity for six weeks.",
      "Straight leg raise positive on the left at 40 degrees.",
      "L4-L5 microdiscectomy performed without complication.",
    ]) {
      expect(isBoilerplate(t), t).toBe(false);
      expect(isNonSubstantive(t), t).toBe(false);
    }
  });
});

describe("a summary is composed from what its kind is for", () => {
  it("an encounter reads what was reported, what was assessed, then the plan", () => {
    // The order and the selection are the published planners': they open an
    // encounter with the presenting complaint in 91% of entries, and under a
    // three-clause cap the assessment and plan outrank the exam.
    const out = composeSummary("CLINICAL_ENCOUNTER", "Clinic visit", [
      c("subjective", "Reports ongoing low back pain."),
      c("assessment", "Lumbar radiculopathy"),
      c("objectiveFindings", "Positive straight leg raise on the left"),
      c("recommendations", "Referral for epidural steroid injection"),
    ], clip);
    expect(out).toBe("Clinic visit — Reports ongoing low back pain; assessment: Lumbar radiculopathy; plan: Referral for epidural steroid injection.");
  });

  it("boilerplate never leads, even when it is the only 'treatment'", () => {
    // The exact failure from a real record: a discharge sheet's instruction
    // became the headline for the visit.
    const out = composeSummary("CLINICAL_ENCOUNTER", "Clinic visit", [
      c("treatment", "Keep the injured part elevated above the level of the heart."),
      c("assessment", "Lumbar strain"),
    ], clip);
    expect(out).toBe("Clinic visit — Lumbar strain.");
    expect(out).not.toMatch(/elevated/);
  });

  it("a restated date is never the summary", () => {
    const out = composeSummary("CLINICAL_ENCOUNTER", "Clinic visit", [
      c("assessment", "Encounter Date: Jul 18, 2023"),
      c("objectiveFindings", "Antalgic gait"),
    ], clip);
    expect(out).toMatch(/Antalgic gait/);
    expect(out).not.toMatch(/Encounter Date/);
  });

  it("an operation reads as an operation", () => {
    const out = composeSummary("OPERATIVE", "Operative report", [
      c("procedure", "L4-L5 microdiscectomy"),
      c("operativeFindings", "Extruded disc fragment"),
      c("complications", "None"),
    ], clip);
    expect(out).toMatch(/^Operative report — L4-L5 microdiscectomy/);
    expect(out).toMatch(/findings: Extruded disc fragment/);
  });

  it("a study leads with its impression", () => {
    const out = composeSummary("DIAGNOSTIC_STUDY", "MRI lumbar spine", [
      c("diagnosticStudies", "Disc extrusion at L4-L5"),
      c("impression", "L4-L5 extrusion with lateral recess stenosis"),
    ], clip);
    expect(out).toMatch(/^MRI lumbar spine — impression: L4-L5 extrusion/);
  });

  it("a billing line says plainly that it is billing", () => {
    const out = composeSummary("FINANCIAL", "Billing", [
      c("charge", "Office visit, established patient"),
      c("serviceCode", "CPT 99214"),
      c("billedAmount", "$412.00"),
    ], clip);
    expect(out).toBe("Billing — Office visit, established patient; code: CPT 99214; amount: $412.00.");
  });

  it("testimony leads with the admission", () => {
    const out = composeSummary("TESTIMONY", "Deposition", [
      c("testimony", "Describes ongoing shoulder pain"),
      c("admission", "Acknowledged a prior injury to the same shoulder"),
    ], clip);
    expect(out).toMatch(/^Deposition — admission: Acknowledged a prior injury/);
  });

  it("stops at three clauses — a summary that lists everything is not a summary", () => {
    const out = composeSummary("CLINICAL_ENCOUNTER", "Clinic visit", [
      c("assessment", "Lumbar radiculopathy"),
      c("objectiveFindings", "Positive straight leg raise"),
      c("procedure", "Trigger point injection"),
      c("recommendations", "Continue therapy"),
      c("disposition", "Home"),
    ], clip);
    expect(out!.split(";")).toHaveLength(3);
  });

  it("returns null when nothing substantive is available, so the caller can fall back", () => {
    expect(composeSummary("CLINICAL_ENCOUNTER", "Clinic visit", [c("treatment", "Apply ice to the area for 20 minutes.")], clip)).toBeNull();
    expect(composeSummary("CLINICAL_ENCOUNTER", "Clinic visit", [], clip)).toBeNull();
  });
});
