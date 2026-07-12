import { describe, it, expect } from "vitest";
import { segmentDocument, type DocumentSegment } from "@/lib/documents/segment";

// A consolidated chart (page-marked) mixing clinical encounters with the
// administrative pages a real hospital chart carries: consent, patient rights,
// privacy notice, a facesheet, a DME/discharge-planning instruction, and a
// drug-information leaflet. The segmenter must (1) split it into typed
// sub-documents, (2) extract real clinical findings, (3) route boilerplate to
// the administrative category — keeping care-relevant items (consent, DME) and
// flagging pure boilerplate as non-bearing — and (4) never emit a placeholder.
const CHART = [
  "Page 1 of 8",
  "Date of service: 06/12/2024",
  "Chief complaint: Right knee pain. Assessment: post-traumatic osteoarthritis of the right knee. Plan: total knee arthroplasty.",
  "Attending Physician: Nadia Brandt, MD",
  "",
  "Page 2 of 8",
  "Date of service: 06/12/2024",
  "PATIENT RIGHTS AND RESPONSIBILITIES. You have the right to considerate and respectful care.",
  "",
  "Page 3 of 8",
  "Date of service: 06/13/2024",
  "Consent to surgery: right total knee arthroplasty. I authorize the procedure and anesthesia.",
  "",
  "Page 4 of 8",
  "Date of service: 06/14/2024",
  "Notice of Privacy Practices. This notice describes how your health information may be used and disclosed.",
  "",
  "Page 5 of 8",
  "Date of service: 06/15/2024",
  "Physician Instructions: Patient needs a heavy-duty bedside commode and a walker for home use. Confirm DME delivery.",
  "",
  "Page 6 of 8",
  "Date of service: 06/16/2024",
  "Progress note: Patient seen today status post total knee arthroplasty. Ambulating with therapy. Assessment: stable, recovering well.",
  "",
  "Page 7 of 8",
  "Date of service: 06/16/2024",
  "ENOXAPARIN INJECTION. COMMON BRAND NAME: Lovenox. WARNING: this medication may cause bleeding. Take the smallest effective dose.",
  "",
  "Page 8 of 8",
  "Date of service: 06/17/2024",
  "Discharge summary. Discharge diagnosis: post-traumatic osteoarthritis, status post right TKA. Disposition: home with home health.",
].join("\n");

describe("segmentDocument", () => {
  const segs = segmentDocument(CHART) as DocumentSegment[];

  it("splits a consolidated chart into typed sub-documents", () => {
    expect(segs).not.toBeNull();
    expect(segs.length).toBeGreaterThanOrEqual(6);
    // Every segment is dated with a page range and a non-empty summary.
    for (const s of segs) {
      expect(s.label).toMatch(/\d{2}\/\d{2}\/\d{4}/);
      expect(s.pageStart).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });

  it("never emits the old empty-encounter placeholder", () => {
    expect(segs.some((s) => /see the cited source page/i.test(s.summary))).toBe(false);
  });

  it("extracts real clinical findings for encounters", () => {
    const clinical = segs.filter((s) => s.kind === "clinical");
    expect(clinical.some((s) => /right knee pain|osteoarthritis/i.test(s.summary))).toBe(true);
    expect(clinical.some((s) => /status post total knee arthroplasty|recovering/i.test(s.summary))).toBe(true);
    expect(clinical.every((s) => s.bearsOnCare)).toBe(true);
  });

  it("routes a surgical consent to the admin-bearing consent category, not a clinical encounter", () => {
    const consent = segs.find((s) => s.category === "Surgical / procedure consent");
    expect(consent).toBeTruthy();
    expect(consent!.kind).toBe("administrative");
    expect(consent!.bearsOnCare).toBe(true);
    // The consent naming the procedure must NOT appear as a clinical encounter.
    expect(segs.some((s) => s.kind === "clinical" && /i authorize the procedure/i.test(s.summary))).toBe(false);
  });

  it("keeps a DME / discharge-planning instruction as care-relevant with its specifics", () => {
    const dme = segs.find((s) => /commode|walker|DME/i.test(s.summary) || s.category === "DME / discharge planning");
    expect(dme).toBeTruthy();
    // Whether surfaced as a clinical instruction or the DME category, it bears on care.
    expect(dme!.bearsOnCare).toBe(true);
  });

  it("flags patient-rights and privacy notices as administrative, not bearing on care", () => {
    const rights = segs.find((s) => s.category === "Patient rights & responsibilities");
    const privacy = segs.find((s) => s.category === "Privacy / HIPAA notice");
    expect(rights?.bearsOnCare).toBe(false);
    expect(privacy?.bearsOnCare).toBe(false);
  });

  it("does not mistake a drug-information leaflet for a clinical encounter", () => {
    expect(segs.some((s) => s.kind === "clinical" && /lovenox|common brand name|smallest effective dose/i.test(s.summary))).toBe(false);
  });

  it("returns null for a record that is not consolidated", () => {
    expect(segmentDocument("Date of service: 06/12/2024\nChief complaint: knee pain. Assessment: arthritis.")).toBeNull();
    expect(segmentDocument("short")).toBeNull();
  });
});
