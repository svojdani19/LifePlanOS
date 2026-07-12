import { describe, it, expect } from "vitest";
import { buildLinks } from "./evidenceGraph";

// The evidence graph is lifted strictly from structured engine output — no
// inference, no fabrication. These tests pin the lifting rules.

describe("buildLinks", () => {
  const conditions = [
    {
      id: "c1",
      name: "L1 burst fracture",
      opposingRecords: "Prior imaging notes degenerative change.",
      evidenceSources: [{ documentId: "d1", filename: "op-note.pdf", page: 2, quote: "L1 burst fracture with retropulsion" }],
      socAnalysis: { guidelines: [{ title: "Thoracolumbar fracture guideline", year: "2025", pmid: "123", quote: "Fixation is recommended." }] },
    },
    { id: "c2", name: "Neurogenic bladder", evidenceSources: null, socAnalysis: null },
  ];
  const items = [
    { id: "i1", conditionId: "c1", citation: [{ title: "TLIF outcomes cohort", year: "2024", pmid: "456" }] },
    { id: "i2", conditionId: "c2", citation: null },
    { id: "i3", conditionId: "c1", citation: null, supersededAt: new Date() }, // superseded — excluded
  ];
  const links = buildLinks(conditions, items);

  it("lifts diagnosis→record evidence with document, page, and verbatim quote", () => {
    const l = links.find((x) => x.kind === "DIAGNOSIS_EVIDENCE");
    expect(l).toMatchObject({ fromId: "c1", documentId: "d1", page: 2 });
    expect(l!.quote).toContain("retropulsion");
  });

  it("lifts diagnosis→guideline with the verbatim quote and citation meta", () => {
    const l = links.find((x) => x.kind === "DIAGNOSIS_GUIDELINE");
    expect(l!.quote).toBe("Fixation is recommended.");
    expect((l!.meta as { pmid?: string }).pmid).toBe("123");
  });

  it("records contradictory evidence as CONTRADICTS", () => {
    expect(links.find((x) => x.kind === "CONTRADICTS")!.quote).toMatch(/degenerative/);
  });

  it("links each current recommendation to its mapped diagnosis", () => {
    const rec = links.filter((x) => x.kind === "REC_DIAGNOSIS");
    expect(rec.map((r) => `${r.fromId}→${r.toId}`).sort()).toEqual(["i1→c1", "i2→c2"]);
  });

  it("excludes superseded recommendations from the graph", () => {
    expect(links.some((x) => x.fromId === "i3")).toBe(false);
  });

  it("lifts real literature citations only (no title ⇒ no link)", () => {
    const lit = links.filter((x) => x.kind === "REC_LITERATURE");
    expect(lit).toHaveLength(1);
    expect((lit[0].meta as { title?: string }).title).toBe("TLIF outcomes cohort");
  });
});
