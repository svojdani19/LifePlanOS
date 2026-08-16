// ─────────────────────────────────────────────────────────────────────────────
// A page the pipeline READ and found empty is not a page it could not read.
//
// The page ledger draws that line deliberately — a PDF whose own text layer
// carries no content on a page is BLANK, while OCR returning nothing is
// UNREADABLE, because a blank sheet and an unreadable scan produce the same
// nothing and only a human looking at the image can tell them apart. The audit
// then lumped BLANK in with UNREADABLE and OCR_FAILED and raised a blocking
// "this page could not be read" finding per blank sheet. Blank filler pages
// are routine in a legal production, so that manufactured export blockers at
// volume about pages that were read perfectly.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { auditFactualRecord, type AuditEncounter, type AuditPage } from "@/lib/llm/factualAudit";

const encounter = (): AuditEncounter => ({
  id: "0",
  sourceDocumentId: "doc-1",
  dateStatus: "DOCUMENTED",
  encounterDate: "2025-03-14",
  provider: "A. Rivera, MD",
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit for lumbar radiculopathy.",
  claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 }],
  page: 1,
  status: "AI_DRAFT",
});

const auditWith = (pages: AuditPage[]) =>
  auditFactualRecord({ encounters: [encounter()], pages, failedExtractions: 0, unresolvedDisputes: 0, allDocumentsProcessed: true });

const page = (pageNumber: number, status: string, ocrConfidence: number | null = null): AuditPage => ({ pageNumber, status, ocrConfidence });

describe("a confirmed blank page is processed, not missing", () => {
  it("raises no finding for a native-text blank page", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(2, "BLANK")]);
    expect(out.scoped.filter((f) => f.scope === "PAGE")).toHaveLength(0);
    expect(out.result).toBe("PASS");
  });

  it("does not describe a blank page as unreadable in the disclosure text", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(2, "BLANK"), page(3, "BLANK")]);
    expect(out.findings.join(" ")).not.toMatch(/could not be read/);
  });

  it("does not block an export over blank filler pages", () => {
    const out = auditWith([page(1, "READABLE", 0.98), ...Array.from({ length: 20 }, (_, i) => page(i + 2, "BLANK"))]);
    expect(out.scoped.some((f) => f.blocking)).toBe(false);
  });
});

describe("everything genuinely unread still blocks", () => {
  it("blocks on OCR that returned no text — blank sheet or unreadable scan, nobody knows yet", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(7, "UNREADABLE")]);
    const found = out.scoped.filter((f) => f.scope === "PAGE" && f.blocking);
    expect(found).toHaveLength(1);
    expect(found[0].pageStart).toBe(7);
    expect(out.result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("blocks on a page whose OCR failed outright", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(4, "OCR_FAILED")]);
    expect(out.scoped.some((f) => f.scope === "PAGE" && f.blocking && f.pageStart === 4)).toBe(true);
  });

  it("blocks on a page inside a chunk the pipeline could not process", () => {
    // FAILED was in neither the audit nor the export gate, so a page whose
    // content was never read at all passed as sound.
    const out = auditWith([page(1, "READABLE", 0.98), page(5, "FAILED")]);
    expect(out.scoped.some((f) => f.scope === "PAGE" && f.blocking && f.pageStart === 5)).toBe(true);
    expect(out.result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("blocks on a page still awaiting OCR", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(6, "PENDING_OCR")]);
    expect(out.scoped.some((f) => f.scope === "PAGE" && f.blocking && f.pageStart === 6)).toBe(true);
  });

  it("blocks on a truncated page", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(8, "TRUNCATED")]);
    expect(out.scoped.some((f) => f.scope === "PAGE" && f.pageStart === 8)).toBe(true);
    expect(out.result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("flags weak text recognition for checking without blocking the export", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(9, "LOW_CONFIDENCE", 0.41)]);
    const low = out.scoped.filter((f) => f.type === "PAGE_LOW_CONFIDENCE");
    expect(low).toHaveLength(1);
    expect(low[0].blocking).toBe(false);
  });

  it("keeps the two empty-page states apart in one document", () => {
    const out = auditWith([page(1, "READABLE", 0.98), page(2, "BLANK"), page(3, "UNREADABLE")]);
    const pages = out.scoped.filter((f) => f.scope === "PAGE");
    expect(pages.map((f) => f.pageStart)).toEqual([3]);
  });
});
