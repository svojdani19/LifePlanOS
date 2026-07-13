import { describe, it, expect } from "vitest";
import { segmentEncounters, extractEncounterData } from "./chronology";
import { pageMarks } from "@/lib/documents/meta";

const CHART = [
  "CONSOLIDATED HOSPITAL RECORDS",
  "Page 1 of 4",
  "Birthdate: 09/14/1984",
  "DATE OF SERVICE: 06/08/2024",
  "CHIEF COMPLAINT: Back pain after motor vehicle collision. Admitted to trauma service.",
  "Page 2 of 4",
  "DATE OF SERVICE: 06/12/2024",
  "PROCEDURE PERFORMED: Open reduction internal fixation of the lumbar spine.",
  "Page 3 of 4",
  "DATE OF SERVICE: 07/15/2024",
  "Progress note: patient advancing with therapeutic exercise and gait training.",
  "Page 4 of 4",
  "DATE OF SERVICE: 07/15/2024",
  "Impression: post-surgical recovery progressing; continued rehabilitation advised.",
].join("\n");

describe("segmentEncounters", () => {
  it("splits a consolidated chart into one encounter per distinct clinical date", () => {
    const enc = segmentEncounters(CHART, pageMarks(CHART));
    expect(enc.map((e) => e.dateIso)).toEqual(["2024-06-08", "2024-06-12", "2024-07-15"]);
  });

  it("attributes each encounter to the page its anchor appears on", () => {
    const enc = segmentEncounters(CHART, pageMarks(CHART));
    expect(enc[0].page).toBe(1);
    expect(enc[1].page).toBe(2);
    expect(enc[2].page).toBe(3); // same-date segments merge under the first page
  });

  it("keeps each encounter's own content (not its neighbors')", () => {
    const enc = segmentEncounters(CHART, pageMarks(CHART));
    expect(enc[1].text).toContain("Open reduction internal fixation");
    expect(enc[1].text).not.toContain("Back pain after motor vehicle collision");
    expect(enc[2].text).toContain("gait training");
    expect(enc[2].text).toContain("continued rehabilitation"); // merged same-date segment
  });

  it("ignores non-clinical dates (DOB, print stamps, future policy dates)", () => {
    const t = "Birthdate: 01/02/1985\nPrinted Date: 01/01/2025\nExpiration Date: 03/31/2027\nDATE OF SERVICE: 06/08/2024\nExam.\nDATE OF SERVICE: 06/09/2024\nExam.";
    const enc = segmentEncounters(t, []);
    expect(enc.map((e) => e.dateIso)).toEqual(["2024-06-08", "2024-06-09"]);
  });

  it("returns [] for a single-encounter record (no segmentation)", () => {
    const t = "OPERATIVE REPORT\nDATE OF PROCEDURE: 06/12/2024\nPROCEDURE PERFORMED: ORIF.";
    expect(segmentEncounters(t, [])).toHaveLength(0);
  });

  it("parses two-digit years ('Date: 10/31/25')", () => {
    const t = "Date: 10/31/25\nCatheter placed.\nDate: 11/02/25\nFollow-up exam.";
    const enc = segmentEncounters(t, []);
    expect(enc.map((e) => e.dateIso)).toEqual(["2025-10-31", "2025-11-02"]);
  });
});

describe("extractEncounterData — full LCP data points per medical-record event", () => {
  it("captures ER subjective + past medical history + disposition", () => {
    const er = [
      "EMERGENCY DEPARTMENT RECORD",
      "CHIEF COMPLAINT: Back pain after motor vehicle collision. TRIAGE level 2. Mode of arrival: ambulance.",
      "PAST MEDICAL HISTORY: Hypertension, type 2 diabetes mellitus, degenerative disc disease, and chronic low back pain. Former tobacco use.",
      "DISPOSITION: Admitted to trauma service.",
    ].join("\n");
    const d = extractEncounterData(er);
    expect(d.subjective).toMatch(/motor vehicle collision/i);
    expect(d.pastMedicalHistory).toMatch(/hypertension.*diabetes.*low back pain/i);
    expect(d.disposition).toMatch(/admitted to trauma/i);
  });

  it("splits an MRI into diagnostic-studies findings AND the assessment/impression", () => {
    const mri = [
      "MRI OF THE LUMBAR SPINE WITHOUT CONTRAST",
      "FINDINGS: L1 burst fracture with retropulsion and canal compromise. No cord signal abnormality.",
      "IMPRESSION: Acute L1 burst fracture as above.",
    ].join("\n");
    const d = extractEncounterData(mri, { isImaging: true });
    expect(d.imagingFindings).toMatch(/retropulsion and canal compromise/i);
    expect(d.diagnosis).toMatch(/acute l1 burst fracture/i);
    expect(d.imagingFindings).not.toBe(d.diagnosis);
  });

  it("resolves an operative 'Same.' assessment to the pre-op diagnosis and appends anesthesia/EBL", () => {
    const op = [
      "OPERATIVE REPORT",
      "PREOPERATIVE DIAGNOSIS: Displaced tibial plateau fracture, left knee.",
      "POSTOPERATIVE DIAGNOSIS: Same.",
      "PROCEDURE PERFORMED: Open reduction internal fixation, left tibial plateau.",
      "ANESTHESIA: General.",
      "ESTIMATED BLOOD LOSS: 150 mL.",
    ].join("\n");
    const d = extractEncounterData(op);
    expect(d.diagnosis).toMatch(/displaced tibial plateau fracture/i);
    expect(d.procedure).toMatch(/open reduction internal fixation/i);
    expect(d.procedure).toMatch(/general anesthesia/i);
    expect(d.procedure).toMatch(/EBL 150 mL/i);
  });

  it("captures a full medication line (drug, dose, SIG, days supply, refills)", () => {
    const rx = "PHARMACY PRINTOUT\nPrescription: Gabapentin 300 mg. SIG: take one tablet three times daily. Days supply: 30. Refills: 2.";
    const d = extractEncounterData(rx);
    expect(d.medications).toMatch(/gabapentin 300 mg/i);
    expect(d.medications).toMatch(/three times daily/i);
    expect(d.medications).toMatch(/refills: 2/i);
  });

  it("captures an IME impairment / MMI data point and a flagged lab result", () => {
    const ime = "INDEPENDENT MEDICAL EXAMINATION\nThe claimant has reached maximum medical improvement. An impairment rating is provided within a reasonable degree of medical certainty.";
    expect(extractEncounterData(ime).impairmentRating).toMatch(/impairment rating|maximum medical improvement/i);
    const lab = "LABORATORY REPORT\nHemoglobin 11.2 (REFERENCE RANGE 13.5-17.5) — result flag LOW.";
    expect(extractEncounterData(lab).imagingFindings).toMatch(/hemoglobin/i);
  });
});
