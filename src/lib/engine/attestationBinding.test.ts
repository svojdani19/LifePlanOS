// Attestation ↔ clinical-evidence binding (cfp-1). Spec items 8–16: every kind
// of clinical-material change invalidates the binding; workflow/lifecycle
// defects block despite item approval; legacy unversioned attestations can
// never authorize; history stays readable; display-only edits never touch the
// fingerprint.

import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({
  caseFindFirst: vi.fn(),
  itemFindMany: vi.fn(),
  assessmentFindMany: vi.fn(),
  conditionFindMany: vi.fn(),
  chronologyFindMany: vi.fn(),
  interviewFindMany: vi.fn(),
  documentFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    case: { findFirst: db.caseFindFirst },
    futureCareItem: { findMany: db.itemFindMany },
    clinicalReasoningAssessment: { findMany: db.assessmentFindMany },
    condition: { findMany: db.conditionFindMany },
    chronologyEvent: { findMany: db.chronologyFindMany },
    interviewFinding: { findMany: db.interviewFindMany },
    document: { findMany: db.documentFindMany },
  },
}));

import {
  CLINICAL_FINGERPRINT_VERSION,
  DEFAULT_ATTESTATION_OPINION_SCOPES,
  computeClinicalFingerprint,
  computeCategorySubHashes,
  buildFingerprintInputForRecommendation,
  buildClinicalBindingState,
  loadClinicalBindingState,
  aggregateClinicalFingerprint,
  verifyAttestationClinicalBinding,
  diffAssessmentFingerprintCategories,
  canonicalJson,
  type BindingRows,
  type BindingAssessmentRow,
  type ClinicalBindingState,
} from "./attestationBinding";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseRows = (): BindingRows => ({
  items: [
    {
      id: "i1",
      lineageId: "L1",
      version: 2,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      probability: "PROBABLE",
      frequencyPerYear: 12,
      durationYears: null,
      isLifetime: true,
      startTrigger: null,
      prerequisite: null,
      contingencyOnly: false,
      conditionId: "c1",
      physicianNote: "Agreed — chronic post-traumatic condition.",
      citation: [{ title: "Long-term outcomes after THA", year: 2021, pmid: "12345" }],
    },
  ],
  assessments: [
    {
      id: "a1",
      recommendationId: "i1",
      status: "VALIDATED",
      generatedByModel: "deterministic-reasoning-v7",
      createdAt: new Date("2026-07-02T00:00:00Z"),
      probabilityClassification: "PROBABLE_INCLUDED",
      durationClass: "LIFETIME",
      durationRationale: "Lifetime duration supported by documented chronicity (osteoarthritis, end-stage).",
      evidenceItems: [
        { category: "imaging", text: "Severe joint-space narrowing", source: "records.pdf", page: 12, date: "2026-01-05", provider: "Dr. A", objective: true, epistemic: "documented_fact" },
      ],
      weakeningEvidence: [{ text: "One note reports symptom improvement", source: "pt-note.pdf" }],
      evidenceSufficiency: { sufficient: true, score: 78, threshold: 50 },
      supportingDiagnosisIds: ["c1"],
      supportingLiteratureAssessments: [{ title: "THA survivorship at 25 years", pmid: "999", year: 2019 }],
      supportingGuidelineAssessments: [{ title: "AAOS OA guideline", claim: "Surveillance recommended" }],
      selfCritique: { assumptions: ["Patient remains community-ambulatory"] },
      conflictFlags: [],
      unknowns: [{ kind: "surgical_candidacy", text: "Cardiology clearance not on file" }],
      missingEvidenceRequests: ["Updated weight-bearing radiographs"],
    },
  ],
  conditions: [
    {
      id: "c1",
      name: "Post-traumatic osteoarthritis, right hip",
      relatedness: "RELATED",
      evidenceSources: [{ documentId: "d1", filename: "records.pdf", page: 12, quote: "end-stage degenerative change" }],
    },
  ],
  chronology: [
    { id: "ev1", eventDate: new Date("2025-11-01T00:00:00Z"), summary: "ORIF right acetabulum", diagnosis: "Acetabular fracture", treatment: "ORIF", sourceQuote: "comminuted fracture", imagingFindings: null, sourceDocumentId: "d2" },
  ],
  interviews: [
    { id: "f1", category: "function", text: "Cannot stand longer than 20 minutes", quote: "I can't stand at work anymore", interviewDate: new Date("2026-05-01T00:00:00Z"), conditionId: "c1", futureCareItemId: null },
  ],
  documents: [
    { id: "d1", pageCount: 40, extractedText: "…end-stage degenerative change…" },
    { id: "d2", pageCount: 12, extractedText: "operative report text" },
  ],
});

/** Simulate signing against a state: pinned per-item fingerprints + aggregate. */
const signedAtt = (state: Map<string, ClinicalBindingState>, itemIds: string[]) => ({
  clinicalFingerprint: aggregateClinicalFingerprint(
    itemIds.map((id) => ({ itemId: id, clinicalFingerprint: state.get(id)?.clinicalFingerprint ?? "" })),
  ),
  bindingVersion: CLINICAL_FINGERPRINT_VERSION,
  scope: itemIds.map((id) => ({ itemId: id, lineageId: "L1", clinicalFingerprint: state.get(id)?.clinicalFingerprint ?? null })),
});

const mutateAssessment = (rows: BindingRows, patch: Partial<BindingAssessmentRow>): BindingRows => ({
  ...rows,
  assessments: [{ ...rows.assessments[0], ...patch }],
});

const expectInvalidatedBy = (mutated: BindingRows) => {
  const before = buildClinicalBindingState(baseRows());
  const att = signedAtt(before, ["i1"]);
  const after = buildClinicalBindingState(mutated);
  const verdict = verifyAttestationClinicalBinding(att, after, ["i1"]);
  expect(verdict.ok).toBe(false);
  expect(verdict.reasons).toContain("CLINICAL_FINGERPRINT_MISMATCH");
};

// ── Canonicalization & determinism ───────────────────────────────────────────

describe("computeClinicalFingerprint", () => {
  it("is versioned, sha-256-shaped, and deterministic", () => {
    const input = buildFingerprintInputForRecommendation(baseRows().items[0], baseRows());
    const fp = computeClinicalFingerprint(input);
    expect(fp).toMatch(/^cfp-1:[0-9a-f]{64}$/);
    expect(computeClinicalFingerprint(input)).toBe(fp);
  });

  it("canonicalizes key order and array order", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }, { x: 0 }] })).toBe(canonicalJson({ a: [{ x: 0 }, { x: 1, y: 2 }], b: 1 }));
    const rows = baseRows();
    const reordered: BindingRows = { ...rows, chronology: [...rows.chronology].reverse(), documents: [...rows.documents].reverse() };
    expect(buildClinicalBindingState(rows).get("i1")!.clinicalFingerprint).toBe(buildClinicalBindingState(reordered).get("i1")!.clinicalFingerprint);
  });

  it("exposes one diffable sub-hash per category", () => {
    const input = buildFingerprintInputForRecommendation(baseRows().items[0], baseRows());
    const subs = computeCategorySubHashes(input);
    expect(Object.keys(subs).sort()).toEqual([
      "assessment", "assumptions", "chronology", "citations", "contradictions",
      "documents", "duration", "evidence", "interviews", "providerOpinions",
      "recommendation", "unknowns",
    ]);
  });
});

// ── Display-only changes never move the fingerprint (spec item 16b) ──────────

describe("display-only exclusion", () => {
  it("narrative summaries, labels, and financial fields do NOT change the fingerprint", () => {
    const before = buildClinicalBindingState(baseRows()).get("i1")!.clinicalFingerprint;
    const rows = baseRows();
    // Display/derived-only edits: summary paragraphs, physicianSummary, costs.
    const assessment = rows.assessments[0] as unknown as Record<string, unknown>;
    const item = rows.items[0] as unknown as Record<string, unknown>;
    assessment.objectiveEvidenceSummary = "REWRITTEN for readability";
    assessment.literatureSynthesis = "Different synthesis paragraph";
    assessment.confidenceExplanation = "Different explanation";
    item.physicianSummary = "New paraphrase";
    item.unitCost = 999_999;
    item.presentValue = 123_456;
    expect(buildClinicalBindingState(rows).get("i1")!.clinicalFingerprint).toBe(before);
  });
});

// ── Invalidation on clinical-material change (spec items 8–12) ───────────────

describe("clinical-material changes invalidate the binding", () => {
  it("a supporting-quotation change invalidates (item 8)", () => {
    const rows = baseRows();
    rows.conditions[0].evidenceSources = [{ documentId: "d1", filename: "records.pdf", page: 12, quote: "MILD degenerative change" }];
    expectInvalidatedBy(rows);
  });

  it("a contradicting-evidence change invalidates (item 9)", () => {
    expectInvalidatedBy(mutateAssessment(baseRows(), { weakeningEvidence: [{ text: "Two notes report full resolution", source: "pt-note.pdf" }] }));
  });

  it("a source-document content-version change invalidates (item 10)", () => {
    const rows = baseRows();
    rows.documents[0] = { ...rows.documents[0], extractedText: "…different OCR content after re-scan…" };
    expectInvalidatedBy(rows);
  });

  it("a chronology change invalidates (item 11)", () => {
    const rows = baseRows();
    rows.chronology[0] = { ...rows.chronology[0], summary: "Revision ORIF right acetabulum" };
    expectInvalidatedBy(rows);
  });

  it("an interview-finding change invalidates (item 11)", () => {
    const rows = baseRows();
    rows.interviews[0] = { ...rows.interviews[0], text: "Cannot stand longer than 5 minutes" };
    expectInvalidatedBy(rows);
  });

  it("a citation change invalidates (item 12)", () => {
    expectInvalidatedBy(mutateAssessment(baseRows(), { supportingLiteratureAssessments: [{ title: "A different paper", pmid: "111", year: 2024 }] }));
  });

  it("a guideline change invalidates (item 12)", () => {
    expectInvalidatedBy(mutateAssessment(baseRows(), { supportingGuidelineAssessments: [{ title: "NICE OA guideline", claim: "Different claim" }] }));
  });

  it("a duration-support (durationRationale) change invalidates", () => {
    expectInvalidatedBy(mutateAssessment(baseRows(), { durationRationale: "Lifetime duration is an assumption pending professional review." }));
  });

  it("an assessment supersession (new assessment id) invalidates", () => {
    expectInvalidatedBy(mutateAssessment(baseRows(), { id: "a2" }));
  });
});

// ── Lifecycle/verdict gates (spec items 13–14) ───────────────────────────────

describe("assessment lifecycle gates", () => {
  const verdictFor = (patch: Partial<BindingAssessmentRow>) => {
    const rows = mutateAssessment(baseRows(), patch);
    const state = buildClinicalBindingState(rows);
    // Attestation signed against this EXACT state — fingerprints match, so any
    // failure is the lifecycle/verdict gate, not drift.
    return verifyAttestationClinicalBinding(signedAtt(state, ["i1"]), state, ["i1"]);
  };

  it("NEEDS_REVIEW blocks despite item APPROVED (item 13)", () => {
    const v = verdictFor({ status: "NEEDS_REVIEW" });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["ASSESSMENT_NEEDS_REVIEW"]);
  });

  it("INVALID and ERROR block (item 13)", () => {
    expect(verdictFor({ status: "INVALID" }).reasons).toEqual(["ASSESSMENT_INVALID"]);
    expect(verdictFor({ status: "ERROR" }).reasons).toEqual(["ASSESSMENT_INVALID"]);
  });

  it("evidence insufficiency blocks (item 14)", () => {
    const v = verdictFor({ evidenceSufficiency: { sufficient: false, score: 22, threshold: 50 } });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("EVIDENCE_INSUFFICIENT");
  });

  it("a superseded-only assessment lineage blocks", () => {
    const v = verdictFor({ status: "SUPERSEDED" });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("ASSESSMENT_SUPERSEDED");
  });

  it("a missing assessment blocks", () => {
    const rows = baseRows();
    rows.assessments = [];
    const state = buildClinicalBindingState(rows);
    const v = verifyAttestationClinicalBinding(signedAtt(state, ["i1"]), state, ["i1"]);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("ASSESSMENT_MISSING");
  });

  it("an item absent from the state map blocks as missing", () => {
    const state = buildClinicalBindingState(baseRows());
    const v = verifyAttestationClinicalBinding(signedAtt(state, ["i1"]), state, ["i1", "i-gone"]);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("ASSESSMENT_MISSING");
  });

  it("a fully valid binding verifies", () => {
    const state = buildClinicalBindingState(baseRows());
    const v = verifyAttestationClinicalBinding(signedAtt(state, ["i1"]), state, ["i1"]);
    expect(v).toEqual({ ok: true, reasons: [] });
  });
});

// ── Legacy attestations (spec items 15–16) ───────────────────────────────────

describe("legacy unversioned attestations", () => {
  it("can never authorize a new final (item 15)", () => {
    const state = buildClinicalBindingState(baseRows());
    const v = verifyAttestationClinicalBinding({ clinicalFingerprint: null, bindingVersion: null, scope: [{ itemId: "i1", lineageId: "L1" }] }, state, ["i1"]);
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["ATTESTATION_UNVERSIONED"]);
  });

  it("remains readable — malformed/legacy scope never throws (item 16)", () => {
    const state = buildClinicalBindingState(baseRows());
    for (const scope of [null, undefined, "not-an-array", [{ noItemId: true }], [null]]) {
      expect(() => verifyAttestationClinicalBinding({ clinicalFingerprint: "cfp-1:deadbeef", bindingVersion: "cfp-1", scope }, state, ["i1"])).not.toThrow();
      expect(() => verifyAttestationClinicalBinding({ clinicalFingerprint: null, bindingVersion: null, scope }, state, ["i1"])).not.toThrow();
    }
  });

  it("historical (superseded) assessments still feed a readable state", () => {
    const rows = mutateAssessment(baseRows(), { status: "SUPERSEDED" });
    const state = buildClinicalBindingState(rows);
    const st = state.get("i1")!;
    expect(st.superseded).toBe(true);
    expect(st.assessmentId).toBe("a1"); // history preserved and readable
    expect(st.clinicalFingerprint).toMatch(/^cfp-1:/);
  });
});

// ── Category diff for supersession audit events ──────────────────────────────

describe("diffAssessmentFingerprintCategories", () => {
  const prior = baseRows().assessments[0];

  it("names exactly the changed category (citations)", () => {
    const next = { ...prior, supersededById: undefined, supportingLiteratureAssessments: [{ title: "New paper", pmid: "222" }] };
    expect(diffAssessmentFingerprintCategories(prior, next)).toEqual(["citations"]);
  });

  it("names duration and evidence changes independently", () => {
    expect(diffAssessmentFingerprintCategories(prior, { ...prior, durationRationale: "changed basis" })).toEqual(["duration"]);
    expect(diffAssessmentFingerprintCategories(prior, { ...prior, evidenceItems: [] })).toEqual(["evidence"]);
    expect(diffAssessmentFingerprintCategories(prior, { ...prior, unknowns: [] })).toEqual(["unknowns"]);
  });

  it("ignores pure lifecycle transitions (workflow, not clinical material)", () => {
    expect(diffAssessmentFingerprintCategories(prior, { ...prior, status: "NEEDS_REVIEW" })).toEqual([]);
  });
});

// ── Signing metadata ─────────────────────────────────────────────────────────

describe("opinion scopes", () => {
  it("the default item-attestation scopes cover necessity + frequency/duration and NOT causation", () => {
    expect(DEFAULT_ATTESTATION_OPINION_SCOPES).toEqual(["FUTURE_CARE_MEDICAL_NECESSITY", "FREQUENCY_AND_DURATION"]);
    expect(DEFAULT_ATTESTATION_OPINION_SCOPES).not.toContain("CAUSATION");
  });
});

// ── Loader (prisma mocked) ───────────────────────────────────────────────────

describe("loadClinicalBindingState", () => {
  it("returns an empty map when the case is outside the firm (fail closed)", async () => {
    db.caseFindFirst.mockResolvedValueOnce(null);
    const map = await loadClinicalBindingState("firm-1", "case-x");
    expect(map.size).toBe(0);
  });

  it("assembles the state from current items/assessments and referenced documents only", async () => {
    const rows = baseRows();
    db.caseFindFirst.mockResolvedValueOnce({ id: "case-1" });
    db.itemFindMany.mockResolvedValueOnce(rows.items);
    db.assessmentFindMany.mockResolvedValueOnce(rows.assessments);
    db.conditionFindMany.mockResolvedValueOnce(rows.conditions);
    db.chronologyFindMany.mockResolvedValueOnce(rows.chronology);
    db.interviewFindMany.mockResolvedValueOnce(rows.interviews);
    db.documentFindMany.mockResolvedValueOnce(rows.documents);

    const map = await loadClinicalBindingState("firm-1", "case-1");
    expect(map.get("i1")).toMatchObject({
      assessmentId: "a1",
      assessmentStatus: "VALIDATED",
      superseded: false,
      evidenceSufficient: true,
      probability: "PROBABLE",
      frequencyPerYear: 12,
      durationYears: null,
      isLifetime: true,
    });
    // Same fingerprint as the pure builder over identical rows.
    expect(map.get("i1")!.clinicalFingerprint).toBe(buildClinicalBindingState(rows).get("i1")!.clinicalFingerprint);
    // Only referenced documents were queried (d1 via evidenceSources, d2 via chronology).
    const where = db.documentFindMany.mock.calls[0][0].where;
    expect(new Set(where.id.in)).toEqual(new Set(["d1", "d2"]));
  });
});
