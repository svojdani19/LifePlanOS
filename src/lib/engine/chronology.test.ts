import { describe, it, expect } from "vitest";
import { segmentEncounters, extractEncounterData, extractFinding } from "./chronology";
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

describe("extractFinding rejects metadata / boilerplate leads (Chen chronology fix)", () => {
  it("skips a FACILITY line and picks the clinical sentence", () => {
    const t = "NEUROPSYCHOLOGICAL EVALUATION\nFACILITY: Cognitive Health Institute, Newport Beach, CA.\nCognitive functioning and memory index scores are reported.";
    const f = extractFinding(t, new Set(["cognitive"]));
    expect(f).toBeTruthy();
    expect(f).not.toMatch(/facility|cognitive health institute/i);
    expect(f).toMatch(/memory index|cognitive functioning/i);
  });

  it("does not headline pharmacy boilerplate", () => {
    const t = "PHARMACY PRINTOUT\nDispense as written. Pharmacy record of fills below. NDC listed.";
    expect(extractFinding(t, new Set())).toBeNull();
  });
});

describe("segmentEncounters — narrative/report-style sources", () => {
  it("segments line-leading 'MM/DD/YYYY - Provider' headers when no labeled dates exist", () => {
    const text = [
      "Records Review (DOB: 02/09/1972)", // inline DOB must NOT anchor
      "",
      "06/13/2023 - Jill A. Ward, M.D./HCA Florida Memorial Hospital - Emergency Department Report",
      "Subjective: Slipped and fell in the shower, striking her head. Brief loss of consciousness.",
      "Assessment: Closed head injury, back strain, knee contusion.",
      "",
      "07/13/2023 - 02/26/2024 - Edward Young, M.D./Jacksonville Orthopaedic Institute",
      "Assessment: Severe DJD of the right knee. Plan: total knee arthroplasty.",
      "",
      "08/02/2023 - Richard Newman, M.D./EMAS Spine and Brain Specialists - Videonystagmography Report",
      "Impressions: Significant peripheral and central vestibular dysfunction.",
    ].join("\n");
    const enc = segmentEncounters(text, []);
    expect(enc.map((e) => e.dateIso)).toEqual(["2023-06-13", "2023-07-13", "2023-08-02"]);
    expect(enc[0].text).toMatch(/closed head injury/i);
    expect(enc[1].text).toMatch(/arthroplasty/i);
    // The DOB in the page header never becomes an encounter.
    expect(enc.some((e) => e.dateIso === "1972-02-09")).toBe(false);
  });
});

// ── Classification safety (source-grounded pipeline) ─────────────────────────
import { classifySegment, providerIdentityKey, composeProviderName, sameProvider } from "./chronology";
import { POST_OP_MENTION_RE } from "./chronologyEmphasis";

describe("classifySegment — negation and procedure-type discipline", () => {
  it("'no complications' is NOT classified as a complication", () => {
    const note = "OPERATIVE REPORT. Procedure performed: arthroscopy. The patient tolerated the procedure well with no complications. Discharged without complication.";
    expect(classifySegment(note).eventType).not.toBe("COMPLICATION");
  });

  it("'denies infection' and 'negative for infection' are not complications", () => {
    expect(classifySegment("Follow-up visit. Patient denies infection or drainage at the incision site.").eventType).not.toBe("COMPLICATION");
    expect(classifySegment("Wound check: negative for infection.").eventType).not.toBe("COMPLICATION");
  });

  it("a genuinely documented complication still classifies", () => {
    const note = "Progress note: the surgical wound shows purulent drainage consistent with deep infection; readmitted for washout.";
    expect(classifySegment(note).eventType).toBe("COMPLICATION");
  });

  it("a pain-management injection note is an injection/procedure, NOT surgery, despite 'procedure performed'", () => {
    const note = "PROCEDURE NOTE. Procedure performed: right L4-L5 transforaminal epidural steroid injection under fluoroscopic guidance.";
    const c = classifySegment(note);
    expect(c.eventType).not.toBe("SURGERY");
    expect(c.recordType).toMatch(/Injection/);
  });

  it("a true operative report still classifies as surgery", () => {
    const note = "OPERATIVE REPORT. Operation performed: ORIF of the left distal radius. Surgeon: A. Example, MD. Anesthesia: general.";
    expect(classifySegment(note).eventType).toBe("SURGERY");
  });
});

describe("post-operative anchoring requires explicit support", () => {
  it("POST_OP_MENTION_RE matches only explicit post-operative language", () => {
    expect(POST_OP_MENTION_RE.test("Patient is status post lumbar fusion.")).toBe(true);
    expect(POST_OP_MENTION_RE.test("s/p ORIF, doing well")).toBe(true);
    expect(POST_OP_MENTION_RE.test("Seen following her surgery for wound check.")).toBe(true);
    // Chronological proximity alone — an ordinary visit after a surgery date —
    // carries no post-operative language and must not anchor.
    expect(POST_OP_MENTION_RE.test("Routine follow-up for knee pain. Continue home exercise program.")).toBe(false);
  });
});

describe("providerIdentityKey — one clinician, many spellings", () => {
  it("resolves chart and billing spellings of the same person to one key", () => {
    expect(providerIdentityKey("Paul English, MD")).toBe(providerIdentityKey("ENGLISH, PAUL W"));
    expect(providerIdentityKey("Jose Villalobos, M.D.")).toBe(providerIdentityKey("Villalobos, Jose"));
  });

  it("keeps genuinely different clinicians distinct", () => {
    expect(providerIdentityKey("Paul English, MD")).not.toBe(providerIdentityKey("Alexis Chen, MD"));
  });

  it("credentials and honorifics never carry identity", () => {
    expect(providerIdentityKey("Dr. Chen, MD, FACS")).toBe("chen");
    expect(providerIdentityKey(null)).toBe("");
  });
});

describe("extraction-driven event typing and provider naming", () => {
  it("composeProviderName never doubles credentials the name already carries", () => {
    expect(composeProviderName("Mark Filley, MD", "MD")).toBe("Mark Filley, MD");
    expect(composeProviderName("Julieta Oneto, MD", "MD, Board Certified")).toBe("Julieta Oneto, MD, Board Certified");
    expect(composeProviderName("Susan Fan", "MD")).toBe("Susan Fan, MD");
    expect(composeProviderName(null, "MD")).toBeNull();
  });
});

describe("sameProvider — abbreviated chart and billing name forms", () => {
  it("treats an abbreviated form as the same clinician", () => {
    expect(sameProvider("BRITTANY R IRWIN, PA-C", "R Irwin, PA-C")).toBe(true);
    expect(sameProvider("Irwin", "Brittany Irwin, PA-C")).toBe(true);
  });

  it("keeps different clinicians distinct even when they share a surname", () => {
    expect(sameProvider("John Smith, MD", "Jane Smith, MD")).toBe(false);
    expect(sameProvider("Paul English, MD", "Alexis Chen, MD")).toBe(false);
  });

  it("an unnamed side is missing information, not a different person", () => {
    expect(sameProvider(null, "Brittany Irwin, PA-C")).toBe(true);
    expect(sameProvider("Brittany Irwin, PA-C", "")).toBe(true);
  });

  it("credentials alone never make a match", () => {
    expect(sameProvider("MD", "PA-C")).toBe(true); // both reduce to no name tokens
    expect(sameProvider("Chen, MD", "Irwin, PA-C")).toBe(false);
  });
});

import { significanceOf } from "./chronology";

describe("significanceOf — computed at display time, never stored", () => {
  // Stored significance described the plan as it stood at the LAST records
  // rebuild; computed against the caller's current conditions and services it
  // always describes the plan the reader is actually looking at.
  const event = {
    summary: "Follow-up for lumbar radiculopathy; continues physical therapy.",
    diagnosis: "Lumbar radiculopathy",
    treatment: "Continue physical therapy",
  };

  it("ties an event to the conditions and services supplied NOW", () => {
    const text = significanceOf(event, ["Lumbar radiculopathy"], ["Physical therapy"]);
    expect(text).toMatch(/Documents Lumbar radiculopathy/);
    expect(text).toMatch(/[Pp]hysical therapy/);
  });

  it("changes when the plan changes, with the event untouched", () => {
    const before = significanceOf(event, ["Lumbar radiculopathy"], ["Physical therapy"]);
    const after = significanceOf(event, ["Cervical strain"], ["Home exercise program"]);
    expect(before).not.toBe(after);
  });

  it("returns null rather than a generic sentence when nothing matches", () => {
    expect(significanceOf(event, ["Traumatic brain injury"], ["Attendant care"])).toBeNull();
  });

  it("returns null for an empty event", () => {
    expect(significanceOf({}, ["Lumbar radiculopathy"], [])).toBeNull();
  });
});
