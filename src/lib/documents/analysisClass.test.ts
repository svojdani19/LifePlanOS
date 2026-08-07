// A case file is not a pile of clinic notes. Each expectation below is a way
// the one-size-fits-all clinical schema damaged a real case file: four
// depositions became thirteen "clinical encounters" (77% undated, 85% with no
// provider), sixteen operative notes became 138, and every chiropractic note
// reported a missing provider. Synthetic text only.
import { describe, it, expect } from "vitest";
import { profileFor, analysisClassFor, fieldAllowed, PROFILES } from "./analysisClass";
import { CLAIM_FIELDS } from "@/lib/llm/recordExtraction";

describe("documents are classified by what they actually are", () => {
  it("maps each family of document type to its analysis class", () => {
    expect(analysisClassFor("DEPOSITION")).toBe("TESTIMONY");
    expect(analysisClassFor("OPERATIVE_NOTE")).toBe("OPERATIVE");
    expect(analysisClassFor("IMAGING_REPORT")).toBe("DIAGNOSTIC_STUDY");
    expect(analysisClassFor("LAB_REPORT")).toBe("DIAGNOSTIC_STUDY");
    expect(analysisClassFor("BILLING_RECORD")).toBe("FINANCIAL");
    expect(analysisClassFor("PHARMACY_RECORD")).toBe("FINANCIAL");
    expect(analysisClassFor("POLICE_REPORT")).toBe("INCIDENT");
    expect(analysisClassFor("EMS_REPORT")).toBe("INCIDENT");
    expect(analysisClassFor("IME_REPORT")).toBe("EXPERT_OPINION");
    expect(analysisClassFor("PT_OT_RECORD")).toBe("THERAPY_COURSE");
    expect(analysisClassFor("CHIROPRACTIC_RECORD")).toBe("THERAPY_COURSE");
    expect(analysisClassFor("ORTHOPEDIC_CLINIC")).toBe("CLINICAL_ENCOUNTER");
    expect(analysisClassFor("LEGAL_PLEADING")).toBe("LEGAL");
  });

  it("an unknown or missing type is UNKNOWN — never silently clinical", () => {
    // "Clinical by default" is how an unlabelled fax acquires a provider, a
    // diagnosis and a place on the medical timeline it never earned. The
    // schema default for an untyped upload is OTHER, so this is the common
    // case, not the exotic one.
    expect(analysisClassFor("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(analysisClassFor("OTHER")).toBe("UNKNOWN");
    expect(analysisClassFor(null)).toBe("UNKNOWN");
    expect(analysisClassFor(undefined)).toBe("UNKNOWN");
    // And UNKNOWN can assert almost nothing.
    expect(fieldAllowed(profileFor("OTHER"), "assessment")).toBe(false);
    expect(fieldAllowed(profileFor("OTHER"), "documentContent")).toBe(true);
  });
});

describe("a document can only assert what its kind can assert", () => {
  it("a deposition has testimony, not clinical findings", () => {
    const p = profileFor("DEPOSITION");
    expect(fieldAllowed(p, "testimony")).toBe(true);
    expect(fieldAllowed(p, "admission")).toBe(true);
    // A plaintiff saying their back hurts is testimony, not an examination.
    expect(fieldAllowed(p, "assessment")).toBe(false);
    expect(fieldAllowed(p, "objectiveFindings")).toBe(false);
    expect(fieldAllowed(p, "procedure")).toBe(false);
  });

  it("a billing ledger has charges, not examinations", () => {
    const p = profileFor("BILLING_RECORD");
    expect(fieldAllowed(p, "charge")).toBe(true);
    expect(fieldAllowed(p, "billedAmount")).toBe(true);
    expect(fieldAllowed(p, "serviceCode")).toBe(true);
    // A diagnosis code on a claim line justifies a charge; it is not an
    // assessment of the patient.
    expect(fieldAllowed(p, "assessment")).toBe(false);
    expect(fieldAllowed(p, "objectiveFindings")).toBe(false);
  });

  it("an imaging report has an impression, not a treatment plan", () => {
    const p = profileFor("IMAGING_REPORT");
    expect(fieldAllowed(p, "impression")).toBe(true);
    expect(fieldAllowed(p, "studyTechnique")).toBe(true);
    expect(fieldAllowed(p, "comparison")).toBe(true);
    expect(fieldAllowed(p, "treatment")).toBe(false);
    expect(fieldAllowed(p, "subjective")).toBe(false);
  });

  it("an operative note has the fields an operation actually has", () => {
    const p = profileFor("OPERATIVE_NOTE");
    for (const f of ["preOperativeDiagnosis", "postOperativeDiagnosis", "operativeFindings", "implants", "complications", "estimatedBloodLoss", "specimen", "anesthesia"]) {
      expect(fieldAllowed(p, f), f).toBe(true);
    }
  });

  it("an expert report records opinions AS opinions", () => {
    const p = profileFor("IME_REPORT");
    expect(fieldAllowed(p, "opinion")).toBe(true);
    expect(fieldAllowed(p, "causationOpinion")).toBe(true);
  });

  it("every class field is a real claim field — no profile can name one that does not exist", () => {
    for (const [name, p] of Object.entries(PROFILES)) {
      for (const f of p.fields) expect(CLAIM_FIELDS, `${name}.${f}`).toContain(f);
      for (const f of p.leadFields) expect(p.fields, `${name} leads with ${f}`).toContain(f);
    }
  });
});

describe("attribution and dating match the document", () => {
  it("a billing ledger has no clinician to attribute", () => {
    expect(profileFor("BILLING_RECORD").attribution).toBeNull();
  });

  it("each clinical-ish class names the role that authors it", () => {
    expect(profileFor("OPERATIVE_NOTE").attribution).toMatch(/surgeon/i);
    expect(profileFor("IMAGING_REPORT").attribution).toMatch(/radiologist/i);
    expect(profileFor("DEPOSITION").attribution).toMatch(/deponent/i);
    expect(profileFor("ORTHOPEDIC_CLINIC").attribution).toMatch(/treating provider/i);
  });

  it("a deposition is one proceeding, not a series of dated visits", () => {
    const p = profileFor("DEPOSITION");
    expect(p.expectsDate).toBe(false);
    expect(p.singleUnit).toBe(true);
    expect(p.unit).toMatch(/testimony/i);
  });

  it("an IME is one evaluation, not a course of care", () => {
    expect(profileFor("IME_REPORT").singleUnit).toBe(true);
  });

  it("clinic and therapy records ARE series of dated visits", () => {
    expect(profileFor("ORTHOPEDIC_CLINIC").singleUnit).toBe(false);
    expect(profileFor("ORTHOPEDIC_CLINIC").expectsDate).toBe(true);
    expect(profileFor("PT_OT_RECORD").singleUnit).toBe(false);
  });
});

describe("each class leads its summary with what that document is for", () => {
  it("the lead field is the one a reviewer would name first", () => {
    expect(profileFor("IMAGING_REPORT").leadFields[0]).toBe("impression");
    expect(profileFor("OPERATIVE_NOTE").leadFields[0]).toBe("procedure");
    expect(profileFor("DEPOSITION").leadFields[0]).toBe("admission");
    expect(profileFor("BILLING_RECORD").leadFields[0]).toBe("charge");
    expect(profileFor("IME_REPORT").leadFields[0]).toBe("opinion");
    expect(profileFor("ORTHOPEDIC_CLINIC").leadFields[0]).toBe("assessment");
    // Therapy leads with the interval change, not the diagnosis it repeats on
    // every single visit.
    expect(profileFor("PT_OT_RECORD").leadFields[0]).toBe("responseToTreatment");
  });

  it("guidance tells the model what that kind of document is for", () => {
    expect(profileFor("DEPOSITION").guidance).toMatch(/not a series of clinical encounters/i);
    expect(profileFor("OPERATIVE_NOTE").guidance).toMatch(/ONE OPERATION IS ONE ENTRY/);
    expect(profileFor("BILLING_RECORD").guidance).toMatch(/not a clinical assessment/i);
    expect(profileFor("PT_OT_RECORD").guidance).toMatch(/boilerplate/i);
  });
});
