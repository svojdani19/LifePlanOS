// ─────────────────────────────────────────────────────────────────────────────
// A deterministic re-audit may correct a machine grade. It may not touch a
// person's work, and it may not clear a disagreement it simply cannot see.
//
// The second property is here because the first draft of this service failed
// it: unresolved disputes were never persisted per row, so a re-audit read
// zero of them and collapsed 204 source conflicts to 1 — silently clearing
// real contradictions while reporting an improvement.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { planReaudit, AUDIT_VERSION, type ReauditDocument, type ReauditRow } from "@/lib/records/reaudit";

const row = (id: string, over: Partial<ReauditRow> = {}): ReauditRow => ({
  id,
  sourceDocumentId: "doc-1",
  status: "AI_DRAFT",
  auditResult: "SOURCE_CONFLICT",
  // Rows whose dispute state IS persisted; the legacy case is covered
  // explicitly at the bottom of this file.
  auditVersion: AUDIT_VERSION,
  dateStatus: "DOCUMENTED",
  encounterDate: new Date("2025-03-14T00:00:00Z"),
  provider: "A. Rivera, MD",
  encounterType: "Clinic visit",
  // Distinct per row: two entries with the same date, provider AND summary are
  // genuinely apparent duplicates, and the audit is right to say so.
  factualSummary: `Clinic visit ${id} — lumbar radiculopathy.`,
  claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 }],
  page: 1,
  unresolvedDisputes: 0,
  contradictedFields: [],
  ...over,
});

const doc = (rows: ReauditRow[], over: Partial<ReauditDocument> = {}): ReauditDocument => ({
  id: "doc-1",
  firmId: "firm-1",
  caseId: "case-1",
  segments: [{ rowIds: rows.map((r) => r.id) }],
  rows,
  pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
  run: { coverageGaps: 0, failedSections: 0, truncated: false },
  ...over,
});

const clean = { failedExtractions: 0, allDocumentsProcessed: true };

describe("a re-audit corrects machine grades", () => {
  it("regrades a sound row that older rules had marked conflicted", () => {
    const plan = planReaudit([doc([row("a")])], clean);
    expect(plan.results[0].after).toBe("PASS");
    expect(plan.results[0].statusAfter).toBe("AI_AUDIT_PASSED");
  });

  it("stamps the audit version it graded under", () => {
    expect(AUDIT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\./);
  });
});

describe("a re-audit never overrides a person", () => {
  it("leaves HUMAN_EDITED, REVIEWED and VERIFIED statuses exactly as they are", () => {
    const rows = [row("a", { status: "HUMAN_EDITED" }), row("b", { status: "REVIEWED" }), row("c", { status: "VERIFIED" })];
    const plan = planReaudit([doc(rows)], clean);
    expect(plan.results.map((r) => r.statusAfter)).toEqual(["HUMAN_EDITED", "REVIEWED", "VERIFIED"]);
    expect(plan.summary.humanRowsUntouched).toBe(3);
  });

  it("never promotes a machine row past pending review", () => {
    const plan = planReaudit([doc([row("a")])], clean);
    // The best a machine grade can reach is audit-passed; VERIFIED is human.
    expect(plan.results.every((r) => r.statusAfter !== "VERIFIED")).toBe(true);
  });
});

describe("a re-audit never clears a disagreement it can see", () => {
  it("keeps an unresolved dispute blocking its own entry", () => {
    const rows = [row("a", { unresolvedDisputes: 2 }), row("b")];
    const plan = planReaudit([doc(rows)], clean);
    expect(plan.results[0].after).toBe("SOURCE_CONFLICT");
    expect(plan.results[1].after).toBe("PASS"); // and only its own
  });

  it("keeps a confirmed contradiction blocking its own entry", () => {
    const rows = [row("a", { contradictedFields: ["date"] }), row("b")];
    const plan = planReaudit([doc(rows)], clean);
    expect(plan.results[0].after).toBe("SOURCE_CONFLICT");
    expect(plan.results[1].after).toBe("PASS");
    const entryFindings = plan.findings.filter((f) => f.scope === "ENTRY");
    expect(entryFindings).toHaveLength(1);
    expect(entryFindings[0].encounterId).toBe("a");
    expect(entryFindings[0].field).toBe("date");
  });
});

describe("scope of what a re-audit derives", () => {
  it("makes a document's missing encounter a DOCUMENT finding, not an entry defect", () => {
    const plan = planReaudit([doc([row("a"), row("b")], { run: { coverageGaps: 2, failedSections: 0, truncated: false } })], clean);
    const docFindings = plan.findings.filter((f) => f.scope === "DOCUMENT");
    expect(docFindings.some((f) => f.type === "MISSING_ENCOUNTER" && f.blocking)).toBe(true);
    expect(docFindings.every((f) => f.encounterId == null)).toBe(true);
    // Sound entries keep their own grade.
    expect(plan.results.every((r) => r.after === "PASS")).toBe(true);
  });

  it("makes an unreadable page a PAGE finding carrying its page number", () => {
    const d = doc([row("a")], { pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }, { pageNumber: 7, status: "UNREADABLE", ocrConfidence: null }] });
    const plan = planReaudit([d], clean);
    const pageFindings = plan.findings.filter((f) => f.scope === "PAGE");
    expect(pageFindings).toHaveLength(1);
    expect(pageFindings[0].pageStart).toBe(7);
  });

  it("does not let a failed document elsewhere change another document's entries", () => {
    const withFailureElsewhere = planReaudit([doc([row("a")])], { failedExtractions: 1, allDocumentsProcessed: false });
    const withoutIt = planReaudit([doc([row("a")])], clean);
    expect(withFailureElsewhere.results[0].after).toBe(withoutIt.results[0].after);
    // …but the case still carries the blocker.
    expect(withFailureElsewhere.findings.some((f) => f.scope === "CASE" && f.blocking)).toBe(true);
  });

  it("gives identical entries identical results regardless of document order", () => {
    const a = doc([row("a")], { id: "doc-a", segments: [{ rowIds: ["a"] }] });
    const b = doc([row("b", { sourceDocumentId: "doc-b" })], { id: "doc-b", segments: [{ rowIds: ["b"] }] });
    const forward = planReaudit([a, b], clean).results.map((r) => r.after);
    const backward = planReaudit([b, a], clean).results.map((r) => r.after);
    expect([...forward].sort()).toEqual([...backward].sort());
  });

  it("names the canonical note on an entry finding, so note review can show it", () => {
    const rows = [row("a", { contradictedFields: ["provider"] }), row("b")];
    const plan = planReaudit([doc(rows)], clean);
    const entry = plan.findings.find((f) => f.scope === "ENTRY");
    expect(entry?.canonicalNoteId).toBe("doc-1:a,b");
  });
});

describe("legacy rows whose dispute state was never persisted", () => {
  it("keeps a legacy SOURCE_CONFLICT rather than clearing it from absent data", () => {
    // Before dispute state had columns, "no disputes" and "disputes unknown"
    // looked identical. Re-grading such a row to PASS would silently discard a
    // real contradiction and report it as an improvement.
    const legacy = row("a", { auditResult: "SOURCE_CONFLICT", auditVersion: null, unresolvedDisputes: 0 });
    const plan = planReaudit([doc([legacy])], clean);
    expect(plan.results[0].after).toBe("SOURCE_CONFLICT");
  });

  it("does regrade a row whose dispute state IS persisted", () => {
    const known = row("a", { auditResult: "SOURCE_CONFLICT", auditVersion: "2026-08-17.scoped-findings", unresolvedDisputes: 0 });
    const plan = planReaudit([doc([known])], clean);
    expect(plan.results[0].after).toBe("PASS");
  });
})
