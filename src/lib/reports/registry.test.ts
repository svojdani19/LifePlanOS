import { describe, it, expect } from "vitest";
import { REPORTS, getReport, gateReport, customApproval, SECTION_MENU, FINDING_RELEVANCE, findingRelevance, type GateContext } from "./registry";
import { buildFixture, buildFindings } from "./fixtures";

const ALL_IDS = [
  "LIFE_CARE_PLAN",
  "TESTIMONY_PACK",
  "MEDICAL_CHRONOLOGY",
  "MEDICAL_RECORD_SUMMARY",
  "MEDICAL_COST_PROJECTION",
  "VOCATIONAL_ASSESSMENT",
  "FORENSIC_ECONOMIST_REPORT",
  "MEDICAL_NECESSITY",
  "PROVIDER_MATRIX",
  "FUTURE_CARE_SUMMARY",
  "DEFENSE_REBUTTAL",
  "CAUSATION_ANALYSIS",
  "PHYSICIAN_REVIEW_REPORT",
  "DAMAGES_SUMMARY",
  "CUSTOM",
];

describe("report registry", () => {
  it("registers all 15 report definitions and resolves each by id", () => {
    expect(REPORTS).toHaveLength(15);
    for (const id of ALL_IDS) {
      const def = getReport(id);
      expect(def, id).toBeDefined();
      expect(def!.id).toBe(id);
    }
    // Legacy stored id resolves to the renamed definition (rows never rewritten).
    expect(getReport("COST_PROJECTION")!.id).toBe("MEDICAL_COST_PROJECTION");
    expect(getReport("NOT_A_REPORT")).toBeUndefined();
  });

  it("declares only valid formats and the report.export permission", () => {
    const valid = new Set(["DOCX", "PDF", "CSV", "HTML"]);
    for (const def of REPORTS) {
      // Expert-workflow placeholders (P4/P5) declare no generatable formats yet.
      if (!def.requiredExpert) expect(def.formats.length, def.id).toBeGreaterThan(0);
      for (const f of def.formats) expect(valid.has(f), `${def.id}: ${f}`).toBe(true);
      expect(def.permission).toBe("report.export");
    }
  });

  it("marks exactly the two legacy reports and their compose throws", () => {
    const legacy = REPORTS.filter((r) => r.legacy);
    expect(legacy.map((r) => r.id).sort()).toEqual(["LIFE_CARE_PLAN", "TESTIMONY_PACK"]);
    const data = buildFixture();
    for (const def of legacy) {
      expect(() => def.compose(data, {}, [])).toThrow(/legacy pipeline/);
    }
  });

  it("declares the approval / gate matrix from the plan", () => {
    expect(getReport("MEDICAL_CHRONOLOGY")!.approval).toBe("none");
    expect(getReport("MEDICAL_CHRONOLOGY")!.gate).toBe("disclose");
    expect(getReport("COST_PROJECTION")!.approval).toBe("standard");
    expect(getReport("COST_PROJECTION")!.gate).toBe("standard");
    expect(getReport("MEDICAL_NECESSITY")!.approval).toBe("physician_required");
    expect(getReport("CAUSATION_ANALYSIS")!.approval).toBe("physician_required");
    expect(getReport("DEFENSE_REBUTTAL")!.approval).toBe("physician_required");
    expect(getReport("PHYSICIAN_REVIEW_REPORT")!.requiresDecided).toBe(true);
    expect(getReport("LIFE_CARE_PLAN")!.approval).toBe("standard");
  });

  it("every configSchema parses its default config and rejects garbage", () => {
    for (const def of REPORTS) {
      expect(() => def.configSchema.parse(def.defaultConfig), `${def.id} default`).not.toThrow();
      expect(def.configSchema.safeParse({ bogusKey: true }).success, `${def.id} bogus key`).toBe(false);
      expect(def.configSchema.safeParse("garbage").success, `${def.id} non-object`).toBe(false);
      expect(def.configSchema.safeParse(42).success, `${def.id} number`).toBe(false);
    }
  });

  it("derives CUSTOM approval from the selected sections", () => {
    expect(customApproval(["medicalNecessity", "caseHeader"])).toBe("physician_required");
    expect(customApproval(["costProjection"])).toBe("standard");
    expect(customApproval(["futureCare", "diagnoses"])).toBe("standard");
    expect(customApproval(["caseHeader", "chronology"])).toBe("none");
    const custom = getReport("CUSTOM")!;
    expect(custom.deriveApproval!({ sections: ["medicalNecessity"] })).toBe("physician_required");
    expect(custom.deriveApproval!({ sections: ["caseHeader"] })).toBe("none");
    // Unparseable config fails closed to the strictest approval.
    expect(custom.deriveApproval!({ nonsense: true })).toBe("physician_required");
  });

  it("SECTION_MENU covers every section key CUSTOM accepts", () => {
    for (const key of ["caseHeader", "chronology", "medicalNecessity", "costProjection", "citations"]) {
      expect(SECTION_MENU[key]).toBeDefined();
    }
    expect(getReport("CUSTOM")!.configSchema.safeParse({ sections: ["notASection"] }).success).toBe(false);
  });
});

describe("gateReport matrix", () => {
  const ctx = (over: Partial<GateContext>): GateContext => ({
    mode: "final",
    blocking: false,
    decidedCount: 2,
    includedUndecided: 0,
    ...over,
  });

  it("standard gate: draft is always allowed, even with blocking findings", () => {
    const def = getReport("COST_PROJECTION")!;
    expect(gateReport(def, ctx({ mode: "draft", blocking: true })).ok).toBe(true);
  });

  it("standard gate: final with blocking findings is refused", () => {
    const def = getReport("COST_PROJECTION")!;
    const res = gateReport(def, ctx({ blocking: true }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/blocked/i);
  });

  it("standard gate: final with no blocking findings is allowed", () => {
    expect(gateReport(getReport("COST_PROJECTION")!, ctx({})).ok).toBe(true);
    expect(gateReport(getReport("DAMAGES_SUMMARY")!, ctx({})).ok).toBe(true);
  });

  it("physician_required: final with undecided included items is refused even without blocking findings", () => {
    const def = getReport("MEDICAL_NECESSITY")!;
    const res = gateReport(def, ctx({ includedUndecided: 1 }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/physician/i);
  });

  it("physician_required: final with blocking findings is refused even when all items are decided", () => {
    const def = getReport("DEFENSE_REBUTTAL")!;
    expect(gateReport(def, ctx({ blocking: true })).ok).toBe(false);
  });

  it("physician_required: final passes only when decided and unblocked; draft is allowed with the banner", () => {
    const def = getReport("CAUSATION_ANALYSIS")!;
    expect(gateReport(def, ctx({})).ok).toBe(true);
    expect(gateReport(def, ctx({ mode: "draft", includedUndecided: 3, blocking: true })).ok).toBe(true);
  });

  it("PHYSICIAN_REVIEW_REPORT requires at least one decided recommendation in any mode", () => {
    const def = getReport("PHYSICIAN_REVIEW_REPORT")!;
    expect(gateReport(def, ctx({ decidedCount: 0 })).ok).toBe(false);
    expect(gateReport(def, ctx({ mode: "draft", decidedCount: 0 })).ok).toBe(false);
    expect(gateReport(def, ctx({ decidedCount: 1 })).ok).toBe(true);
  });

  it("disclose gate: final export is allowed despite blocking findings", () => {
    const def = getReport("MEDICAL_CHRONOLOGY")!;
    expect(gateReport(def, ctx({ blocking: true })).ok).toBe(true);
    expect(gateReport(getReport("PROVIDER_MATRIX")!, ctx({ blocking: true })).ok).toBe(true);
  });

  it("disclose gate: compose still surfaces the blocking findings on the face of the document", () => {
    const def = getReport("MEDICAL_CHRONOLOGY")!;
    const doc = def.compose(buildFixture(), {}, buildFindings());
    const h1s = doc.blocks.filter((b) => b.kind === "h1").map((b) => (b.kind === "h1" ? b.text : ""));
    expect(h1s).toContain("Unresolved Issues");
    const tables = doc.blocks.filter((b) => b.kind === "table");
    const issueTable = tables.find((t) => t.kind === "table" && t.header.includes("Blocks final export"));
    expect(issueTable).toBeDefined();
  });

  it("compose omits the unresolved-issues section when no finding is blocking", () => {
    const def = getReport("MEDICAL_CHRONOLOGY")!;
    const nonBlocking = buildFindings().filter((f) => !f.exportBlocking);
    const doc = def.compose(buildFixture(), {}, nonBlocking);
    const h1s = doc.blocks.filter((b) => b.kind === "h1").map((b) => (b.kind === "h1" ? b.text : ""));
    expect(h1s).not.toContain("Unresolved Issues");
  });

  it("physician_required drafts carry the analyst-worksheet disclosure", () => {
    const def = getReport("DEFENSE_REBUTTAL")!;
    const draft = def.compose(buildFixture(), {}, [], { draft: true });
    expect(draft.draft).toBe(true);
    expect(draft.disclosures.some((d) => /ANALYST WORKSHEET/.test(d))).toBe(true);
    const final = def.compose(buildFixture(), {}, [], { draft: false });
    expect(final.disclosures.some((d) => /ANALYST WORKSHEET/.test(d))).toBe(false);
  });

  it("non-legacy composes produce a well-formed ReportDoc for the fixture", () => {
    const data = buildFixture();
    for (const def of REPORTS.filter((r) => !r.legacy && !r.requiredExpert)) {
      const doc = def.compose(data, def.defaultConfig, [], { draft: false });
      expect(doc.reportId).toBe(def.id);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.caseLabel).toContain("James Holloway");
      expect(doc.blocks.length).toBeGreaterThan(0);
      expect(doc.disclosures.length).toBeGreaterThan(0);
    }
  });

  it("expert-workflow placeholders refuse to compose until their workflow ships", () => {
    const data = buildFixture();
    for (const def of REPORTS.filter((r) => r.requiredExpert)) {
      expect(() => def.compose(data, def.defaultConfig, [], { draft: false })).toThrow(/expert workflow/);
    }
  });
});

describe("finding relevance map", () => {
  it("covers every registered report with a compilable regex", () => {
    for (const def of REPORTS) {
      const src = findingRelevance(def.id);
      expect(typeof src).toBe("string");
      expect(() => new RegExp(src, "i")).not.toThrow();
      expect(FINDING_RELEVANCE[def.id]).toBeDefined();
    }
  });

  it("scopes cost findings to cost reports and citation drift to chronology", () => {
    const cost = new RegExp(findingRelevance("COST_PROJECTION"), "i");
    expect(cost.test("Pricing mismatch — unit cost differs")).toBe(true);
    expect(cost.test("Narrative coherence issue")).toBe(false);
    const chrono = new RegExp(findingRelevance("MEDICAL_CHRONOLOGY"), "i");
    expect(chrono.test("Evidence citation drift")).toBe(true);
    expect(chrono.test("Pricing mismatch")).toBe(false);
  });

  it("full-scope reports use match-all", () => {
    expect(findingRelevance("LIFE_CARE_PLAN")).toBe(".*");
    expect(findingRelevance("UNKNOWN_ID")).toBe(".*");
  });
});
