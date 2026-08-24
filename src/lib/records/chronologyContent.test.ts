// ─────────────────────────────────────────────────────────────────────────────
// What a chronology event says, as a hash.
//
// `ChronologyEvent` has no `updatedAt`, so a batch confirmation has no version
// column to compare against, and `sourceFingerprint` is not a substitute: it
// fingerprints the extracted claims an event was GENERATED from, not the
// sentence and structured fields a reader of the Medical Chronology sees. An
// event whose summary or work status changed while its review status stayed
// AI_DRAFT carried the same fingerprint and the same status — and would have
// been signed as the version that was displayed.
//
// So the identity of an event, for confirmation, is everything that can reach
// the report. These tests hold that: every listed field must move the hash,
// and nothing about ordering or object identity may.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import {
  CHRONOLOGY_CONTENT_FIELDS,
  CHRONOLOGY_CONTENT_SELECT,
  chronologyEventContentHash,
  type ChronologyContentRow,
} from "@/lib/records/chronologyContent";

const event = (over: Partial<ChronologyContentRow> = {}): ChronologyContentRow => ({
  id: "e1",
  eventDate: new Date("2025-03-14T00:00:00Z"),
  eventDateEnd: null,
  dateInferred: false,
  eventType: "CLINIC_VISIT",
  recordType: "CLINICAL_ENCOUNTER",
  specialty: "Orthopaedics",
  provider: "A. Rivera, MD",
  facility: "Northgate Clinic",
  summary: "Follow-up for lumbar radiculopathy; conservative care continued.",
  subjective: "Reports low back pain radiating to the left leg.",
  pastMedicalHistory: null,
  objectiveFindings: "Straight leg raise positive at forty degrees.",
  diagnosis: "Lumbar radiculopathy",
  treatment: "Continue physical therapy; consider MRI.",
  procedure: null,
  disposition: "Return in four weeks.",
  imagingFindings: null,
  medications: null,
  restrictions: null,
  workStatus: null,
  functionalStatus: null,
  impairmentRating: null,
  clinicalSignificance: null,
  sourceDocumentId: "doc-1",
  sourcePage: 4,
  sourceQuote: "straight leg raise positive on the right",
  sourceFingerprint: "fp-1",
  extractionId: "run-1",
  relevanceScore: 50,
  relatedness: "UNCLEAR",
  seriesMembers: null,
  reviewStatus: "AI_DRAFT",
  edited: false,
  ...over,
});

/** A distinct value for every field, so "changed" is unambiguous. */
const CHANGES: Partial<Record<(typeof CHRONOLOGY_CONTENT_FIELDS)[number], unknown>> = {
  eventDate: new Date("2025-03-15T00:00:00Z"),
  eventDateEnd: new Date("2025-05-01T00:00:00Z"),
  dateInferred: true,
  eventType: "SURGERY",
  recordType: "OPERATIVE",
  specialty: "Neurosurgery",
  provider: "F. Techy, MD",
  facility: "St Anne's Hospital",
  summary: "A materially different sentence about this visit.",
  subjective: "Reports no pain at all.",
  pastMedicalHistory: "Hypertension.",
  objectiveFindings: "Straight leg raise negative.",
  diagnosis: "Lumbar strain",
  treatment: "Discharge from care.",
  procedure: "L4-5 microdiscectomy",
  disposition: "Admitted.",
  imagingFindings: "Disc protrusion at L4-5.",
  medications: "Gabapentin 300mg.",
  restrictions: "No lifting over ten pounds.",
  workStatus: "Off work six weeks.",
  functionalStatus: "Ambulates with a cane.",
  impairmentRating: "12% whole person",
  clinicalSignificance: "Grounds the future-care recommendation.",
  sourceDocumentId: "doc-2",
  sourcePage: 42,
  sourceQuote: "a different verbatim excerpt",
  sourceFingerprint: "fp-2",
  extractionId: "run-2",
  relevanceScore: 90,
  relatedness: "RELATED",
  seriesMembers: [{ date: "2025-03-14", documentId: "doc-1", page: 4 }],
  reviewStatus: "REVIEWED",
  edited: true,
};

describe("every field that can reach the report moves the hash", () => {
  it("covers each declared field, one at a time", () => {
    const base = chronologyEventContentHash(event());
    for (const field of CHRONOLOGY_CONTENT_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(CHANGES, field), `no change case for ${field}`).toBe(true);
      const moved = chronologyEventContentHash(event({ [field]: CHANGES[field] } as Partial<ChronologyContentRow>));
      expect(moved, field).not.toBe(base);
    }
  });

  it("names every field the report renders — the list is exhaustive on purpose", () => {
    // Derived from `Object.keys` this would silently stop covering a column
    // the day somebody forgot to select it. It is declared instead, so adding
    // one to the model forces a decision here.
    for (const field of [
      "summary", "subjective", "objectiveFindings", "diagnosis", "treatment", "procedure",
      "disposition", "imagingFindings", "medications", "restrictions", "workStatus",
      "functionalStatus", "impairmentRating", "clinicalSignificance", "pastMedicalHistory",
      "eventDate", "eventDateEnd", "eventType", "recordType", "specialty", "provider", "facility",
      "sourceDocumentId", "sourcePage", "sourceQuote", "sourceFingerprint", "extractionId",
      "dateInferred", "relevanceScore", "relatedness", "seriesMembers",
    ]) {
      expect(CHRONOLOGY_CONTENT_FIELDS as readonly string[], field).toContain(field);
    }
  });

  it("moves when a series gains a visit without changing its range", () => {
    // The membership change the end-date discriminator alone cannot see.
    const three = event({ seriesMembers: [{ date: "2025-01-06" }, { date: "2025-02-03" }, { date: "2025-03-14" }] });
    const four = event({ seriesMembers: [{ date: "2025-01-06" }, { date: "2025-01-20" }, { date: "2025-02-03" }, { date: "2025-03-14" }] });
    expect(chronologyEventContentHash(four)).not.toBe(chronologyEventContentHash(three));
  });

  it("distinguishes two events that read alike", () => {
    expect(chronologyEventContentHash(event({ id: "e2" }))).not.toBe(chronologyEventContentHash(event()));
  });
});

describe("the hash is stable", () => {
  it("does not depend on key order or object identity", () => {
    const a = event();
    const b: ChronologyContentRow = { ...a };
    // Rebuild in reverse key order.
    const reversed = Object.fromEntries(Object.entries(b).reverse()) as ChronologyContentRow;
    expect(chronologyEventContentHash(reversed)).toBe(chronologyEventContentHash(a));
  });

  it("treats null, undefined and an absent field the same way", () => {
    const withNull = chronologyEventContentHash(event({ workStatus: null }));
    const withUndefined = chronologyEventContentHash(event({ workStatus: undefined }));
    const absent = { ...event() };
    delete (absent as Record<string, unknown>).workStatus;
    expect(withUndefined).toBe(withNull);
    expect(chronologyEventContentHash(absent)).toBe(withNull);
  });

  it("reads a Date and its ISO string identically", () => {
    expect(chronologyEventContentHash(event({ eventDate: "2025-03-14T00:00:00.000Z" }))).toBe(
      chronologyEventContentHash(event({ eventDate: new Date("2025-03-14T00:00:00Z") })),
    );
  });

  it("does not depend on the key order inside a series member", () => {
    const forward = event({ seriesMembers: [{ date: "2025-01-06", documentId: "d", page: 2 }] });
    const shuffled = event({ seriesMembers: [{ page: 2, documentId: "d", date: "2025-01-06" }] });
    expect(chronologyEventContentHash(shuffled)).toBe(chronologyEventContentHash(forward));
  });
});

describe("the select and the hash cannot drift apart", () => {
  it("selects exactly the fields the hash reads, plus the id", () => {
    const selected = Object.keys(CHRONOLOGY_CONTENT_SELECT).sort();
    expect(selected).toEqual(["id", ...CHRONOLOGY_CONTENT_FIELDS].sort());
    expect(Object.values(CHRONOLOGY_CONTENT_SELECT).every((v) => v === true)).toBe(true);
  });
});
