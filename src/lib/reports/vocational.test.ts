import { describe, it, expect } from "vitest";
import {
  vocationalReadiness,
  composeVocational,
  detailText,
  VOCATIONAL_DISCLOSURE,
  SUPPORT_PACKAGE_NOTICE,
  VOC_KINDS,
  type VocEntry,
} from "./vocational";
import type { Block } from "./doc";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const entry = (kind: string, over: Partial<VocEntry> = {}): VocEntry => ({
  kind,
  title: over.title ?? `${kind} entry`,
  detail: over.detail ?? {},
  startDate: over.startDate ?? null,
  endDate: over.endDate ?? null,
  source: over.source ?? `${kind}-source.pdf p. 1`,
  verification: over.verification ?? "UNVERIFIED",
  notes: over.notes ?? null,
});

const intake = (): VocEntry[] => [
  entry("employment", { title: "Warehouse supervisor", startDate: "2015-03-01", endDate: "2023-06-30", source: "Employment_Records.pdf p. 4" }),
  entry("restriction", { title: "No lifting over 10 lbs", source: "Dr. Reyes clinic note 04/12/2024, Ortho_Clinic.pdf p. 7" }),
  entry("functional_capacity", { title: "Sedentary work capacity", source: "FCE_Report_2024.pdf p. 2" }),
];

const unverifiedConclusion = () =>
  entry("conclusion", { title: "Loss of access to medium-duty labor market", source: "J. Smith, MS CRC — expert analysis 05/2026" });
const verifiedConclusion = () =>
  entry("conclusion", { title: "Loss of access to medium-duty labor market", source: "J. Smith, MS CRC — expert analysis 05/2026", verification: "VERIFIED" });

const h1s = (blocks: Block[]) => blocks.filter((b) => b.kind === "h1").map((b) => ("text" in b ? b.text : ""));
const textOf = (blocks: Block[]) =>
  blocks
    .map((b) => (b.kind === "table" ? [b.caption ?? "", ...b.header, ...b.rows.flat()].join(" ") : `${"label" in b ? b.label ?? "" : ""} ${"text" in b ? b.text ?? "" : ""}`))
    .join("\n");

// ── Readiness transitions ────────────────────────────────────────────────────

describe("vocationalReadiness", () => {
  it("empty intake → Intake incomplete, naming every missing kind", () => {
    const r = vocationalReadiness([], { approved: false });
    expect(r.status).toBe("Intake incomplete");
    expect(r.missing.join("\n")).toContain("Employment history");
    expect(r.missing.join("\n")).toContain("Work restrictions");
    expect(r.missing.join("\n")).toContain("Functional capacity");
    expect(r.missing.join("\n")).toContain("Vocational expert conclusion");
    expect(r.missing.join("\n")).toContain("Vocational expert report approval");
  });

  it("employment present but clinical inputs missing → Expert input required", () => {
    const r = vocationalReadiness([entry("employment")], { approved: false });
    expect(r.status).toBe("Expert input required");
    expect(r.missing.join("\n")).not.toContain("Employment history");
    expect(r.missing.join("\n")).toContain("Work restrictions");
    expect(r.missing.join("\n")).toContain("Functional capacity");
  });

  it("employment + restriction + functional capacity → Draft support package available", () => {
    const r = vocationalReadiness(intake(), { approved: false });
    expect(r.status).toBe("Draft support package available");
    expect(r.missing.join("\n")).toContain("Vocational expert conclusion");
    expect(r.missing.join("\n")).toContain("Vocational expert report approval");
  });

  it("adding an UNVERIFIED conclusion → Expert review required", () => {
    const r = vocationalReadiness([...intake(), unverifiedConclusion()], { approved: false });
    expect(r.status).toBe("Expert review required");
    expect(r.missing.join("\n")).toContain("marked VERIFIED");
  });

  it("verified conclusion without report approval → still Expert review required", () => {
    const r = vocationalReadiness([...intake(), verifiedConclusion()], { approved: false });
    expect(r.status).toBe("Expert review required");
    expect(r.missing).toEqual(["Vocational expert report approval"]);
  });

  it("verified conclusion + expert approval → Ready for final export, nothing missing", () => {
    const r = vocationalReadiness([...intake(), verifiedConclusion()], { approved: true });
    expect(r.status).toBe("Ready for final export");
    expect(r.missing).toEqual([]);
  });
});

// ── Composition ──────────────────────────────────────────────────────────────

describe("composeVocational", () => {
  const CASE = "Jane Roe · File LCP-2026-0001";

  it("orders the sections exactly as specified", () => {
    const doc = composeVocational(CASE, intake(), { draft: true, expertApproved: false });
    expect(h1s(doc.blocks)).toEqual([
      "Demographics & Work History",
      "Earnings History",
      "Occupational Demands & Transferable Skills",
      "Work Restrictions",
      "Functional Capacities",
      "Return-to-Work History",
      "Vocational Testing",
      "Labor-Market Research",
      "Vocational Expert Findings",
      "Missing Information",
      "Source Records",
    ]);
    expect(doc.reportId).toBe("VOCATIONAL_ASSESSMENT");
    expect(doc.title).toBe("Vocational Assessment");
    expect(doc.disclosures).toContain(VOCATIONAL_DISCLOSURE);
  });

  it("builds the work-history timeline chronologically from employment/education/certification/military", () => {
    const entries = [
      entry("certification", { title: "Forklift certification", startDate: "2018-01-15", source: "Cert_Records.pdf p. 1" }),
      entry("employment", { title: "Warehouse supervisor", startDate: "2015-03-01", source: "Employment_Records.pdf p. 4" }),
      entry("education", { title: "High school diploma", startDate: "2008-06-01", source: "School_Records.pdf p. 2" }),
      entry("military", { title: "US Army logistics specialist", startDate: "2010-09-01", source: "DD-214.pdf" }),
    ];
    const doc = composeVocational(CASE, entries, { draft: true, expertApproved: false });
    const table = doc.blocks.find((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
    expect(table).toBeDefined();
    expect(table!.rows.map((r) => r[2])).toEqual([
      "High school diploma",
      "US Army logistics specialist",
      "Warehouse supervisor",
      "Forklift certification",
    ]);
    // Every timeline row carries its source.
    expect(table!.rows.map((r) => r[4])).toContain("DD-214.pdf");
  });

  it("attributes each work restriction to its clinical source", () => {
    const doc = composeVocational(CASE, intake(), { draft: true, expertApproved: false });
    const text = textOf(doc.blocks);
    expect(text).toContain("No lifting over 10 lbs");
    expect(text).toContain("Clinical source: Dr. Reyes clinic note 04/12/2024, Ortho_Clinic.pdf p. 7.");
  });

  it("attributes expert conclusions to the vocational expert's source", () => {
    const doc = composeVocational(CASE, [...intake(), verifiedConclusion()], { draft: false, expertApproved: true });
    const text = textOf(doc.blocks);
    expect(text).toContain("Vocational expert conclusion — J. Smith, MS CRC — expert analysis 05/2026.");
    expect(text).not.toContain(SUPPORT_PACKAGE_NOTICE);
  });

  it("without conclusions: states the support-package sentence and is draft regardless of opts", () => {
    const doc = composeVocational(CASE, intake(), { draft: false, expertApproved: true });
    expect(textOf(doc.blocks)).toContain(SUPPORT_PACKAGE_NOTICE);
    expect(doc.draft).toBe(true); // never a final without a verified expert conclusion
  });

  it("is a draft when the expert has not approved, even with a verified conclusion", () => {
    const doc = composeVocational(CASE, [...intake(), verifiedConclusion()], { draft: false, expertApproved: false });
    expect(doc.draft).toBe(true);
  });

  it("is final only with verified conclusion + expert approval + final mode", () => {
    const doc = composeVocational(CASE, [...intake(), verifiedConclusion()], { draft: false, expertApproved: true });
    expect(doc.draft).toBe(false);
    const asDraft = composeVocational(CASE, [...intake(), verifiedConclusion()], { draft: true, expertApproved: true });
    expect(asDraft.draft).toBe(true);
  });

  it("flags an UNVERIFIED conclusion inline in the Expert Findings section", () => {
    const doc = composeVocational(CASE, [...intake(), unverifiedConclusion()], { draft: true, expertApproved: false });
    expect(textOf(doc.blocks)).toContain("This conclusion has not been verified by the vocational expert.");
    expect(doc.draft).toBe(true);
  });

  it("Missing Information lists readiness gaps and every unverified entry", () => {
    const entries = [...intake(), unverifiedConclusion()];
    const doc = composeVocational(CASE, entries, { draft: true, expertApproved: false });
    const text = textOf(doc.blocks);
    expect(text).toContain("Vocational expert report approval");
    // All four entries are UNVERIFIED and must be listed with their sources.
    expect(text).toContain("Unverified entry: Warehouse supervisor (Employment)");
    expect(text).toContain("Unverified entry: No lifting over 10 lbs (Work restriction)");
    expect(text).toContain("Unverified entry: Sedentary work capacity (Functional capacity)");
    expect(text).toContain("Unverified entry: Loss of access to medium-duty labor market (Vocational expert conclusion)");
  });

  it("renders honest empties for absent kinds and invents no facts", () => {
    const doc = composeVocational(CASE, [], { draft: true, expertApproved: false });
    const text = textOf(doc.blocks);
    expect(text).toContain("No work, education, certification, or military history entries have been recorded.");
    expect(text).toContain("No earnings entries have been recorded.");
    expect(text).toContain("No vocational test result entries have been recorded.");
    expect(text).toContain("No labor-market research or scenario entries have been recorded.");
    expect(text).toContain("No source records have been cited.");
    // No fabricated names, employers, dollar figures, or dates.
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("every entered fact appears in the document with its source", () => {
    const entries = VOC_KINDS.map((k, i) => entry(k, { title: `Fact ${i}-${k}`, source: `Record_${i}.pdf p. ${i + 1}` }));
    const doc = composeVocational(CASE, entries, { draft: true, expertApproved: false });
    const text = textOf(doc.blocks);
    for (const e of entries) {
      expect(text).toContain(e.title);
      expect(text).toContain(e.source);
    }
  });

  it("deduplicates the Source Records list", () => {
    const entries = [
      entry("employment", { source: "Employment_Records.pdf p. 4" }),
      entry("earnings", { source: "Employment_Records.pdf p. 4" }),
      entry("restriction", { source: "Ortho_Clinic.pdf p. 7" }),
    ];
    const doc = composeVocational(CASE, entries, { draft: true, expertApproved: false });
    const idx = doc.blocks.findIndex((b) => b.kind === "h1" && "text" in b && b.text === "Source Records");
    const sources = doc.blocks.slice(idx + 1).filter((b) => b.kind === "source").map((b) => ("text" in b ? b.text : ""));
    expect(sources).toEqual(["Employment_Records.pdf p. 4", "Ortho_Clinic.pdf p. 7"]);
  });
});

// ── detailText helper ────────────────────────────────────────────────────────

describe("detailText", () => {
  it("flattens scalar detail fields and skips empties/nesting", () => {
    expect(detailText({ employer: "ACME", hourly_wage: 28.5, union: true, empty: "", nested: { a: 1 } })).toBe(
      "Employer: ACME; Hourly wage: 28.5; Union: true",
    );
    expect(detailText(null)).toBe("");
    expect(detailText("string")).toBe("");
  });
});
