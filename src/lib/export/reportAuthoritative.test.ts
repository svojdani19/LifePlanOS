// The rendered report, when the record and the live rows disagree.
//
// c5bd542 moved the schedule and totals onto a view, but the view keyed on
// whether an individual subfield existed and fell back to the live row when it
// did not — so a legacy, partial or malformed basis still produced a document
// mixing recorded and current values. Membership, counts, scenario ranges and
// most of the narrative fields were still live.
//
// Everything here asserts on the actual unzipped DOCX.

import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { assembleBasis } from "@/lib/engine/basisAssembly";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const KASE: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
const CONDITION = {
  id: "c-1", name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss" }],
} as unknown as DossierCondition & { id: string };
const CHRONO: DossierChronoEvent[] = [
  { eventDate: "2024-08-01", imagingFindings: "MRI of the right knee: high-grade chondral loss", sourcePage: 4 } as never,
];
const ASSUMPTIONS = { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1.04, pricedAt: "2026-01-15T00:00:00.000Z", conditionName: CONDITION.name };

const deps = vi.hoisted(() => ({ bases: [] as unknown[] }));

vi.mock("@/lib/db", async () => {
  const { goldenCase, goldenAssessments, GOLDEN_CASE_ID } = await import("./goldenFixture");
  return {
    prisma: {
      case: { findUniqueOrThrow: async () => goldenCase(), findFirst: async () => ({ id: GOLDEN_CASE_ID, firmId: "firm-golden" }) },
      clinicalReasoningAssessment: { findMany: async () => goldenAssessments() },
      validationFinding: { findMany: async () => [], count: async () => 0 },
      futureCareItem: { findMany: async () => goldenCase().futureCareItems },
      condition: { findMany: async () => goldenCase().conditions },
      attestation: { findMany: async () => goldenCase().attestations },
      user: { findFirst: async () => ({ id: "user-golden-md", role: "PHYSICIAN_REVIEWER" }) },
      userRoleAssignment: { findFirst: async () => null },
      userCredential: { findMany: async () => [{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: null }] },
      recommendationEvidence: { findMany: async () => [] },
      recommendationBasis: { findMany: async () => deps.bases },
      retrievalAttempt: { findMany: async () => [], findFirst: async () => null },
      economicAssumption: { findFirst: async () => null },
      vocationalEntry: { findMany: async () => [] },
      economicScenario: { findMany: async () => [] },
      reportApproval: { findFirst: async () => null },
      futureDamagesEvaluation: { findFirst: async () => null },
    },
  };
});

const rendered = async (): Promise<string> => {
  const { buildReportDocx } = await import("./report");
  const { buffer } = await buildReportDocx("case-golden-lcp-0001", "PLAINTIFF");
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};

/** A complete recorded basis for one live item, with sentinel A values. */
const recordA = (live: Record<string, unknown>, over: Record<string, unknown> = {}, specOver: Record<string, unknown> = {}) => {
  const item = { ...live, id: live.id as string };
  const b = JSON.parse(JSON.stringify(assembleBasis({
    item: item as never,
    dossier: buildRecommendationDossier(item as never, CONDITION, CHRONO, KASE),
    conditions: [CONDITION as never],
    chronology: CHRONO,
    kase: KASE,
    assumptions: ASSUMPTIONS,
  })));
  b.futureCareItemId = live.id;
  b.necessityNarrative = "NARRATIVE-A.";
  b.contradictions = ["CONTRADICTION-A"];
  b.missingPremises = ["UNKNOWN-A"];
  b.literature = [{ title: "LITERATURE-A", journal: null, year: null, authors: null, pmid: null, doi: null, studyType: "cohort", supports: "the recommendation", limitations: null }];
  b.probabilityBasis = { classification: "more likely than not", statement: "PROBABILITY-A.", factors: [{ label: "FACTOR-A", present: true }] };
  b.acceptedEvidence = { ...b.acceptedEvidence, objectiveFindings: [{ text: "EVIDENCE-A", source: "RECORD-A" }] };
  b.projectionBasis = { ...b.projectionBasis, pricingSourceId: "PRICING-A" };
  b.assessmentBasis = {
    ...b.assessmentBasis,
    inclusionInTotalsStatus: "included",
    potentialChallenges: ["CHALLENGE-A"],
    confidenceLevel: "CONFIDENCE-A",
    confidenceLevelExplanation: "CONFIDENCE-EXPLANATION-A.",
    residualUncertainty: "RESIDUAL-A",
    functionalBasis: { domain: "FUNCTION-A", limitation: "LIMITATION-A", source: null, quantified: false, relationship: "RELATION-A." },
    ...over,
  };
  b.specification = {
    ...b.specification,
    service: "SERVICE-A", supportingDiagnosis: "DIAGNOSIS-A", responsibleSpecialty: "SPECIALTY-A",
    cptCode: "10001", unitCost: 11111, lifetimeCost: 22222, presentValue: 33333, physicianStatus: "APPROVED",
    ...specOver,
  };
  return b;
};

beforeEach(() => { deps.bases = []; });

// ── A ───────────────────────────────────────────────────────────────────────

describe("A: membership, counts and totals follow the RECORD, not the live rows", () => {
  it("an item the record excludes stays out however the live row reads", async () => {
    const { goldenCase } = await import("./goldenFixture");
    const live = goldenCase().futureCareItems as unknown as Record<string, unknown>[];
    // The live rows are APPROVED and would be counted. The record says one of
    // them is a contingency — the inclusion decision the physician approved.
    deps.bases = live.map((l, i) =>
      recordA(l, { inclusionInTotalsStatus: i === 0 ? "contingency" : "included" }, { service: `SERVICE-A-${i}` }),
    );
    const text = await rendered();

    // Excluded by the record, so it does not appear in the schedule…
    const schedule = text.slice(text.indexOf("SERVICE-A-1"), text.indexOf("Sensitivity to Economic Assumptions"));
    expect(schedule).not.toContain("SERVICE-A-0");
    // …and the total is the single included item's recorded present value.
    expect(text).toContain("$33,333");
  });

  it("flipping every live status does not change what the record includes", async () => {
    const { goldenCase } = await import("./goldenFixture");
    const gc = goldenCase();
    const live = gc.futureCareItems as unknown as Record<string, unknown>[];
    deps.bases = live.map((l) => recordA(l));
    // Every live row is now REJECTED. The record still says included.
    for (const l of live) l.physicianStatus = "REJECTED";
    const text = await rendered();
    expect(text).toContain("SERVICE-A");
    // The endorsement column shows the RECORDED disposition.
    expect(text).not.toContain("not endorsed on physician review");
  });

  it("the low/high range is derived from the recorded expected value", async () => {
    const { goldenCase } = await import("./goldenFixture");
    const live = goldenCase().futureCareItems as unknown as Record<string, unknown>[];
    deps.bases = live.map((l) => recordA(l));
    // Live scenario columns are nonsense; the range must ignore them.
    for (const l of live) { l.lowCost = 777777; l.highCost = 888888; }
    const text = await rendered();
    expect(text).not.toContain("$777,777");
    expect(text).not.toContain("$888,888");
    // 33,333 × 0.85 and × 1.25, summed over the included set.
    const n = live.length;
    expect(text).toContain(`$${(Math.round(33333 * 0.85) * n).toLocaleString("en-US")}`);
    expect(text).toContain(`$${(Math.round(33333 * 1.25) * n).toLocaleString("en-US")}`);
  });
});

// ── B ───────────────────────────────────────────────────────────────────────

describe("B: every narrative field follows the record", () => {
  it("prints A's content and none of B's", async () => {
    const { goldenCase } = await import("./goldenFixture");
    const gc = goldenCase();
    const live = gc.futureCareItems as unknown as Record<string, unknown>[];
    deps.bases = live.map((l) => recordA(l));
    // Mutate every live field the report used to read.
    for (const l of live) {
      l.missingSupport = "SENTINEL-B-MISSING-SUPPORT";
      l.literatureSupport = "SENTINEL-B-LITERATURE";
      l.pricingSource = "SENTINEL-B-PRICING";
      l.category = "MISC";
    }
    for (const c of gc.conditions as unknown as Record<string, unknown>[]) {
      c.supportingRecords = "SENTINEL-B-RECORDS";
    }
    const text = await rendered();

    for (const s of ["NARRATIVE-A.", "PROBABILITY-A.", "CONTRADICTION-A", "UNKNOWN-A", "CHALLENGE-A", "CONFIDENCE-A", "LITERATURE-A", "EVIDENCE-A", "PRICING-A", "FUNCTION-A"]) {
      expect(text, `A value ${s}`).toContain(s);
    }
    for (const s of ["SENTINEL-B-MISSING-SUPPORT", "SENTINEL-B-LITERATURE", "SENTINEL-B-PRICING"]) {
      expect(text, `B value ${s}`).not.toContain(s);
    }
  });
});

// ── C ───────────────────────────────────────────────────────────────────────

describe("C: an incomplete basis says 'not recorded' and never reads the live row", () => {
  it.each([
    ["specification", (b: Record<string, unknown>) => { delete b.specification; }],
    ["projectionBasis", (b: Record<string, unknown>) => { delete b.projectionBasis; }],
    ["probabilityBasis", (b: Record<string, unknown>) => { delete b.probabilityBasis; }],
    ["assessmentBasis", (b: Record<string, unknown>) => { delete b.assessmentBasis; }],
    ["specification.service", (b: Record<string, unknown>) => { delete (b.specification as Record<string, unknown>).service; }],
  ])("removing %s never falls back to the live values", async (_label, mutate) => {
    const { goldenCase } = await import("./goldenFixture");
    const gc = goldenCase();
    const live = gc.futureCareItems as unknown as Record<string, unknown>[];
    deps.bases = live.map((l) => {
      const b = recordA(l);
      mutate(b);
      return b;
    });
    for (const l of live) l.service = "SENTINEL-B-SERVICE";

    const text = await rendered();
    expect(text).toContain("not recorded");
    // The live row is never consulted to cover the gap.
    expect(text).not.toContain("SENTINEL-B-SERVICE");
  });
});
