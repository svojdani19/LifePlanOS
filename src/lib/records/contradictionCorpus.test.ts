// ─────────────────────────────────────────────────────────────────────────────
// The fourteen adjudicated contradictions, as a regression corpus.
//
// Each fixture reproduces one measured error class from a real case in
// SYNTHETIC text, and runs through the real validators — not a copy of their
// logic. The point is that these specific mistakes cannot come back silently.
//
// No real case text, no PHI: names, facilities and numbers are invented.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { judgeDateEvidence, parseDateRange, isAmbiguousPartial, isUnlabelledCompactNumeric, isRelativeWithoutAnchor } from "@/lib/records/dateEvidence";
import { judgeProviderEvidence } from "@/lib/records/providerRole";

/** The ISO normaliser the fixtures use; the real pipeline has its own. */
const toIso = (raw: string): string | null => {
  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// ── Dates (8 classes) ────────────────────────────────────────────────────────

describe("date contradictions that must not recur", () => {
  it("1. a signature timestamp is not a service date", () => {
    const noteText = "PHYSICAL THERAPY NOTE\nTreatment rendered.\nElectronically signed by A. Rivera, PT on 12/03/2025 19:35";
    const v = judgeDateEvidence({ iso: "2025-12-03", excerpt: "signed by A. Rivera, PT on 12/03/2025", noteText });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("SIGNATURE_OR_WITNESS_LINE");
  });

  it("2. a witness or notary timestamp is not a service date", () => {
    const noteText = "CONSENT FORM\nPatient consented to the procedure.\nWitness signature: J. Doe  12/03/2025 20:36";
    const v = judgeDateEvidence({ iso: "2025-12-03", excerpt: "Witness signature: J. Doe  12/03/2025", noteText });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("SIGNATURE_OR_WITNESS_LINE");
  });

  it("3. an artifact 'Depart Date' years away from the encounter is rejected", () => {
    const noteText = "EMERGENCY DEPARTMENT RECORD\nDate of Service: 11/25/2024\nDepart Date 5/24/73";
    const v = judgeDateEvidence({ iso: "1973-05-24", excerpt: "Depart Date 5/24/73", noteText, plausibleYear: 2024 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("IMPLAUSIBLE_FOR_ENCOUNTER");
  });

  it("3b. but a plausible depart date on the same visit is NOT rejected", () => {
    // The rule must not ban the word: a real discharge date is a real date.
    const noteText = "INPATIENT SUMMARY\nAdmission Date: 11/22/2024\nDepart Date 11/25/2024";
    const v = judgeDateEvidence({ iso: "2024-11-25", excerpt: "Depart Date 11/25/2024", noteText, plausibleYear: 2024 });
    expect(v.ok).toBe(true);
  });

  it("4. a compact numeric with no service label is not parsed", () => {
    const noteText = "BILLING DETAIL\nAccount 110624 posted to ledger.";
    expect(isUnlabelledCompactNumeric("Account 110624", noteText)).toBe(true);
  });

  it("4b. the same digits under a service label are usable", () => {
    const noteText = "Date of Service: 110624";
    expect(isUnlabelledCompactNumeric("Date of Service: 110624", noteText)).toBe(false);
  });

  it("5. an ambiguous partial date is not given a guessed year", () => {
    expect(isAmbiguousPartial("JUNE - 08")).toBe(true);
    expect(isAmbiguousPartial("Date of Service: JUNE 8, 2024")).toBe(false);
  });

  it("6. an explicit closed range keeps BOTH endpoints", () => {
    const range = parseDateRange("03/15/2024-07/23/2024 (dates of service)", toIso);
    expect(range).toEqual({ start: "2024-03-15", end: "2024-07-23", openEnded: false });
  });

  it("7. an open-ended range stays open-ended and invents no end", () => {
    const range = parseDateRange("03/15/2024 to present (dates of service)", toIso);
    expect(range).toEqual({ start: "2024-03-15", end: null, openEnded: true });
  });

  it("8. 'today' with no anchor in the same note stays unresolved", () => {
    expect(isRelativeWithoutAnchor("condition improved following his treatment today", false)).toBe(true);
    expect(isRelativeWithoutAnchor("condition improved following his treatment today", true)).toBe(false);
  });

  it("a date of birth never becomes a service date", () => {
    const noteText = "PATIENT REGISTRATION\nDOB: 10/19/1976\nDate of Service: 05/29/2023";
    const v = judgeDateEvidence({ iso: "1976-10-19", excerpt: "DOB: 10/19/1976", noteText });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("BIRTH_DATE");
  });

  it("a fax or print stamp never becomes a service date", () => {
    const noteText = "CHART COPY\nPrinted 07/11/2025 09:14\nDate of Service: 03/18/2024";
    const v = judgeDateEvidence({ iso: "2025-07-11", excerpt: "Printed 07/11/2025", noteText });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("PRINT_OR_TRANSMISSION");
  });

  it("an ordinary labelled service date passes untouched", () => {
    const noteText = "PROGRESS NOTE\nDate of Service: 03/18/2024\nAssessment: lumbar radiculopathy.";
    expect(judgeDateEvidence({ iso: "2024-03-18", excerpt: "Date of Service: 03/18/2024", noteText }).ok).toBe(true);
  });
});

// ── Providers (6 classes) ────────────────────────────────────────────────────

describe("provider contradictions that must not recur", () => {
  it("9. a records custodian is not the treating clinician", () => {
    const noteText = "AFFIDAVIT\nI, Dana Fields, am the custodian of the records for Northgate Clinic.";
    const v = judgeProviderEvidence({ value: "Dana Fields", excerpt: "Dana Fields, am the custodian of the records", noteText });
    expect(v.ok).toBe(false);
    expect(v.role).toBe("RECORDS_CUSTODIAN");
  });

  it("10. an organization is recorded as a facility, not a person", () => {
    const noteText = "NORTHGATE HOSPITAL SYSTEMS, LLC\nEmergency Department record.";
    const v = judgeProviderEvidence({ value: "NORTHGATE HOSPITAL SYSTEMS, LLC", excerpt: "NORTHGATE HOSPITAL SYSTEMS, LLC", noteText });
    expect(v.ok).toBe(false);
    expect(v.role).toBe("ORGANIZATION");
  });

  it("11. a letterhead name without authorship is not provider evidence", () => {
    const noteText = "Riverbend Spine Care\nT. Alvarez, MD\n500 Mill Street, Suite 200 · phone 555-0100 · www.example.com\n\nPatient seen for follow-up.";
    const v = judgeProviderEvidence({ value: "T. Alvarez, MD", excerpt: "T. Alvarez, MD\n500 Mill Street, Suite 200 · phone 555-0100", noteText });
    expect(v.ok).toBe(false);
    expect(v.role).toBe("LETTERHEAD_ONLY");
  });

  it("11b. the same name WITH a signature is accepted", () => {
    const noteText = "Patient seen for follow-up.\nElectronically signed by T. Alvarez, MD";
    const v = judgeProviderEvidence({ value: "T. Alvarez, MD", excerpt: "Electronically signed by T. Alvarez, MD", noteText });
    expect(v.ok).toBe(true);
    expect(v.role).toBe("TREATING_CLINICIAN");
  });

  it("12. a technologist does not become the interpreting physician", () => {
    const noteText = "RADIOLOGY\nStudy performed by C. Park, technologist.\nNo interpreting radiologist is named in this excerpt.";
    const v = judgeProviderEvidence({ value: "C. Park", excerpt: "performed by C. Park, technologist", noteText });
    expect(v.ok).toBe(false);
    expect(v.role).toBe("TECHNOLOGIST");
  });

  it("13. a signature from an adjacent section does not attribute this note", () => {
    const noteText = "LUMBAR MRI REPORT\nFindings: L4-L5 disc protrusion.";
    const v = judgeProviderEvidence({ value: "J. Tsai, MD", excerpt: "Electronically signed by J. Tsai, MD (cervical spine report)", noteText });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("SIGNATURE_OUTSIDE_NOTE");
  });

  it("14. a CMS-1500 rendering provider IS recognised", () => {
    const noteText = "CMS-1500 CLAIM\n31. Signature of Physician: M. Graham, APRN-CNP\nNPI 1164205415";
    const v = judgeProviderEvidence({ value: "M. Graham, APRN-CNP", excerpt: "31. Signature of Physician: M. Graham, APRN-CNP", noteText });
    expect(v.ok).toBe(true);
    expect(v.role).toBe("RENDERING_PROVIDER");
  });
});
