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

// ONE mutable case, shared by every mocked reader.
//
// The previous version of this file called goldenCase() inside each mock, so
// every read returned a FRESH object — and the tests mutated a throwaway copy.
// The B sentinels never reached the mocked database, so the negative
// assertions passed without ever being tested. `assertLiveHas` below exists so
// that can never silently recur: each test proves the mutation is visible
// through the mock before it renders anything.
const deps = vi.hoisted(() => ({ bases: [] as unknown[], db: null as unknown as Record<string, unknown>, basisFindings: [] as { result: string }[] }));

vi.mock("@/lib/db", async () => {
  const { GOLDEN_CASE_ID } = await import("./goldenFixture");
  const live = () => deps.db as Record<string, unknown>;
  return {
    prisma: {
      case: { findUniqueOrThrow: async () => live(), findFirst: async () => ({ id: GOLDEN_CASE_ID, firmId: "firm-golden" }) },
      clinicalReasoningAssessment: { findMany: async () => (live().clinicalReasoningAssessments as unknown[]) ?? [] },
      validationFinding: {
        findMany: async (args: { where?: { result?: { startsWith?: string } } }) =>
          args?.where?.result?.startsWith === "BASIS_" ? deps.basisFindings : [],
        count: async () => deps.basisFindings.length,
      },
      futureCareItem: { findMany: async () => live().futureCareItems as unknown[] },
      condition: { findMany: async () => live().conditions as unknown[] },
      attestation: { findMany: async () => live().attestations as unknown[] },
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

/** The one object every mocked reader returns. Mutate THIS. */
const liveItems = () => deps.db.futureCareItems as unknown as Record<string, unknown>[];
const liveConditions = () => deps.db.conditions as unknown as Record<string, unknown>[];

/**
 * Prove the mutation actually reached the mocked database.
 *
 * Without this a negative assertion can pass because the sentinel was never
 * stored — which is exactly how the earlier version of these tests reported
 * success while testing nothing.
 */
async function assertLiveHas(sentinel: string) {
  const { prisma } = await import("@/lib/db");
  const rows = await (prisma as unknown as { futureCareItem: { findMany: () => Promise<unknown[]> } }).futureCareItem.findMany();
  const conds = await (prisma as unknown as { condition: { findMany: () => Promise<unknown[]> } }).condition.findMany();
  const blob = JSON.stringify([rows, conds, deps.db]);
  expect(blob, `sentinel ${sentinel} must be visible through the mock before rendering`).toContain(sentinel);
}

beforeEach(async () => {
  deps.bases = [];
  deps.basisFindings = [];
  const { goldenCase, goldenAssessments } = await import("./goldenFixture");
  const gc = goldenCase() as unknown as Record<string, unknown>;
  gc.clinicalReasoningAssessments = goldenAssessments();
  deps.db = gc;
});

// ── A ───────────────────────────────────────────────────────────────────────

describe("A: membership, counts and totals follow the RECORD, not the live rows", () => {
  it("an item the record excludes stays out however the live row reads", async () => {
    const live = liveItems();
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
    const live = liveItems();
    deps.bases = live.map((l) => recordA(l));
    // Every live row is now REJECTED. The record still says included.
    for (const l of live) l.physicianStatus = "REJECTED";
    await assertLiveHas("REJECTED");
    const text = await rendered();
    expect(text).toContain("SERVICE-A");
    // The endorsement column shows the RECORDED disposition.
    expect(text).not.toContain("not endorsed on physician review");
  });

  it("the low/high range is derived from the recorded expected value", async () => {
    const live = liveItems();
    deps.bases = live.map((l) => recordA(l));
    // Live scenario columns are nonsense; the range must ignore them.
    for (const l of live) { l.lowCost = 777777; l.highCost = 888888; }
    await assertLiveHas("777777");
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
    const live = liveItems();
    deps.bases = live.map((l) => recordA(l));
    // Mutate every live field the report used to read.
    for (const l of live) {
      l.missingSupport = "SENTINEL-B-MISSING-SUPPORT";
      l.literatureSupport = "SENTINEL-B-LITERATURE";
      l.pricingSource = "SENTINEL-B-PRICING";
      l.category = "MISC";
    }
    for (const c of liveConditions()) {
      c.supportingRecords = "SENTINEL-B-RECORDS";
    }
    await assertLiveHas("SENTINEL-B-MISSING-SUPPORT");
    await assertLiveHas("SENTINEL-B-RECORDS");
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
    const live = liveItems();
    deps.bases = live.map((l) => {
      const b = recordA(l);
      mutate(b);
      return b;
    });
    for (const l of live) l.service = "SENTINEL-B-SERVICE";
    await assertLiveHas("SENTINEL-B-SERVICE");

    const text = await rendered();
    expect(text).toContain("not recorded");
    // The live row is never consulted to fill or select report content.
    //
    // Appendix F is excluded, and only Appendix F: it is the integrity CHECK
    // on the current record, it is now labelled as such, and naming the live
    // recommendation is the whole point of a checker. Everywhere the plan
    // speaks in its own voice, the live name must not appear.
    const body = text.slice(0, text.indexOf("Appendix F"));
    expect(body).not.toContain("SENTINEL-B-SERVICE");
    // And the appendix says which state it is describing.
    expect(text).toContain("reports the case as it stands NOW");
  });
});


// ── Draft rendering under an incomplete basis ───────────────────────────────

describe("the draft says which field is missing, and never prints B", () => {
  it("a basis with specification removed renders 'not recorded' and no live service", async () => {
    const live = liveItems();
    deps.bases = live.map((l) => {
      const b = recordA(l);
      delete (b as Record<string, unknown>).specification;
      return b;
    });
    for (const l of live) l.service = "SENTINEL-B-SERVICE";
    await assertLiveHas("SENTINEL-B-SERVICE");

    const text = await rendered();
    const body = text.slice(0, text.indexOf("Appendix F"));
    expect(body).toContain("not recorded");
    expect(body).not.toContain("SENTINEL-B-SERVICE");
  });

  it("a basis with assessmentBasis removed prints no live-derived clinical reasoning", async () => {
    const live = liveItems();
    deps.bases = live.map((l) => {
      const b = recordA(l);
      delete (b as Record<string, unknown>).assessmentBasis;
      return b;
    });
    // The live rows carry a distinctive residual-uncertainty string that the
    // witness derivation would surface if the report re-derived reasoning.
    for (const l of live) l.missingSupport = "SENTINEL-B-REASONING";
    await assertLiveHas("SENTINEL-B-REASONING");

    const text = await rendered();
    const body = text.slice(0, text.indexOf("Appendix F"));
    expect(body).not.toContain("SENTINEL-B-REASONING");
  });

  it("the integrity appendix lists the recorded-basis findings rather than claiming none", async () => {
    // Appendix F must never announce "no integrity issues" while a basis
    // finding is open. It is fed from persisted findings, which this mock
    // returns empty — so the assertion is on the labelling that makes the
    // distinction visible.
    deps.bases = liveItems().map((l) => recordA(l));
    const text = await rendered();
    expect(text).toContain("Appendix F — Life Care Plan Integrity Check (current record)");
    expect(text).toContain("reports the case as it stands NOW");
  });
});

describe("the draft banner distinguishes the four basis states", () => {
  const bannerFor = async (results: string[]) => {
    deps.basisFindings = results.map((r) => ({ result: r }));
    return rendered();
  };

  it("says NO RECORDED BASIS only for BASIS_MISSING", async () => {
    const t = await bannerFor(["BASIS_MISSING:i-1:none->abc"]);
    expect(t).toContain("WITH NO RECORDED BASIS");
    expect(t).not.toContain("RECORDED BASIS IS INCOMPLETE");
  });

  it("says the basis no longer matches for BASIS_STALE", async () => {
    expect(await bannerFor(["BASIS_STALE:i-1:aaa->bbb"])).toContain("NO LONGER MATCHES THE RECORD");
  });

  it("says incomplete, and what a reader will see, for BASIS_INCOMPLETE", async () => {
    const t = await bannerFor(["BASIS_INCOMPLETE:i-1:deadbeef"]);
    expect(t).toContain("RECORDED BASIS IS INCOMPLETE");
    expect(t).toContain("NOT RECORDED");
  });

  it("says nothing was read for BASIS_UNREADABLE", async () => {
    expect(await bannerFor(["BASIS_UNREADABLE"])).toContain("COULD NOT BE READ AT ALL");
  });

  it("names each kind when several are open", async () => {
    const t = await bannerFor(["BASIS_MISSING:i-1:none->a", "BASIS_INCOMPLETE:i-2:beef"]);
    expect(t).toContain("WITH NO RECORDED BASIS");
    expect(t).toContain("RECORDED BASIS IS INCOMPLETE");
  });

  it("an open blocking basis finding alone makes the document a draft", async () => {
    // isDraft required the live integrity engine to be blocking too, so a
    // BASIS_INCOMPLETE finding could stand while the document rendered clean.
    const t = await bannerFor(["BASIS_INCOMPLETE:i-1:deadbeef"]);
    expect(t).toContain("DRAFT");
  });
});
