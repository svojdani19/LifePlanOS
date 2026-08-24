// ─────────────────────────────────────────────────────────────────────────────
// The chronology is built from CANONICAL ENCOUNTERS, not from fragments.
//
// One real encounter should put one line on the timeline. The failure this
// guards is the one the record surface had: extraction chunks a note into
// several rows, and anything counting rows instead of records reports a single
// visit as three — on the timeline that reads as three visits, which is a
// clinical claim nobody made.
//
// The proof that matters here is STRUCTURAL: the persisted segments (the
// canonical encounters the Records page and the report cite) and the
// chronology drafts come out of the same composition pass over the same
// `notes`, so they cannot describe different sets of records. These tests
// exercise that pass end to end rather than asserting it.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import { buildRecords } from "@/lib/records/buildRecords";
import type { MergeableRow } from "@/lib/records/entryMerge";

vi.setConfig({ testTimeout: 30_000 });

const CASE = "case-chronology-grain";
let nextRow = 0;
const row = (over: Partial<MergeableRow> = {}): MergeableRow => ({
  id: `row-${++nextRow}`,
  sourceDocumentId: "doc-1",
  analysisClass: "CLINICAL_ENCOUNTER",
  encounterDate: null,
  provider: null,
  facility: null,
  page: null,
  pageEnd: null,
  substanceClass: "CLINICAL",
  dateStatus: "UNKNOWN",
  claims: [{ field: "assessment", value: "Lumbar radiculopathy documented", excerpt: "lumbar radiculopathy" }],
  ...over,
});

const filler = (n = 500) => " clinical narrative continues ".repeat(n / 10);

const build = (text: string, rows: MergeableRow[]) =>
  buildRecords({
    caseId: CASE,
    documents: [{ id: "doc-1", pageCount: 12, extractedText: text, rows }],
    write: false,
    adjudicateDuplicates: false,
  });

const segments = (built: Awaited<ReturnType<typeof build>>) => built.segmentsByDocument.get("doc-1") ?? [];

describe("one canonical encounter, one chronology event", () => {
  it("puts three fragments of one note on the timeline once", async () => {
    const text =
      `History and Physical Encounter Date: 05/02/2024 ${filler()} reports low back pain ` +
      `${filler()} examination showed reduced range of motion ${filler()} assessment lumbar strain ${filler()}`;
    const built = await build(text, [
      row({
        provider: "A. Rivera, MD",
        claims: [{ field: "subjective", value: "Reports low back pain radiating to the left leg", excerpt: "reports low back pain" }],
      }),
      row({
        provider: "A. Rivera, MD",
        claims: [{ field: "objectiveFindings", value: "Examination showed reduced lumbar range of motion", excerpt: "examination showed reduced range of motion" }],
      }),
      row({
        provider: "A. Rivera, MD",
        claims: [{ field: "assessment", value: "Lumbar strain with radicular features", excerpt: "assessment lumbar strain" }],
      }),
    ]);

    // One record…
    expect(segments(built)).toHaveLength(1);
    expect(segments(built)[0].rowIds).toHaveLength(3);
    // …and one line on the timeline, not three.
    expect(built.chronology).toHaveLength(1);
    expect(built.chronology[0].eventDate.toISOString().slice(0, 10)).toBe("2024-05-02");
  });

  it("draws its events from the same canonical encounters the Records page cites", async () => {
    const text =
      `Operative Report Date of Service: 06/11/2024 ${filler()} microdiscectomy performed at L4-5 ` +
      `${filler()} Physical Therapy Note Date of Service: 07/09/2024 ${filler()} lumbar traction at sixty pounds ${filler()}`;
    const built = await build(text, [
      row({ provider: "F. Techy, MD", analysisClass: "OPERATIVE", claims: [{ field: "procedure", value: "Microdiscectomy performed at L4-5 on the left", excerpt: "microdiscectomy performed at L4-5" }] }),
      row({ provider: "M. Okonkwo, PT", analysisClass: "THERAPY_COURSE", claims: [{ field: "treatment", value: "Lumbar traction applied at sixty pounds for fifteen minutes", excerpt: "lumbar traction at sixty pounds" }] }),
    ]);

    const dated = segments(built).filter((s) => s.date && s.kind === "clinical");
    expect(dated.length).toBeGreaterThan(0);
    // Every event traces to a canonical encounter of the same document and date.
    for (const event of built.chronology) {
      expect(event.sourceDocumentId).toBe("doc-1");
      const day = event.eventDate.toISOString().slice(0, 10);
      expect(dated.some((s) => s.date === day)).toBe(true);
    }
    expect(built.chronology.length).toBeLessThanOrEqual(segments(built).length);
  });
});

describe("two distinct encounters on one day stay two", () => {
  it("keeps a surgeon's operative report and a therapist's session apart", async () => {
    const text =
      `Operative Report Date of Service: 08/14/2024 ${filler()} microdiscectomy performed at L4-5 ` +
      `${filler()} Physical Therapy Evaluation Date of Service: 08/14/2024 ${filler()} lumbar traction at sixty pounds ${filler()}`;
    const built = await build(text, [
      row({
        provider: "F. Techy, MD",
        analysisClass: "OPERATIVE",
        claims: [{ field: "procedure", value: "Microdiscectomy performed at L4-5 on the left", excerpt: "microdiscectomy performed at L4-5" }],
      }),
      row({
        provider: "M. Okonkwo, PT",
        analysisClass: "THERAPY_COURSE",
        claims: [{ field: "treatment", value: "Lumbar traction applied at sixty pounds for fifteen minutes", excerpt: "lumbar traction at sixty pounds" }],
      }),
    ]);

    // A date is not an identity: two records, and two events on that date.
    expect(segments(built)).toHaveLength(2);
    const sameDay = built.chronology.filter((e) => e.eventDate.toISOString().slice(0, 10) === "2024-08-14");
    expect(sameDay).toHaveLength(2);
    // Two clinicians, two records — neither swallowed by the other's date.
    expect(new Set(sameDay.map((e) => e.provider)).size).toBe(2);
  });
});

describe("paperwork does not become care", () => {
  it("keeps a consent page off the clinical timeline", async () => {
    const text =
      `Progress Note Date of Service: 09/03/2024 ${filler()} straight leg raise positive on the right ` +
      `${filler()} Informed Consent Date: 09/03/2024 ${filler()} the patient signed the consent for the procedure ${filler()}`;
    const built = await build(text, [
      row({
        provider: "A. Rivera, MD",
        claims: [{ field: "objectiveFindings", value: "Straight leg raise positive on the right at forty degrees", excerpt: "straight leg raise positive on the right" }],
      }),
      row({
        provider: "A. Rivera, MD",
        analysisClass: "INSURANCE_ADMINISTRATIVE",
        substanceClass: "ADMINISTRATIVE",
        claims: [{ field: "consent", value: "The patient signed the consent for the procedure", excerpt: "the patient signed the consent" }],
      }),
    ]);

    // The consent is retained as a record — it is still in the file — but it
    // documents paperwork, not a visit, so it puts nothing on the timeline.
    expect(segments(built).length).toBeGreaterThanOrEqual(1);
    for (const event of built.chronology) {
      expect(String(event.summary ?? "")).not.toMatch(/signed the consent/i);
    }
  });
});

// The other half of that rule — a codes-only bill that is a visit's ONLY
// witness DOES reach the timeline, marked as billing-documented — is proved
// end to end in buildRecords.test.ts ("a bill with nothing but codes still
// witnesses its visit"), together with the twin it withholds when a clinical
// record documents the same service.
