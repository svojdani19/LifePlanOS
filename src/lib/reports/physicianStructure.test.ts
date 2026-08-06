// Physician-structured presentation — ledger, diagnoses evolution, graded
// narratives with episodes and a prior-history band, and diagnostic studies.
// Synthetic data only; every expectation mirrors a device observed in a real
// physician-authored LCP.
import { describe, it, expect } from "vitest";
import { buildVisitLedger, buildDiagnosesEvolution, buildNarratives, buildDiagnosticStudies, narrativeDepth } from "./physicianStructure";
import type { StructuredRecord, StructuredEncounter, StructuredDocument } from "@/lib/records/structuredRecord";

let seq = 0;
const enc = (over: Partial<StructuredEncounter>): StructuredEncounter => ({
  id: `e${++seq}`,
  sourceDocumentId: "doc-1",
  dateStatus: "DOCUMENTED",
  encounterDate: "2025-03-14",
  encounterDateEnd: null,
  provider: "Dana Rivers, MD",
  providerCredentials: null,
  facility: "Orthopedic Associates",
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit — Lumbar radiculopathy.",
  synthesis: null,
  claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 4, confidence: null }],
  page: 4,
  pageEnd: 6,
  ocrConfidence: 0.97,
  warnings: [],
  status: "AI_DRAFT",
  substanceClass: "CLINICAL",
  substanceReason: null,
  reviewedAt: null,
  verifiedAt: null,
  staleReason: null,
  ...over,
});

const doc = (encounters: StructuredEncounter[], over: Partial<StructuredDocument> = {}): StructuredDocument => ({
  documentId: "doc-1",
  filename: "Synthetic MR.pdf",
  type: "PROGRESS_NOTE",
  pageCount: 40,
  serviceDate: null,
  serviceDateEnd: null,
  ocrConfidence: 0.97,
  flags: null,
  extraction: { status: "COMPLETE", error: null, warnings: [], truncated: false, model: null, promptVersion: null, createdAt: null },
  encounters,
  ...over,
});

const record = (encounters: StructuredEncounter[]): StructuredRecord => ({
  documents: [doc(encounters)],
  undated: [],
  limitations: [],
  counts: { encounters: encounters.length, verified: 0, reviewed: 0, humanEdited: 0, aiDraft: encounters.length, stale: 0, failedDocs: 0, pendingOcr: 0 },
});

describe("visit ledger", () => {
  it("carries totals, the visit span, and one page-cited line per substantive visit", () => {
    const ledger = buildVisitLedger(record([
      enc({ encounterDate: "2025-01-05" }),
      enc({ encounterDate: "2025-03-14", claims: [{ field: "procedure", value: "Epidural steroid injection performed", excerpt: "Procedure performed: injection", page: 9, confidence: null }], page: 9, pageEnd: 9 }),
    ]));
    expect(ledger.totalPages).toBe(40);
    expect(ledger.visitSpan).toEqual({ from: "01/05/2025", to: "03/14/2025" });
    expect(ledger.lines).toHaveLength(2);
    expect(ledger.lines[0].cite).toBe("(Synthetic MR.pdf: p. 4–6)");
    expect(ledger.lines[1].procedure).toBe(true); // "- Procedure" flag, exemplar-style
  });

  it("excludes ancillary/administrative encounters and counts undated separately", () => {
    const ledger = buildVisitLedger(record([
      enc({}),
      enc({ substanceClass: "ADMINISTRATIVE" }),
      enc({ substanceClass: "ANCILLARY" }),
      enc({ encounterDate: null, dateStatus: "UNKNOWN" }),
    ]));
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.undatedCount).toBe(1);
  });
});

describe("diagnoses evolution", () => {
  it("one row per dated encounter with assessments, cited", () => {
    const rows = buildDiagnosesEvolution(record([
      enc({ encounterDate: "2025-01-05", claims: [{ field: "assessment", value: "Contusion of left knee", excerpt: "x", page: 2, confidence: null }], page: 2, pageEnd: 2 }),
      enc({ encounterDate: "2025-02-10", claims: [{ field: "treatment", value: "PT", excerpt: "x", page: 3, confidence: null }] }), // no assessment → no row
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "01/05/2025", diagnoses: "Contusion of left knee", cite: "(Synthetic MR.pdf: p. 2)" });
  });
});

describe("graded narrative depth", () => {
  it("procedures, first visits, and new assessments are EXPANDED; repeats are COMPRESSED", () => {
    const seenProviders = new Set<string>();
    const seenDx = new Set<string>();
    const first = enc({});
    expect(narrativeDepth(first, seenProviders, seenDx)).toBe("EXPANDED"); // first visit with clinician
    seenProviders.add("dana rivers md");
    seenDx.add("lumbar radiculopathy");
    expect(narrativeDepth(enc({}), seenProviders, seenDx)).toBe("COMPRESSED"); // same provider, same dx
    expect(narrativeDepth(enc({ encounterType: "Operative Report" }), seenProviders, seenDx)).toBe("EXPANDED");
    expect(
      narrativeDepth(enc({ claims: [{ field: "assessment", value: "New: cervical stenosis", excerpt: "x", page: 1, confidence: null }] }), seenProviders, seenDx),
    ).toBe("EXPANDED"); // changed assessment
  });

  it("a COMPRESSED narrative keeps only the interval fields; EXPANDED keeps all", () => {
    const claims = [
      { field: "subjective", value: "Feels improved", excerpt: "x", page: 4, confidence: null },
      { field: "objectiveFindings", value: "ROM improved to 60 degrees", excerpt: "x", page: 4, confidence: null },
      { field: "assessment", value: "Lumbar radiculopathy", excerpt: "x", page: 4, confidence: null },
    ];
    const sections = buildNarratives(record([
      enc({ encounterDate: "2025-01-05", claims }), // first visit → EXPANDED
      enc({ encounterDate: "2025-01-12", claims }), // repeat → COMPRESSED
    ]), null);
    const [a, b] = sections.course as { kind: "SINGLE"; narrative: { depth: string; lines: { label: string }[] } }[];
    expect(a.narrative.depth).toBe("EXPANDED");
    expect(a.narrative.lines.map((l) => l.label)).toContain("Exam");
    expect(b.narrative.depth).toBe("COMPRESSED");
    expect(b.narrative.lines.map((l) => l.label)).not.toContain("Exam");
  });
});

describe("prior-history band and episodes", () => {
  it("care before the DOI lands in the prior-history band, never mixed into the course", () => {
    const sections = buildNarratives(
      record([enc({ encounterDate: "2008-06-01", claims: [{ field: "procedure", value: "C2-C7 cervical fusion performed", excerpt: "x", page: 1, confidence: null }] }), enc({ encounterDate: "2025-03-14" })]),
      new Date("2023-05-29T00:00:00Z"),
    );
    expect(sections.priorHistory).toHaveLength(1);
    expect(sections.course).toHaveLength(1);
  });

  it("without a DOI everything is course — nothing is guessed", () => {
    const sections = buildNarratives(record([enc({ encounterDate: "2008-06-01" })]), null);
    expect(sections.priorHistory).toHaveLength(0);
    expect(sections.course).toHaveLength(1);
  });

  it("consecutive same-facility inpatient days group into one admission arc", () => {
    const day = (d: string) => enc({ encounterDate: d, encounterType: "Inpatient", facility: "St. Synthetic Medical Center", claims: [{ field: "objectiveFindings", value: `Exam on ${d}`, excerpt: "x", page: 1, confidence: null }] });
    const sections = buildNarratives(record([day("2025-07-13"), day("2025-07-14"), day("2025-07-15"), enc({ encounterDate: "2025-08-01" })]), null);
    const episode = sections.course.find((b) => b.kind === "EPISODE");
    expect(episode).toBeTruthy();
    if (episode?.kind === "EPISODE") {
      expect(episode.members).toHaveLength(3);
      expect(episode.from).toBe("07/13/2025");
      expect(episode.to).toBe("07/15/2025");
    }
    expect(sections.course.filter((b) => b.kind === "SINGLE")).toHaveLength(1);
  });

  it("a partially illegible note carries the physician-style inline caveat", () => {
    const sections = buildNarratives(record([enc({ ocrConfidence: 0.55 })]), null);
    const single = sections.course[0];
    if (single.kind === "SINGLE") {
      expect(single.narrative.qualityNote).toMatch(/partially illegible/);
    } else {
      throw new Error("expected single narrative");
    }
  });
});

describe("diagnostic studies", () => {
  it("collects findings per study encounter, cited", () => {
    const studies = buildDiagnosticStudies(record([
      enc({ encounterType: "MRI - Lumbar Spine", claims: [{ field: "diagnosticStudies", value: "L2/3 disc herniation with central annular tear", excerpt: "x", page: 11, confidence: null }], page: 11, pageEnd: 11 }),
      enc({ claims: [{ field: "treatment", value: "PT", excerpt: "x", page: 3, confidence: null }] }), // no studies → excluded
    ]));
    expect(studies).toHaveLength(1);
    expect(studies[0].heading).toMatch(/MRI - Lumbar Spine/);
    expect(studies[0].cite).toBe("(Synthetic MR.pdf: p. 11)");
  });
});
