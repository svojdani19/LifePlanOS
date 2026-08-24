import { describe, it, expect } from "vitest";
import { dedupeEvidenceSources } from "@/lib/engine/conditionEvidence";

// The observed defect: the "Chronic pain syndrome" causation card on
// REF-2026-0005 cited River Oaks BR&MR w Aff.pdf p. 1 "Chronic Pain Syndrome"
// twice — once from the validated-claims locator, once from the raw-text
// locator — which reads as two corroborating records where there is one.

import type { EvidenceSourceRow } from "@/lib/engine/conditionEvidence";

const claimRow: EvidenceSourceRow = { documentId: "doc-river-oaks", filename: "River Oaks BR&MR w Aff.pdf", page: 1, quote: "Chronic Pain Syndrome", field: "assessment", verbatim: true };
const textRow: EvidenceSourceRow = { documentId: "doc-river-oaks", filename: "River Oaks BR&MR w Aff.pdf", page: 1, quote: "Chronic Pain Syndrome", verbatim: true };

describe("dedupeEvidenceSources", () => {
  it("collapses the same quote found by both locators", () => {
    expect(dedupeEvidenceSources([claimRow, textRow])).toHaveLength(1);
  });

  it("keeps the claim-backed copy, so `field` survives for downstream grading", () => {
    const [kept] = dedupeEvidenceSources([claimRow, textRow]);
    expect(kept.field).toBe("assessment");
  });

  it("keeps the same quote when it appears on a different page", () => {
    expect(dedupeEvidenceSources([claimRow, { ...textRow, page: 4 }])).toHaveLength(2);
  });

  it("keeps the same quote when it comes from a different document", () => {
    const other = { ...textRow, documentId: "doc-spinelux", filename: "Spinelux BR&MR w Aff.pdf" };
    expect(dedupeEvidenceSources([claimRow, other])).toHaveLength(2);
  });

  it("keeps different quotes from the same page", () => {
    const other = { ...textRow, quote: "The pain is likely secondary to deep gluteal pain syndrome" };
    expect(dedupeEvidenceSources([claimRow, other])).toHaveLength(2);
  });

  it("treats casing and surrounding whitespace as the same citation", () => {
    const scruffy = { ...textRow, quote: "  chronic pain SYNDROME  " };
    expect(dedupeEvidenceSources([claimRow, scruffy])).toHaveLength(1);
  });

  it("distinguishes a null page from page 1 rather than merging them", () => {
    // A missing page is not evidence that the quote came from page 1, and
    // collapsing the two would silently attribute a page the record never gave.
    expect(dedupeEvidenceSources([claimRow, { ...textRow, page: null }])).toHaveLength(2);
  });

  it("preserves input order for citations it keeps", () => {
    const a = { ...claimRow, quote: "first" };
    const b = { ...claimRow, quote: "second" };
    const c = { ...claimRow, quote: "third" };
    expect(dedupeEvidenceSources([a, b, c, b]).map((s) => s.quote)).toEqual(["first", "second", "third"]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeEvidenceSources([])).toEqual([]);
  });
});
