// A records-custodian billing affidavit is a billing document.
//
// BILLING_RECORD's keywords were written for an EOB or superbill — cpt,
// hcpcs, total charges, balance due, patient responsibility. A CPRC §18.001
// affidavit, one of the most common billing documents in personal-injury work,
// says none of them: it says "total billed", "amount currently owed", "amount
// adjusted per contract rates". It scored ZERO and fell through to the default
// MEDICAL_RECORD at 0.1 confidence.
//
// That is not a cosmetic mislabel. BILLING_RECORD is in chronology's
// EXCLUDED_TYPES, so defaulting to MEDICAL_RECORD walked these documents past
// the exclusion into the clinical chronology and the physician review queue —
// and had the extractor pulling dollar figures out of notary boilerplate as
// though they were clinical facts.

import { describe, it, expect } from "vitest";
import { classifyByContent, classifyDocument } from "./classify";
import { EXCLUDED_TYPES } from "@/lib/engine/chronology";

const BILLING_AFFIDAVIT = `AFFIDAVIT OF RECORDS CUSTODIAN
Before me, the undersigned authority, personally appeared the affiant, duly sworn, deposed as follows:
I am the custodian of billing records for the provider.
The total billed for the services provided is: $37,822.60
The amount that has been paid for the services is: $0
The amount currently owed for the services is: $ 37,822.60
The amount adjusted per contract rates is: $0
Further Affiant sayeth not.
SWORN TO AND SUBSCRIBED before me. Notary Public, State of Texas`;

/** The same sworn form, for MEDICAL records. Not a billing document. */
const MEDICAL_RECORDS_AFFIDAVIT = `AFFIDAVIT OF RECORDS CUSTODIAN
Before me, the undersigned authority, personally appeared the affiant, duly sworn, deposed as follows:
I am the custodian of medical records for the provider. Attached are true and correct copies
of the records of the patient, kept in the regular course of business.
Further Affiant sayeth not.
SWORN TO AND SUBSCRIBED before me. Notary Public, State of Texas`;

const EOB = `EXPLANATION OF BENEFITS
Date of service 03/15/2024. CPT 99213. Total charges $450.00.
Adjustments $120.00. Patient responsibility $45.00. Balance due $285.00.`;

describe("the affidavit form is recognised as billing", () => {
  it("classifies as BILLING_RECORD instead of defaulting", () => {
    const r = classifyByContent(BILLING_AFFIDAVIT);
    expect(r.type).toBe("BILLING_RECORD");
    expect(r.score).toBeGreaterThan(0);
  });

  it("no longer falls through to the MEDICAL_RECORD default", () => {
    const d = classifyDocument({ text: BILLING_AFFIDAVIT, filename: "affidavit.pdf", hasText: true });
    expect(d.type).toBe("BILLING_RECORD");
    expect(d.method).not.toBe("default");
    expect(d.confidence).toBeGreaterThan(0.1);
  });

  it("matches on the affidavit's own vocabulary, not the EOB's", () => {
    const r = classifyByContent(BILLING_AFFIDAVIT);
    expect(r.matched).toEqual(expect.arrayContaining(["total billed", "amount currently owed", "amount adjusted"]));
    // The EOB terms are genuinely absent from this document.
    for (const eobTerm of ["hcpcs", "total charges", "balance due", "patient responsibility"]) {
      expect(r.matched).not.toContain(eobTerm);
    }
  });

  it("is therefore kept off the clinical chronology", () => {
    // The whole point: BILLING_RECORD is excluded, MEDICAL_RECORD is not.
    expect(EXCLUDED_TYPES.has("BILLING_RECORD")).toBe(true);
    expect(EXCLUDED_TYPES.has("MEDICAL_RECORD")).toBe(false);
    expect(EXCLUDED_TYPES.has(classifyByContent(BILLING_AFFIDAVIT).type)).toBe(true);
  });
});

describe("it does not over-reach", () => {
  it("a MEDICAL-records custodian affidavit is not called billing", () => {
    // Same sworn form, same notary block, no billing figures. Adding bare
    // "affiant" or "sworn to and subscribed" would have captured this.
    expect(classifyByContent(MEDICAL_RECORDS_AFFIDAVIT).type).not.toBe("BILLING_RECORD");
  });

  it("an EOB still classifies as billing", () => {
    expect(classifyByContent(EOB).type).toBe("BILLING_RECORD");
  });

  it("a deposition is still a deposition", () => {
    // Depositions are also sworn, and share "duly sworn" language.
    const depo = `DEPOSITION OF THE WITNESS
      The witness, being first duly sworn, testified as follows.
      Court reporter present. EXAMINATION BY counsel. APPEARANCES:
      Q. Please state your name. A. My name is the witness.`;
    expect(classifyByContent(depo).type).toBe("DEPOSITION");
  });

  it("a clinical note mentioning charges is still clinical", () => {
    const note = `ORTHOPEDIC CLINIC follow-up visit. Chief complaint: right knee pain.
      Physical exam: range of motion limited. Assessment: post-traumatic arthritis.
      Plan: continue therapy. Care discussed is reasonable and necessary.`;
    expect(classifyByContent(note).type).not.toBe("BILLING_RECORD");
  });
});
