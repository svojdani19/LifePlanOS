// Gold-standard evaluation. The pipeline's DETERMINISTIC layers are exercised
// against synthetic records with known ground truth, using a fake adapter that
// plays the part of a model — including a model that behaves badly, because
// the guarantees must hold when it does.
//
// The measures that matter here are the refusals: prohibited statements that
// must never survive validation regardless of what the model proposes.
import { describe, it, expect } from "vitest";
import { GOLD_CASES, GOLD_CORPUS_IS_SYNTHETIC, type GoldCase } from "./__fixtures__/goldCorpus";
import { chunkDocumentText, validateEncounters, consolidateEncounters, type DocumentChunk, type LlmEncounter } from "./recordExtraction";
import { auditFactualRecord } from "./factualAudit";

const META = { firmId: "firm-gold", caseId: "case-gold", sourceDocumentId: "doc-gold", filename: "gold.pdf", ocrConfidence: 0.98 };

/** Build a chunk with real page markers so page attribution is exercised. */
function chunkFor(g: GoldCase): DocumentChunk {
  const text = g.pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n");
  const marks = g.pages.map((_, i) => ({ offset: text.indexOf(`--- Page ${i + 1} ---`), page: i + 1 }));
  const { chunks } = chunkDocumentText(text, marks, META);
  return chunks[0];
}

/**
 * A hostile-but-plausible model: it proposes every expected claim AND every
 * prohibited statement, each with a citation it invents from the page it seems
 * most related to. Validation must keep the first set and destroy the second.
 */
function proposeEncounters(g: GoldCase, chunk: DocumentChunk): LlmEncounter[] {
  const pageText = (n: number) => chunk.pageSlices.find((p) => p.page === n)?.text ?? "";
  const encounters: LlmEncounter[] = [];

  for (const [idx, date] of g.expectedEncounterDates.entries()) {
    const claims = g.expectedClaims
      .filter((_, i) => i % Math.max(1, g.expectedEncounterDates.length) === idx % Math.max(1, g.expectedEncounterDates.length))
      .map((c) => {
        const src = pageText(c.page);
        const line = src.split("\n").find((l) => l.toLowerCase().includes(c.contains.toLowerCase())) ?? src.split("\n")[1] ?? src;
        return { field: "assessment" as const, value: c.contains, excerpt: line.trim(), page: c.page, confidence: 0.9 };
      });
    const dateLine = g.pages.flatMap((p) => p.split("\n")).find((l) => /date of (?:service|operation)|exam date/i.test(l)) ?? null;
    encounters.push({
      dateStatus: "DOCUMENTED",
      date,
      dateEnd: null,
      dateExcerpt: dateLine,
      encounterType: "Clinical encounter",
      provider: null,
      providerCredentials: null,
      facility: null,
      claims,
    } as LlmEncounter);
  }

  // Now the hostile part: propose each PROHIBITED statement as a claim,
  // citing a real line of the record (the classic failure mode — a true
  // quotation supporting a false conclusion).
  const hostile = g.prohibited.map((p, i) => {
    const anyLine = g.pages.flatMap((pg) => pg.split("\n")).filter((l) => l.trim().length > 12);
    return {
      field: "procedure" as const,
      claimType: "PROCEDURE_PERFORMED" as const,
      value: p.pattern.source.replace(/[\\^$?!()|\[\]]/g, "").slice(0, 80) || "prohibited",
      excerpt: (anyLine[i % anyLine.length] ?? anyLine[0]).trim(),
      page: 1,
      confidence: 0.9,
    };
  });
  if (encounters.length) encounters[0] = { ...encounters[0], claims: [...encounters[0].claims, ...hostile] };
  return encounters;
}

describe("gold corpus is synthetic", () => {
  it("contains no real patient information by construction", () => {
    expect(GOLD_CORPUS_IS_SYNTHETIC).toBe(true);
    expect(GOLD_CASES.length).toBeGreaterThanOrEqual(7);
  });
});

describe.each(GOLD_CASES.map((g) => [g.key, g] as const))("gold case: %s", (_key, g) => {
  const chunk = chunkFor(g);
  const proposed = proposeEncounters(g, chunk);
  const { accepted, rejected } = validateEncounters(chunk, proposed);
  const encounters = consolidateEncounters(accepted);
  const acceptedText = encounters
    .flatMap((e) => e.claims.map((c) => `${c.value} ${c.excerpt}`))
    .join(" \n ");

  it("every accepted claim carries a citation that resolves to a real page", () => {
    for (const e of encounters) {
      for (const c of e.claims) {
        expect(c.excerpt.trim().length, `claim "${c.value}" must cite text`).toBeGreaterThan(2);
        if (c.page != null) {
          const slice = chunk.pageSlices.find((p) => p.page === c.page);
          expect(slice, `page ${c.page} must exist`).toBeTruthy();
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
          expect(norm(slice!.text)).toContain(norm(c.excerpt));
        }
      }
    }
  });

  it("no prohibited statement survives validation", () => {
    for (const p of g.prohibited) {
      const survivors = encounters
        .flatMap((e) => e.claims.map((c) => c.value))
        .filter((v) => p.pattern.test(v));
      expect(survivors, `${p.why} — but survived as: ${survivors.join(" | ")}`).toEqual([]);
    }
  });

  it("rejections are recorded with reasons rather than dropped silently", () => {
    // The hostile pass proposes prohibited content; validation must say so.
    if (g.prohibited.length) expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) expect(r).toMatch(/rejected|demoted/);
  });

  it("no accepted claim asserts causation or future-care necessity", () => {
    expect(acceptedText).not.toMatch(/caused by|as a result of the (?:accident|collision)|supports? the need for/i);
  });

  it("dates never come from a signature, statement or print line", () => {
    for (const e of encounters) {
      if (!e.encounterDate) continue;
      const iso = e.encounterDate.toISOString().slice(0, 10);
      const banned = g.prohibited.filter((p) => /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/.test(p.pattern.source));
      for (const b of banned) expect(b.pattern.test(iso), `${b.why}`).toBe(false);
    }
  });
});

describe("gold audit outcomes", () => {
  it("a case with an unreadable page is EXTRACTION_INCOMPLETE, never PASS", () => {
    const g = GOLD_CASES.find((c) => c.key === "prompt-injection-and-unreadable")!;
    const chunk = chunkFor(g);
    const { accepted } = validateEncounters(chunk, proposeEncounters(g, chunk));
    const result = auditFactualRecord({
      encounters: accepted.map((e, i) => ({
        id: `e${i}`,
        sourceDocumentId: "doc-gold",
        dateStatus: e.dateStatus,
        encounterDate: e.encounterDate?.toISOString().slice(0, 10) ?? null,
        provider: e.provider,
        encounterType: e.encounterType,
        factualSummary: "Clinical encounter — lumbar radiculopathy.",
        claims: e.claims.map((c, j) => ({ id: `c${j}`, field: c.field, value: c.value, excerpt: c.excerpt, page: c.page, warning: c.warning })),
        page: e.page,
        status: "AI_DRAFT",
      })),
      pages: [
        { pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 },
        { pageNumber: 2, status: "UNREADABLE", ocrConfidence: null },
      ],
      failedExtractions: 0,
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    expect(result.result).toBe("EXTRACTION_INCOMPLETE");
    expect(result.findings.join(" ")).toMatch(/could not be read/);
  });

  it("prompt-injected instructions never become accepted claims", () => {
    const g = GOLD_CASES.find((c) => c.key === "prompt-injection-and-unreadable")!;
    const chunk = chunkFor(g);
    const { accepted } = validateEncounters(chunk, proposeEncounters(g, chunk));
    const text = accepted.flatMap((e) => e.claims.map((c) => c.value)).join(" ");
    expect(text).not.toMatch(/fully recovered|needs no further care/i);
  });
});
