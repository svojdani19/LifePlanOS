import { describe, it, expect } from "vitest";
import { recordEncounters } from "@/lib/documents/recordSummary";
import { SAMPLE_DOCS } from "@/lib/documents/samples";

// The Records panel splits a consolidated chart into one row per encounter and
// shows a plain narrative for single-visit records. These tests pin that split
// and — critically — that provider extraction never mistakes clinical prose
// ("physician: see notes below") for a provider name.

const asRec = (text: string) => ({ extractedText: text }) as never;

describe("recordEncounters", () => {
  it("splits the consolidated sample record into per-date encounters with providers", () => {
    const consolidated = SAMPLE_DOCS.find((d) => d.filename === "Uploaded_Document_12.pdf");
    expect(consolidated).toBeTruthy();
    const enc = recordEncounters(asRec(consolidated!.text));
    expect(enc).not.toBeNull();
    expect(enc!.length).toBe(4);
    // Every encounter is dated, and this record names a provider on each.
    expect(enc!.map((e) => e.label)).toEqual(["06/08/2024", "06/12/2024", "07/15/2024", "08/20/2024"]);
    expect(enc!.map((e) => e.provider)).toEqual([
      "Omar Haddad, MD — Emergency Medicine",
      "Nadia Brandt, MD — Orthopedic Spine Surgery",
      "Priya Nair, PT, DPT — Physical Therapy",
      "Sam Okafor, MD — Physical Medicine & Rehabilitation",
    ]);
    // Encounters are chronological and each carries a non-empty summary.
    for (const e of enc!) expect(e.summary.length).toBeGreaterThan(0);
  });

  it("returns null for single-encounter records (they render as a narrative)", () => {
    const single = SAMPLE_DOCS.filter((d) => d.filename !== "Uploaded_Document_12.pdf");
    for (const d of single) expect(recordEncounters(asRec(d.text))).toBeNull();
  });

  it("never extracts a provider from clinical prose that merely mentions a role", () => {
    // Two dated encounters so the record IS treated as consolidated, but every
    // "physician/provider/surgeon" here is prose, not a labeled name.
    const prose = [
      "Date of service: 01/02/2024",
      "The physician discussed the plan with the family today.",
      "Provider communication was documented per policy.",
      "Date of service: 02/03/2024",
      "Surgeon consulted regarding operative candidacy.",
      "Physician: see notes below for the assessment and plan.",
    ].join("\n");
    const enc = recordEncounters(asRec(prose));
    expect(enc).not.toBeNull();
    expect(enc!.length).toBe(2);
    for (const e of enc!) expect(e.provider).toBeNull();
  });
});
