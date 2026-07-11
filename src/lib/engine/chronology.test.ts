import { describe, it, expect } from "vitest";
import { segmentEncounters } from "./chronology";
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
