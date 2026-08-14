// Physician-structured presentation — ledger, diagnoses evolution, graded
// narratives with episodes and a prior-history band, and diagnostic studies.
// Synthetic data only; every expectation mirrors a device observed in a real
// physician-authored LCP.
import { describe, it, expect } from "vitest";
import {
  buildVisitLedger,
  buildDiagnosesEvolution,
  buildNarratives,
  buildDiagnosticStudies,
  buildOperativeReports,
  buildExpertOpinions,
  buildAttributedEvidence,
  narrativeDepth,
} from "./physicianStructure";
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
  analysisClass: "CLINICAL_ENCOUNTER",
  attributionName: null,
  attributionRole: null,
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
  counts: { encounters: encounters.length, verified: 0, reviewed: 0, humanEdited: 0, aiDraft: encounters.length, aiAuditPassed: 0, pendingHumanReview: encounters.length, stale: 0, generationLoss: 0, undatedClinical: 0, undatedNonClinical: 0, failedDocs: 0, pendingOcr: 0 },
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

describe("claim-specific page citations", () => {
  it("a narrative line cites the page its own claims are on, not the note's whole span", () => {
    // A 40-page admission: the assessment is on p. 31, the exam on p. 12.
    const sections = buildNarratives(record([
      enc({
        page: 4,
        pageEnd: 43,
        claims: [
          { field: "objectiveFindings", value: "Antalgic gait", excerpt: "x", page: 12, confidence: null },
          { field: "assessment", value: "Lumbar radiculopathy", excerpt: "x", page: 31, confidence: null },
        ],
      }),
    ]), null);
    const single = sections.course[0];
    if (single.kind !== "SINGLE") throw new Error("expected single narrative");
    const byLabel = Object.fromEntries(single.narrative.lines.map((l) => [l.label, l.cite]));
    expect(byLabel["Exam"]).toBe("(Synthetic MR.pdf: p. 12)");
    expect(byLabel["Assessment"]).toBe("(Synthetic MR.pdf: p. 31)");
    // The encounter-level citation still states the span it came from.
    expect(single.narrative.cite).toBe("(Synthetic MR.pdf: p. 4–43)");
  });

  it("claims spread over pages cite the pages they are on, compacted", () => {
    const sections = buildNarratives(record([
      enc({
        page: 1,
        pageEnd: 9,
        claims: [
          { field: "assessment", value: "Cervical strain", excerpt: "x", page: 3, confidence: null },
          { field: "assessment", value: "Lumbar strain", excerpt: "x", page: 4, confidence: null },
          { field: "assessment", value: "Headache", excerpt: "x", page: 7, confidence: null },
        ],
      }),
    ]), null);
    const single = sections.course[0];
    if (single.kind !== "SINGLE") throw new Error("expected single narrative");
    expect(single.narrative.lines.find((l) => l.label === "Assessment")!.cite).toBe("(Synthetic MR.pdf: p. 3–4, 7)");
  });

  it("a claim with no page of its own adds no line citation — no page is invented", () => {
    const sections = buildNarratives(record([
      enc({ page: 4, pageEnd: 6, claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "x", page: null, confidence: null }] }),
    ]), null);
    const single = sections.course[0];
    if (single.kind !== "SINGLE") throw new Error("expected single narrative");
    expect(single.narrative.lines.find((l) => l.label === "Assessment")!.cite).toBeNull();
  });

  it("the diagnoses table and studies section cite their own claims", () => {
    const rows = buildDiagnosesEvolution(record([
      enc({ page: 1, pageEnd: 20, claims: [{ field: "assessment", value: "Contusion of left knee", excerpt: "x", page: 15, confidence: null }] }),
    ]));
    expect(rows[0].cite).toBe("(Synthetic MR.pdf: p. 15)");
    const studies = buildDiagnosticStudies(record([
      enc({ encounterType: "MRI - Lumbar Spine", page: 1, pageEnd: 20, claims: [{ field: "diagnosticStudies", value: "L2/3 disc herniation", excerpt: "x", page: 18, confidence: null }] }),
    ]));
    expect(studies[0].cite).toBe("(Synthetic MR.pdf: p. 18)");
  });

  it("a procedure ledger line points at the procedure, not the admission span", () => {
    const ledger = buildVisitLedger(record([
      enc({ page: 1, pageEnd: 40, claims: [{ field: "procedure", value: "L4-L5 fusion performed", excerpt: "x", page: 22, confidence: null }] }),
    ]));
    expect(ledger.lines[0].cite).toBe("(Synthetic MR.pdf: p. 22)");
  });
});

describe("non-clinical kinds are reported, but never as treating care", () => {
  const kindEnc = (analysisClass: string, over: Partial<StructuredEncounter> = {}) =>
    enc({ analysisClass, substanceClass: analysisClass === "CLINICAL_ENCOUNTER" ? "CLINICAL" : "ANCILLARY", ...over });

  it("testimony, billing and legal material stay out of the physician ledger", () => {
    const ledger = buildVisitLedger(record([
      kindEnc("CLINICAL_ENCOUNTER"),
      kindEnc("TESTIMONY", { claims: [{ field: "admission", value: "Prior injury acknowledged", excerpt: "x", page: 3, confidence: null }] }),
      kindEnc("FINANCIAL", { claims: [{ field: "charge", value: "CPT 99214", excerpt: "x", page: 5, confidence: null }] }),
      kindEnc("LEGAL", { claims: [{ field: "legalAssertion", value: "Defendant denies liability", excerpt: "x", page: 2, confidence: null }] }),
      kindEnc("UNKNOWN", { substanceClass: "ADMINISTRATIVE", claims: [{ field: "documentContent", value: "A transmittal letter", excerpt: "x", page: 1, confidence: null }] }),
    ]));
    expect(ledger.lines).toHaveLength(1); // only the clinical visit
  });

  it("each of them appears in the attributed-evidence section instead", () => {
    const evidence = buildAttributedEvidence(record([
      kindEnc("TESTIMONY", { attributionName: "Jordan Reyes", attributionRole: "deponent", claims: [{ field: "admission", value: "Prior injury acknowledged", excerpt: "x", page: 3, confidence: null }] }),
      kindEnc("FINANCIAL", { claims: [{ field: "charge", value: "CPT 99214 office visit", excerpt: "x", page: 5, confidence: null }] }),
      kindEnc("UNKNOWN", { substanceClass: "ADMINISTRATIVE", claims: [{ field: "documentContent", value: "A transmittal letter", excerpt: "x", page: 1, confidence: null }] }),
    ]));
    const kinds = evidence.map((e) => e.kind);
    expect(kinds).toContain("Sworn testimony");
    expect(kinds).toContain("Billing");
    expect(kinds).toContain("Unclassified");
    const depo = evidence.find((e) => e.kind === "Sworn testimony")!;
    expect(depo.attribution).toBe("Jordan Reyes");
    expect(depo.attributionRole).toBe("deponent");
    // Nothing here is formatted as S/O/A/P.
    expect(depo.lines.map((l) => l.label)).toContain("Admission against interest");
    expect(evidence.find((e) => e.kind === "Unclassified")!.requiresReview).toBe(true);
  });

  it("an operative report renders its own fields, one entry per operation", () => {
    const ops = buildOperativeReports(record([
      kindEnc("OPERATIVE", {
        encounterType: "Operative report",
        attributionName: "Sam Okafor, MD",
        claims: [
          { field: "preOperativeDiagnosis", value: "L4-L5 disc herniation", excerpt: "x", page: 3, confidence: null },
          { field: "postOperativeDiagnosis", value: "L4-L5 disc herniation", excerpt: "x", page: 3, confidence: null },
          { field: "procedure", value: "L4-L5 microdiscectomy", excerpt: "x", page: 4, confidence: null },
          { field: "operativeFindings", value: "Extruded disc fragment", excerpt: "x", page: 5, confidence: null },
          { field: "implants", value: "None", excerpt: "x", page: 5, confidence: null },
          { field: "complications", value: "None", excerpt: "x", page: 6, confidence: null },
          { field: "estimatedBloodLoss", value: "Minimal", excerpt: "x", page: 6, confidence: null },
          { field: "specimen", value: "Disc material to pathology", excerpt: "x", page: 6, confidence: null },
        ],
      }),
    ]));
    expect(ops).toHaveLength(1);
    expect(ops[0].surgeon).toBe("Sam Okafor, MD");
    const labels = ops[0].lines.map((l) => l.label);
    for (const l of ["Pre-operative diagnosis", "Post-operative diagnosis", "Procedure performed", "Operative findings", "Implants / hardware", "Complications", "Estimated blood loss", "Specimen"]) {
      expect(labels, l).toContain(l);
    }
    // Explicitly documented ABSENCE of complications survives as a fact.
    expect(ops[0].lines.find((l) => l.label === "Complications")!.text).toBe("None");
  });

  it("a diagnostic study carries technique, comparison, impression and its interpreter", () => {
    const studies = buildDiagnosticStudies(record([
      kindEnc("DIAGNOSTIC_STUDY", {
        encounterType: "MRI - Lumbar Spine",
        substanceClass: "CLINICAL",
        attributionName: "A. Reader, MD",
        claims: [
          { field: "studyTechnique", value: "Multiplanar multisequence imaging", excerpt: "x", page: 11, confidence: null },
          { field: "comparison", value: "None available", excerpt: "x", page: 11, confidence: null },
          { field: "diagnosticStudies", value: "Disc extrusion at L4-L5", excerpt: "x", page: 12, confidence: null },
          { field: "impression", value: "L4-L5 disc extrusion with stenosis", excerpt: "x", page: 12, confidence: null },
        ],
      }),
    ]));
    expect(studies).toHaveLength(1);
    expect(studies[0].impression).toContain("L4-L5 disc extrusion with stenosis");
    expect(studies[0].technique).toContain("Multiplanar multisequence imaging");
    expect(studies[0].comparison).toContain("None available");
    expect(studies[0].interpretedBy).toBe("A. Reader, MD");
  });

  it("a study whose only content is its impression is no longer dropped", () => {
    const studies = buildDiagnosticStudies(record([
      kindEnc("DIAGNOSTIC_STUDY", {
        encounterType: "MRI - Lumbar Spine",
        substanceClass: "CLINICAL",
        claims: [{ field: "impression", value: "L4-L5 disc extrusion", excerpt: "x", page: 12, confidence: null }],
      }),
    ]));
    expect(studies).toHaveLength(1);
  });

  it("an expert opinion is rendered as attributed opinion with its role", () => {
    const experts = buildExpertOpinions(record([
      kindEnc("EXPERT_OPINION", {
        attributionName: "R. Vance, MD",
        attributionRole: "examining expert",
        claims: [
          { field: "causationOpinion", value: "Causally related to the collision", excerpt: "x", page: 8, confidence: null },
          { field: "workStatus", value: "Capable of sedentary work", excerpt: "x", page: 9, confidence: null },
        ],
      }),
    ]));
    expect(experts).toHaveLength(1);
    expect(experts[0].expert).toBe("R. Vance, MD");
    expect(experts[0].role).toBe("examining expert");
    expect(experts[0].lines.map((l) => l.label)).toContain("Causation / apportionment opinion");
  });
});
