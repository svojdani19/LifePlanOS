// Substance classification — the timeline shows CARE; paperwork stays on the
// Records page with its reason. Every fixture below is a synthetic rendition
// of a pattern observed diluting a real chronology. Doubt resolves toward
// CLINICAL: hiding a real encounter is worse than showing a consent form.
import { describe, it, expect } from "vitest";
import { classifyEncounterSubstance, isTimelineClass } from "./encounterSubstance";

const enc = (encounterType: string, summary: string, claims: { field: string; claimType?: string; value: string }[]) => ({
  encounterType,
  factualSummary: summary,
  claims,
});

describe("clinical encounters stay on the timeline", () => {
  it("an ER visit with a diagnosis is CLINICAL", () => {
    const v = classifyEncounterSubstance(
      enc("Emergency Department", "Emergency Department — Contusions.", [
        { field: "assessment", claimType: "DIAGNOSIS", value: "Contusion of left knee" },
        { field: "treatment", claimType: "COMPLETED_TREATMENT", value: "Toradol 60mg IM administered" },
      ]),
    );
    expect(v.class).toBe("CLINICAL");
    expect(isTimelineClass(v.class)).toBe(true);
  });

  it("a transport record documenting FUNCTIONAL STATUS is clinical — 'bed confined' is patient status, not paperwork", () => {
    const v = classifyEncounterSubstance(
      enc("Non-Emergency Ambulance Transport", "Transport — patient is bed confined, unable to sit at all times.", [
        { field: "functionalStatus", claimType: "FUNCTIONAL_STATUS", value: "Bed confined, unable to sit at all times" },
      ]),
    );
    expect(v.class).toBe("CLINICAL");
  });

  it("pre-existing and adverse clinical evidence is never demoted for being unrelated", () => {
    const v = classifyEncounterSubstance(
      enc("Emergency Department Visit", "ER — hyperglycemia due to type 2 diabetes.", [
        { field: "assessment", claimType: "DIAGNOSIS", value: "Hyperglycemia due to type 2 diabetes mellitus" },
      ]),
    );
    expect(v.class).toBe("CLINICAL");
  });

  it("an unclassifiable encounter with real claims defaults to CLINICAL for human review", () => {
    const v = classifyEncounterSubstance(
      enc("Patient Visit", "Visit — follow-up discussion.", [{ field: "subjective", value: "Reports feeling somewhat better" }]),
    );
    expect(v.class).toBe("CLINICAL");
    expect(v.reason).toMatch(/pending review/);
  });
});

describe("ancillary records: kept, cited, off the timeline", () => {
  it("a vaccine administration slip is ANCILLARY", () => {
    const v = classifyEncounterSubstance(
      enc("Immunization Visit", "Immunization — DTaP vaccine administered to right arm.", [
        { field: "procedure", claimType: "PROCEDURE_PERFORMED", value: "DTaP (Adacel) vaccine administered to right arm" },
      ]),
    );
    expect(v.class).toBe("ANCILLARY");
    expect(isTimelineClass(v.class)).toBe(false);
    expect(v.reason).toMatch(/medication|immunization|transport/i);
  });

  it("a pharmacist interaction-review log is not an episode of care", () => {
    const v = classifyEncounterSubstance(
      enc("Pharmacy Review", "Clinical encounter — Viewed interaction in PCM; RPH Aware; Benefits Outweigh Risk.", [
        { field: "medications", value: "RPH Aware; Benefits Outweigh Risk; Monitoring noted" },
      ]),
    );
    expect(v.class).toBe("ANCILLARY");
  });

  it("a medication discharge/dispensing summary is ANCILLARY", () => {
    const v = classifyEncounterSubstance(
      enc("Inpatient Medication Discharge Summary", "Medication discharge summary — D10W 250 mL bag ordered.", [
        { field: "medications", value: "D10W 250 mL bag ordered and dispensed" },
      ]),
    );
    expect(v.class).toBe("ANCILLARY");
  });
});

describe("administrative paperwork: visible on Records, never on the chronology", () => {
  it("registration and consent are ADMINISTRATIVE", () => {
    for (const [type, summary] of [
      ["Patient Registration", "Registration — demographics and insurance recorded."],
      ["Consent Form", "Consent for surgical procedure — risks discussed and signed."],
    ] as const) {
      const v = classifyEncounterSubstance(enc(type, summary, [{ field: "disposition", claimType: "ADMINISTRATIVE", value: "Form signed" }]));
      expect(v.class, type).toBe("ADMINISTRATIVE");
      expect(v.reason.length).toBeGreaterThan(10); // reviewable reason, always
    }
  });

  it("an encounter with no validated claims is ADMINISTRATIVE with that stated", () => {
    const v = classifyEncounterSubstance(enc("Records Request", "Records request cover sheet.", []));
    expect(v.class).toBe("ADMINISTRATIVE");
    expect(v.reason).toMatch(/No validated claims/);
  });

  it("BUT paperwork carrying a real finding is a record OF care — clinical wins", () => {
    const v = classifyEncounterSubstance(
      enc("Insurance Claim Form", "Claim form — diagnosis of lumbar radiculopathy documented.", [
        { field: "assessment", claimType: "DIAGNOSIS", value: "Lumbar radiculopathy (M54.16)" },
      ]),
    );
    expect(v.class).toBe("CLINICAL");
  });
});

describe("timeline admission", () => {
  it("NULL (unclassified) stays visible — doubt never silently excludes", () => {
    expect(isTimelineClass(null)).toBe(true);
    expect(isTimelineClass(undefined)).toBe(true);
  });

  it("only CLINICAL is admitted once classified", () => {
    expect(isTimelineClass("CLINICAL")).toBe(true);
    expect(isTimelineClass("ANCILLARY")).toBe(false);
    expect(isTimelineClass("ADMINISTRATIVE")).toBe(false);
  });
});
