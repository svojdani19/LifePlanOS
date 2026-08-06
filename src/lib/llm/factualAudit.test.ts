// The adversarial audit decides whether a draft may be PRESENTED as complete.
// These tests pin the refusals — the cases where the correct behaviour is to
// withhold a clean-looking draft. Synthetic data only.
import { describe, it, expect } from "vitest";
import { auditFactualRecord, isPresentableAsCompleteDraft, splitSentences, type AuditInput } from "./factualAudit";

const page = (n: number, status = "READABLE", ocrConfidence: number | null = 0.98) => ({ pageNumber: n, status, ocrConfidence });

const claim = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  field: "assessment",
  claimType: "DIAGNOSIS",
  value: "Lumbar radiculopathy",
  excerpt: "Assessment: Lumbar radiculopathy",
  page: 1,
  ...over,
});

const encounter = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  sourceDocumentId: "doc-1",
  dateStatus: "DOCUMENTED",
  encounterDate: "2025-03-14",
  provider: "Dana Rivers, MD",
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit — Lumbar radiculopathy.",
  claims: [claim()],
  page: 1,
  status: "AI_DRAFT",
  ...over,
});

const base = (over: Partial<AuditInput> = {}): AuditInput => ({
  encounters: [encounter()],
  pages: [page(1)],
  failedExtractions: 0,
  unresolvedDisputes: 0,
  allDocumentsProcessed: true,
  ...over,
});

describe("a clean draft passes", () => {
  it("PASS only when nothing is outstanding", () => {
    const r = auditFactualRecord(base());
    expect(r.result).toBe("PASS");
    expect(r.findings).toEqual([]);
    expect(isPresentableAsCompleteDraft(r.result)).toBe(true);
  });

  it("no other result may be presented as a complete draft", () => {
    for (const s of ["NEEDS_HUMAN_REVIEW", "EXTRACTION_INCOMPLETE", "SOURCE_CONFLICT", "FAILED", null] as const) {
      expect(isPresentableAsCompleteDraft(s)).toBe(false);
    }
  });
});

describe("source completeness outranks a clean-looking extraction", () => {
  it("unreadable pages make the case EXTRACTION_INCOMPLETE", () => {
    const r = auditFactualRecord(base({ pages: [page(1), page(2, "UNREADABLE", null)] }));
    expect(r.result).toBe("EXTRACTION_INCOMPLETE");
    expect(r.findings.join(" ")).toMatch(/could not be read/);
  });

  it("pages still awaiting OCR block completion", () => {
    const r = auditFactualRecord(base({ pages: [page(1), page(2, "PENDING_OCR", null)] }));
    expect(r.result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("a failed document extraction blocks completion", () => {
    expect(auditFactualRecord(base({ failedExtractions: 1 })).result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("documents still processing block completion", () => {
    expect(auditFactualRecord(base({ allDocumentsProcessed: false })).result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("low-confidence OCR requires human review", () => {
    const r = auditFactualRecord(base({ pages: [page(1, "LOW_CONFIDENCE", 0.42)] }));
    expect(r.result).toBe("NEEDS_HUMAN_REVIEW");
  });
});

describe("integrity failures", () => {
  it("an encounter with no claims FAILS", () => {
    expect(auditFactualRecord(base({ encounters: [encounter({ claims: [] })] })).result).toBe("FAILED");
  });

  it("a claim with no excerpt FAILS", () => {
    expect(auditFactualRecord(base({ encounters: [encounter({ claims: [claim({ excerpt: "" })] })] })).result).toBe("FAILED");
  });

  it("a summary asserting no treatment occurred FAILS", () => {
    const e = encounter({ factualSummary: "No documented treatment occurred during this interval." });
    expect(auditFactualRecord(base({ encounters: [e] })).result).toBe("FAILED");
  });

  it("an undated encounter carrying a date value FAILS", () => {
    const e = encounter({ dateStatus: "UNKNOWN", encounterDate: "2025-03-14" });
    expect(auditFactualRecord(base({ encounters: [e] })).result).toBe("FAILED");
  });
});

describe("source conflicts", () => {
  it("unresolved extraction disagreements are a SOURCE_CONFLICT", () => {
    expect(auditFactualRecord(base({ unresolvedDisputes: 2 })).result).toBe("SOURCE_CONFLICT");
  });

  it("a disputed date is a SOURCE_CONFLICT", () => {
    expect(auditFactualRecord(base({ encounters: [encounter({ dateStatus: "DISPUTED" })] })).result).toBe("SOURCE_CONFLICT");
  });

  it("a claim citing a page outside the document is a SOURCE_CONFLICT", () => {
    const e = encounter({ claims: [claim({ page: 99 })] });
    expect(auditFactualRecord(base({ encounters: [e] })).result).toBe("SOURCE_CONFLICT");
  });

  it("causal or future-care language in a FACTUAL record is a SOURCE_CONFLICT", () => {
    for (const value of [
      "Lumbar radiculopathy caused by the collision",
      "Findings support the need for future injections",
    ]) {
      const e = encounter({ claims: [claim({ value })] });
      expect(auditFactualRecord(base({ encounters: [e] })).result, value).toBe("SOURCE_CONFLICT");
    }
  });
});

describe("synthesis must be traceable sentence by sentence", () => {
  it("an unmapped synthesized sentence FAILS", () => {
    const e = encounter({
      synthesis: "The patient was seen for lumbar radiculopathy. An MRI was ordered.",
      sentenceClaimMap: { "The patient was seen for lumbar radiculopathy.": ["c1"] },
    });
    const r = auditFactualRecord(base({ encounters: [e] }));
    expect(r.result).toBe("FAILED");
    expect(r.findings.join(" ")).toMatch(/no mapped supporting claim/);
  });

  it("a sentence citing an unknown claim id is a SOURCE_CONFLICT", () => {
    const e = encounter({
      synthesis: "The patient was seen for lumbar radiculopathy.",
      sentenceClaimMap: { "The patient was seen for lumbar radiculopathy.": ["not-a-claim"] },
    });
    expect(auditFactualRecord(base({ encounters: [e] })).result).toBe("SOURCE_CONFLICT");
  });

  it("a fully mapped synthesis passes", () => {
    const e = encounter({
      synthesis: "The patient was seen for lumbar radiculopathy.",
      sentenceClaimMap: { "The patient was seen for lumbar radiculopathy.": ["c1"] },
    });
    expect(auditFactualRecord(base({ encounters: [e] })).result).toBe("PASS");
  });

  it("splitSentences handles ordinary clinical prose", () => {
    expect(splitSentences("Seen on exam. MRI ordered. Follow-up in two weeks.")).toHaveLength(3);
  });
});

describe("presentation-level review flags", () => {
  it("duplicate encounters require review", () => {
    const r = auditFactualRecord(base({ encounters: [encounter(), encounter({ id: "e2" })] }));
    expect(r.result).toBe("NEEDS_HUMAN_REVIEW");
    expect(r.findings.join(" ")).toMatch(/duplicate/);
  });

  it("out-of-order dated encounters require review", () => {
    const r = auditFactualRecord(
      base({ encounters: [encounter({ encounterDate: "2025-05-01" }), encounter({ id: "e2", encounterDate: "2025-03-14" })] }),
    );
    expect(r.result).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("zero encounters with pages present is EXTRACTION_INCOMPLETE, not PASS", () => {
    expect(auditFactualRecord(base({ encounters: [] })).result).toBe("EXTRACTION_INCOMPLETE");
  });

  it("zero encounters and zero pages FAILS", () => {
    expect(auditFactualRecord(base({ encounters: [], pages: [] })).result).toBe("FAILED");
  });
});

describe("unprocessed content blocks completeness", () => {
  it("failed sections make the case EXTRACTION_INCOMPLETE", () => {
    const r = auditFactualRecord(base({ failedSections: 2 }));
    expect(r.result).toBe("EXTRACTION_INCOMPLETE");
    expect(r.findings.join(" ")).toMatch(/section\(s\) of the source could not be processed/);
  });

  it("a source clipped at the storage cap is EXTRACTION_INCOMPLETE", () => {
    const r = auditFactualRecord(base({ truncatedSource: true }));
    expect(r.result).toBe("EXTRACTION_INCOMPLETE");
    expect(r.findings.join(" ")).toMatch(/clipped at the storage cap/);
  });
});
