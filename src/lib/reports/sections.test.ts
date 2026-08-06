import { describe, it, expect } from "vitest";
import * as S from "./sections";
import { NOT_DOCUMENTED } from "./sections";
import { originLabel } from "./data";
import { getReport } from "./registry";
import { buildFixture, buildFindings } from "./fixtures";
import type { Block } from "./doc";

type TextBlock = Exclude<Block, { kind: "table" }>;
const labeledBlocks = (blocks: Block[]) => blocks.filter((b): b is TextBlock => b.kind === "labeled");
const tables = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
const textOf = (blocks: Block[]) =>
  blocks
    .map((b) => (b.kind === "table" ? [b.caption ?? "", ...b.header, ...b.rows.flat()].join(" ") : `${"label" in b ? b.label ?? "" : ""} ${"text" in b ? b.text ?? "" : ""}`))
    .join("\n");

describe("fixture integrity", () => {
  it("admits exactly the modified item into the totals", () => {
    const data = buildFixture();
    expect([...data.includedIds]).toEqual(["item-1"]);
  });
});

describe("chronology", () => {
  it("filters by event type", () => {
    const data = buildFixture();
    const blocks = S.chronology(data, { types: ["IMAGING"] });
    const rows = labeledBlocks(blocks);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("06/15/2023");
    expect(rows[0].text).toContain("Radiology Associates");
  });

  it("filters by date range", () => {
    const data = buildFixture();
    const rows = labeledBlocks(S.chronology(data, { from: "2023-08-01" }));
    expect(rows.map((r) => r.label)).toEqual(["08/20/2023", "10/05/2023"]);
    const bounded = labeledBlocks(S.chronology(data, { from: "2023-08-01", to: "2023-09-01" }));
    expect(bounded.map((r) => r.label)).toEqual(["08/20/2023"]);
  });

  it("orders ascending by default and descending on request", () => {
    const data = buildFixture();
    expect(labeledBlocks(S.chronology(data))[0].label).toBe("06/15/2023");
    const desc = labeledBlocks(S.chronology(data, { order: "desc" }));
    expect(desc[0].label).toBe("10/05/2023");
    expect(desc[desc.length - 1].label).toBe("06/15/2023");
  });

  it("includes verbatim record excerpts only when configured", () => {
    const data = buildFixture();
    expect(textOf(S.chronology(data, { includeExcerpts: true }))).toContain("Complex tear of the medial meniscus.");
    expect(textOf(S.chronology(data))).not.toContain("Record excerpt");
  });

  it("carries the source document and page on every event", () => {
    const data = buildFixture();
    const text = textOf(S.chronology(data));
    expect(text).toContain("MRI_Right_Knee_2023-06-15.pdf, p. 3");
    expect(text).toContain("Operative_Report_2023-08-20.pdf, p. 12");
  });
});

describe("origin labels", () => {
  it("maps every RecommendationOrigin to its label", () => {
    expect(originLabel({ origin: "TEMPLATE_CONDITION" })).toBe("System generated (care library)");
    expect(originLabel({ origin: "TEMPLATE_BASELINE" })).toBe("System generated (baseline)");
    expect(originLabel({ origin: "TEMPLATE_SPECIALTY" })).toBe("System generated (specialty pack)");
    expect(originLabel({ origin: "PHYSICIAN_ADDED" })).toBe("Physician reviewer");
    expect(originLabel({ origin: "GOLD_IMPORT" })).toBe("Imported source");
    expect(originLabel({ origin: null })).toBe("Unknown");
    expect(originLabel({ origin: "SOMETHING_ELSE" })).toBe("Unknown");
  });

  it("futureCare renders each item's origin label from its stored origin", () => {
    const data = buildFixture();
    const text = textOf(S.futureCare(data));
    expect(text).toContain("System generated (care library)");
    expect(text).toContain("Imported source");
    expect(text).toContain("Physician reviewer");
  });
});

describe("citations & evidence", () => {
  it("citations carry filename and page and are deduplicated", () => {
    const data = buildFixture();
    const blocks = S.citations(data);
    const texts = blocks.map((b) => ("text" in b ? b.text ?? "" : ""));
    expect(texts.some((t) => t.includes("MRI_Right_Knee_2023-06-15.pdf, p. 3"))).toBe(true);
    expect(texts.some((t) => t.includes("PCP_Notes_2023.pdf, p. 7"))).toBe(true);
    expect(texts.some((t) => t.includes("PMID 12345678"))).toBe(true);
    expect(new Set(texts).size).toBe(texts.length); // no duplicates
  });

  it("evidence quotes the record with filename and page per condition", () => {
    const data = buildFixture();
    const text = textOf(S.evidence(data));
    expect(text).toContain("Operative_Report_2023-08-20.pdf, p. 12");
    expect(text).toContain("Outerbridge grade III-IV chondromalacia");
  });

  it("diagnoses carry ICD codes and evidence citations", () => {
    const data = buildFixture();
    const text = textOf(S.diagnoses(data));
    expect(text).toContain("ICD-10 M17.31");
    expect(text).toContain("ICD-10 M54.50");
    expect(text).toContain("MRI_Right_Knee_2023-06-15.pdf, p. 3");
  });
});

describe("honest empty buckets", () => {
  it("imaging with no imaging evidence says not documented — never invents", () => {
    const data = buildFixture();
    data.case.chronologyEvents = [];
    data.case.conditions = [];
    const blocks = S.imaging(data);
    expect(blocks).toEqual([{ kind: "p", text: NOT_DOCUMENTED, italics: true }]);
  });

  it("contradictory and missing evidence with no assessments say not documented", () => {
    const data = buildFixture();
    data.assessments = [];
    expect(textOf(S.contradictoryEvidence(data))).toContain(NOT_DOCUMENTED);
    expect(textOf(S.missingEvidence(data))).toContain(NOT_DOCUMENTED);
    expect(textOf(S.literature(data))).toContain(NOT_DOCUMENTED);
  });

  it("procedures and provider recommendations degrade honestly when empty", () => {
    const data = buildFixture();
    data.case.chronologyEvents = [];
    data.case.interviewFindings = [];
    data.case.treatingProviders = [];
    expect(textOf(S.procedures(data))).toContain(NOT_DOCUMENTED);
    expect(textOf(S.providerRecommendations(data))).toContain(NOT_DOCUMENTED);
  });
});

describe("costProjection", () => {
  it("totals only included items; conditional items sit in a separate labeled table", () => {
    const data = buildFixture();
    const blocks = S.costProjection(data);
    const [main, conditional] = tables(blocks);
    // Main table: item-1 only, plus the totals row.
    expect(main.rows).toHaveLength(2);
    expect(main.rows[0][0]).toBe("Orthopedic surgeon follow-up visits");
    const totals = main.rows[main.rows.length - 1];
    expect(totals[0]).toBe("TOTAL");
    expect(totals[5]).toBe("$9,900"); // lifetime — item-1 only
    expect(totals[6]).toBe("$7,200"); // present value — item-1 only
    // Excluded/conditional items are never merged into the main table.
    expect(main.rows.flat().join(" ")).not.toContain("Revision total knee arthroplasty");
    expect(conditional).toBeDefined();
    expect(conditional.caption).toMatch(/NOT included in the totals/);
    const condText = conditional.rows.flat().join(" ");
    expect(condText).toContain("Revision total knee arthroplasty");
    expect(condText).toContain("Aquatic therapy program");
  });

  it("omits the conditional table when includeConditional is false", () => {
    const data = buildFixture();
    const blocks = S.costProjection(data, { includeConditional: false });
    expect(tables(blocks)).toHaveLength(1);
  });
});

describe("physicianReview", () => {
  it("renders the transition ledger with reason codes and structured before→after changes", () => {
    const data = buildFixture();
    const [ledger] = tables(S.physicianReview(data));
    const flat = ledger.rows.map((r) => r.join(" | "));
    const modified = flat.find((r) => r.includes("PHYSICIAN_MODIFIED"));
    expect(modified).toBeDefined();
    expect(modified).toContain("SENT_FOR_PHYSICIAN_REVIEW → PHYSICIAN_MODIFIED");
    expect(modified).toContain("FREQUENCY_EXCESSIVE");
    expect(modified).toContain("frequencyPerYear: 4 → 2");
    const rejected = flat.find((r) => r.includes("PHYSICIAN_REJECTED"));
    expect(rejected).toContain("NOT_MEDICALLY_NECESSARY");
  });

  it("renders the attestation with signer, statement, and content hash", () => {
    const data = buildFixture();
    const text = textOf(S.physicianReview(data));
    expect(text).toContain("I have reviewed each recommendation");
    expect(text).toContain("Dr. Elena Park");
    expect(text).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("medicalNecessity provenance labels", () => {
  it("distinguishes system-generated analysis, physician reviewer, and treating provider", () => {
    const data = buildFixture();
    const blocks = labeledBlocks(S.medicalNecessity(data));
    const byLabel = (l: string) => blocks.find((b) => b.label === l);
    const system = byLabel("System-generated analysis");
    expect(system?.text).toContain("Ongoing orthopedic surveillance");
    const physician = byLabel("Physician reviewer");
    expect(physician?.text).toContain("semiannual frequency is sufficient");
    const provider = byLabel("Treating provider");
    expect(provider?.text).toContain("Dr. Elena Park");
    expect(provider?.text).toContain("weight-bearing radiographs");
  });

  it("covers only included items and carries sufficiency, weaknesses, and unknowns", () => {
    const data = buildFixture();
    const blocks = S.medicalNecessity(data);
    const text = textOf(blocks);
    expect(text).toContain("Sufficient (score 78)");
    expect(text).toContain("improved pain control");
    expect(text).toContain("radiographic staging is more than 12 months old");
    // item-2 (rejected) and item-3 (contingency) are not in the necessity report.
    expect(blocks.filter((b) => b.kind === "h2")).toHaveLength(1);
  });
});

describe("providerRecommendations", () => {
  it("carries provider, specialty, date, source, and the linked item's review status", () => {
    const data = buildFixture();
    const text = textOf(S.providerRecommendations(data));
    expect(text).toContain("Dr. Elena Park, MD");
    expect(text).toContain("Orthopedic Surgery");
    expect(text).toContain("May 1, 2024");
    expect(text).toContain("Plan status: Physician approved with modification");
    const sources = S.providerRecommendations(data).filter((b) => b.kind === "source");
    expect(sources.some((s) => "text" in s && /treating-provider interview/.test(s.text ?? ""))).toBe(true);
  });

  it("falls back to Pending when no plan item is linked", () => {
    const data = buildFixture();
    data.case.interviewFindings = data.case.interviewFindings.map((f) => ({ ...f, futureCareItemId: null }));
    const text = textOf(S.providerRecommendations(data));
    expect(text).toContain("Plan status: Pending");
  });
});

describe("functionalLimitations", () => {
  it("draws from the record text and the patient interview, with quotes attributed", () => {
    const data = buildFixture();
    const text = textOf(S.functionalLimitations(data));
    expect(text).toContain("Stairs");
    expect(text).toContain("Stairs are the worst part of my day.");
    expect(text).toContain("Patient interview (05/01/2024)");
  });
});

describe("unresolvedIssues", () => {
  it("marks export-blocking findings explicitly", () => {
    const blocks = S.unresolvedIssues(buildFindings());
    const [table] = tables(blocks);
    const blockingRow = table.rows.find((r) => r[0] === "Revision total knee arthroplasty");
    expect(blockingRow?.[4]).toBe("Yes — blocks final export");
    const advisoryRow = table.rows.find((r) => r[0] === "Aquatic therapy program");
    expect(advisoryRow?.[4]).toBe("No");
    expect(textOf(blocks)).toContain("1 blocks final export");
  });

  it("states plainly when no findings are recorded", () => {
    expect(textOf(S.unresolvedIssues([]))).toContain("No unresolved validation issues");
  });
});

describe("CUSTOM composition", () => {
  it("includes exactly the selected sections, in the selected order", () => {
    const custom = getReport("CUSTOM")!;
    const doc = custom.compose(buildFixture(), { sections: ["diagnoses", "caseHeader"] }, []);
    const h1s = doc.blocks.filter((b) => b.kind === "h1").map((b) => (b.kind === "h1" ? b.text : ""));
    expect(h1s).toEqual(["Diagnoses", "Case Summary"]);
  });

  it("honors an explicit order array over the selection order", () => {
    const custom = getReport("CUSTOM")!;
    const doc = custom.compose(
      buildFixture(),
      { sections: ["caseHeader", "citations", "diagnoses"], order: ["citations", "diagnoses", "caseHeader"] },
      [],
    );
    const h1s = doc.blocks.filter((b) => b.kind === "h1").map((b) => (b.kind === "h1" ? b.text : ""));
    expect(h1s).toEqual(["Citations", "Diagnoses", "Case Summary"]);
  });
});

describe("executiveSummary", () => {
  it("reports counts and totals drawn only from structured data", () => {
    const data = buildFixture();
    const text = textOf(S.executiveSummary(data));
    expect(text).toContain("3 record sets");
    expect(text).toContain("3 chronology encounters");
    expect(text).toContain("$9,900");
    expect(text).toContain("$7,200");
    expect(text).toContain("1 approved with modification");
    expect(text).toContain("1 rejected");
    expect(text).toContain("1 pending review");
  });
});

// ── Factual record reporting (source-grounded pipeline) ──────────────────────

describe("chronology report — factual summary first, relevance labeled and last", () => {
  it("the detail entries lead with the factual event summary, and relevance is a labeled suggestion", () => {
    const data = buildFixture();
    const blocks = S.chronology(data);
    const rows = labeledBlocks(blocks);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const rowText = row.text ?? "";
      const ev = data.case.chronologyEvents.find((e) => rowText.includes(e.summary));
      expect(ev, `entry should contain its event's factual summary: ${rowText.slice(0, 80)}`).toBeTruthy();
      if (ev?.clinicalSignificance) {
        const sumIdx = rowText.indexOf(ev.summary);
        const relIdx = rowText.indexOf("System-suggested relevance — pending human confirmation");
        expect(relIdx).toBeGreaterThan(sumIdx); // factual summary FIRST
      }
    }
  });

  it("the chronology table's content column is the factual encounter summary, not the diagnosis", () => {
    const data = buildFixture();
    const table = tables(S.chronology(data))[0];
    expect(table.header).toContain("Factual encounter summary");
    expect(table.header).not.toContain("Finding");
    const i = table.header.indexOf("Factual encounter summary");
    for (const [rowIdx, row] of table.rows.entries()) {
      expect(row[i]).toBe(data.case.chronologyEvents.map((e) => e.summary)[rowIdx] ?? row[i]);
    }
  });

  it("every entry carries a human-review status label", () => {
    const data = buildFixture();
    const text = textOf(S.chronology(data));
    expect(text).toMatch(/Review status: (AI-generated draft — pending human review|Human-(verified|reviewed|edited))/);
  });
});

describe("Medical Record Summary — factual content only", () => {
  it("excludes future-care dollar totals and physician-review counts", () => {
    const data = buildFixture();
    const def = getReport("MEDICAL_RECORD_SUMMARY")!;
    const doc = def.compose(data, { detail: "detailed" }, buildFindings(), {});
    const text = textOf(doc.blocks);
    expect(text).not.toMatch(/\$\s?[\d,]+/); // no dollar totals
    expect(text).not.toMatch(/present value|lifetime cost/i);
    expect(text).not.toMatch(/physician[- ](approved|review(ed)? count|status)/i);
  });

  it("contains the required factual sections", () => {
    const data = buildFixture();
    const def = getReport("MEDICAL_RECORD_SUMMARY")!;
    const doc = def.compose(data, { detail: "detailed" }, buildFindings(), {});
    const headers = doc.blocks.filter((b) => b.kind === "h1").map((b) => ("text" in b ? b.text : ""));
    for (const h of [
      "Medical Records Reviewed",
      "Processing and OCR Limitations",
      "Treating Providers' Diagnoses",
      "Treatment and Encounters",
      "Diagnostic Studies",
      "Medication History",
      "Contradictory or Adverse Evidence",
      "Undated or Incompletely Processed Material",
    ]) {
      expect(headers).toContain(h);
    }
  });
});
