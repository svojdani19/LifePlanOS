import { describe, expect, it } from "vitest";
import { linkCopies, type StructuredEncounter } from "@/lib/records/structuredRecord";

// Synthetic. The scenario is the ER visit that appeared in two productions —
// the hospital's own chart and a copy subpoenaed by another practice — and
// asked a reviewer to review the same visit twice.

const enc = (id: string, docId: string, over: Partial<StructuredEncounter> = {}): StructuredEncounter =>
  ({
    id,
    sourceDocumentId: docId,
    dateStatus: "DOCUMENTED",
    encounterDate: "2023-05-29",
    encounterDateEnd: null,
    provider: "Paul English, MD",
    providerCredentials: null,
    facility: null,
    encounterType: "Emergency",
    factualSummary: "Emergency — contusions; discharged.",
    synthesis: null,
    claims: [],
    page: 1,
    pageEnd: null,
    ocrConfidence: null,
    warnings: [],
    status: "AI_DRAFT",
    substanceClass: "CLINICAL",
    substanceReason: null,
    analysisClass: "CLINICAL_ENCOUNTER",
    attributionName: null,
    attributionRole: null,
    reviewedAt: null,
    verifiedAt: null,
    staleReason: null,
    ...over,
  }) as StructuredEncounter;

const byId = (rows: StructuredEncounter[]) => new Map(rows.map((r) => [r.id, r]));

describe("one record in two productions reviews once", () => {
  it("links the copy to the primary and the primary to the copy", () => {
    const primary = enc("row-a", "doc-hospital");
    const copy = enc("row-b", "doc-subpoena", { page: 4 });
    const docs = [
      { id: "doc-hospital", filename: "Hospital_Chart.pdf", segments: [{ rowIds: ["row-a", "row-b"] }] },
      { id: "doc-subpoena", filename: "Subpoenaed_Copy.pdf", segments: [] },
    ];
    linkCopies(docs, byId([primary, copy]));
    expect(primary.copies).toEqual([
      { id: "row-b", filename: "Subpoenaed_Copy.pdf", page: 4, summary: copy.factualSummary, status: "AI_DRAFT" },
    ]);
    expect(copy.reviewedWith).toEqual({ filename: "Hospital_Chart.pdf" });
    expect(copy.copies).toBeUndefined();
  });

  it("never links fragments of one note within a single document", () => {
    // Fragments carry DIFFERENT content; each deserves its own eyes.
    const a = enc("row-a", "doc-1");
    const b = enc("row-b", "doc-1");
    const docs = [{ id: "doc-1", filename: "Chart.pdf", segments: [{ rowIds: ["row-a", "row-b"] }] }];
    linkCopies(docs, byId([a, b]));
    expect(a.copies).toBeUndefined();
    expect(b.reviewedWith).toBeUndefined();
  });

  it("skips rows that are no longer review-visible", () => {
    // A superseded copy is history; it neither appears nor is co-signed.
    const primary = enc("row-a", "doc-1");
    const docs = [
      { id: "doc-1", filename: "Chart.pdf", segments: [{ rowIds: ["row-a", "row-gone"] }] },
      { id: "doc-2", filename: "Copy.pdf", segments: [] },
    ];
    linkCopies(docs, byId([primary]));
    expect(primary.copies).toBeUndefined();
  });

  it("tolerates malformed segments JSON", () => {
    const primary = enc("row-a", "doc-1");
    const docs = [
      { id: "doc-1", filename: "Chart.pdf", segments: "not an array" },
      { id: "doc-2", filename: "Copy.pdf", segments: [{ rowIds: "nope" }, {}] },
    ];
    expect(() => linkCopies(docs, byId([primary]))).not.toThrow();
  });

  it("carries the copy's own review status so a resolved copy is not re-signed", () => {
    const primary = enc("row-a", "doc-1");
    const copy = enc("row-b", "doc-2", { status: "VERIFIED" });
    const docs = [
      { id: "doc-1", filename: "Chart.pdf", segments: [{ rowIds: ["row-a", "row-b"] }] },
      { id: "doc-2", filename: "Copy.pdf", segments: [] },
    ];
    linkCopies(docs, byId([primary, copy]));
    expect(primary.copies?.[0].status).toBe("VERIFIED");
  });
});
