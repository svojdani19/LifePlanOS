import { describe, it, expect } from "vitest";
import { isRecordEvidenceSource, recordEvidenceSources, referenceDocuments, isReferenceOrigin, REFERENCE_DOC_TYPES } from "@/lib/reference/boundary";

describe("a finalized plan is a teacher, not a witness", () => {
  it("refuses every opinion-about-the-case document as a record source", () => {
    for (const t of REFERENCE_DOC_TYPES) expect(isRecordEvidenceSource({ type: t }), t).toBe(false);
  });

  it("admits ordinary clinical records", () => {
    for (const t of ["OPERATIVE_NOTE", "IMAGING_REPORT", "ER_RECORD", "PT_OT_RECORD", "PAIN_MANAGEMENT", "OTHER"]) {
      expect(isRecordEvidenceSource({ type: t }), t).toBe(true);
    }
  });

  it("covers LIFE_CARE_PLAN, which the chronology's own exclusion list missed", () => {
    expect(isRecordEvidenceSource({ type: "LIFE_CARE_PLAN" })).toBe(false);
  });

  it("treats an untyped document as a record — the conservative default for care", () => {
    // A record wrongly withheld loses evidence; a plan wrongly mined fabricates
    // it. Untyped documents are overwhelmingly records, and the classifier
    // types finalized plans explicitly.
    expect(isRecordEvidenceSource({ type: null })).toBe(true);
  });

  it("partitions a mixed set without losing anything", () => {
    const docs = [{ type: "OPERATIVE_NOTE" }, { type: "LIFE_CARE_PLAN" }, { type: "IMAGING_REPORT" }, { type: "EXPERT_REPORT" }];
    expect(recordEvidenceSources(docs)).toHaveLength(2);
    expect(referenceDocuments(docs)).toHaveLength(2);
    expect(recordEvidenceSources(docs).length + referenceDocuments(docs).length).toBe(docs.length);
  });

  it("knows GOLD_IMPORT is reference content, not authored production content", () => {
    expect(isReferenceOrigin("GOLD_IMPORT")).toBe(true);
    expect(isReferenceOrigin("PHYSICIAN_ADDED")).toBe(false);
    expect(isReferenceOrigin("RECORD_RECOMMENDED")).toBe(false);
    expect(isReferenceOrigin(null)).toBe(false);
  });
});
