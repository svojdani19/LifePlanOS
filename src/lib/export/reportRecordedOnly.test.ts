// Approve A, change the record to B, and prove the report still says A.
//
// The previous test for this asserted things about a basis OBJECT. That cannot
// catch the defect, because the defect was in the RENDERER: the heading came
// from the live row before the basis was even loaded, a recorded null fell
// through to the live diagnosis, a recorded null CPT let the live coding check
// print "Pending coding review", and a persisted assessment was preferred over
// the record on the strength of merely having content. Every one of those is
// invisible unless you read the rendered document.
//
// This builds the real DOCX twice — once as approved, once after the mutable
// rows have moved underneath it — and reads the text back out.

import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { assembleBasis } from "@/lib/engine/basisAssembly";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const KASE: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
const CONDITION = {
  id: "c-1",
  name: "Post-traumatic osteoarthritis of the right knee",
  relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing on weight-bearing radiographs",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss" }],
} as unknown as DossierCondition & { id: string };
const CHRONO: DossierChronoEvent[] = [
  { eventDate: "2024-08-01", imagingFindings: "MRI of the right knee: high-grade chondral loss", sourcePage: 4 } as never,
];

const APPROVED_ITEM = {
  id: "item-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", specialty: "Orthopedic surgery",
  probability: "PROBABLE", frequencyPerYear: 1, durationYears: null, isLifetime: false,
  unitCost: 42000, lifetimeCost: 42000, presentValue: 38000, cptCode: "27447",
  physicianStatus: "APPROVED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1",
  pricingSource: "CMS fee schedule", contingencyOnly: false,
  startTrigger: null, prerequisite: null, earliestTiming: null, replacesService: null,
};
const ASSUMPTIONS = {
  lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1.04,
  pricedAt: "2026-01-15T00:00:00.000Z", conditionName: CONDITION.name,
};

const basisFor = (item: Record<string, unknown>) =>
  assembleBasis({
    item: item as never,
    dossier: buildRecommendationDossier(item as never, CONDITION, CHRONO, KASE),
    conditions: [CONDITION as never],
    chronology: CHRONO,
    kase: KASE,
    assumptions: ASSUMPTIONS,
  });

describe("the recorded specification is what the document asserts", () => {
  const approved = basisFor(APPROVED_ITEM);

  it("records A's identity, coding and money", () => {
    expect(approved.specification).toMatchObject({
      service: "Total knee arthroplasty",
      supportingDiagnosis: CONDITION.name,
      responsibleSpecialty: "Orthopedic surgery",
      cptCode: "27447",
      unitCost: 42000,
      presentValue: 38000,
      physicianStatus: "APPROVED",
    });
  });

  it("a rename, a re-code and a re-price move the hash — the plan is a different plan", () => {
    // Each of these prints on the face of the report as a statement about this
    // recommendation, so each has to invalidate the approval.
    for (const mutation of [
      { service: "Unicompartmental knee replacement" },
      { cptCode: "27486" },
      { unitCost: 99000 },
      { presentValue: 250000 },
      { specialty: "Physical medicine and rehabilitation" },
      { physicianStatus: "PENDING" },
    ]) {
      const moved = basisFor({ ...APPROVED_ITEM, ...mutation });
      expect(moved.basisHash, JSON.stringify(mutation)).not.toBe(approved.basisHash);
    }
  });

  it("keeps A's values on the recorded object no matter what the live row becomes", () => {
    const after = basisFor({ ...APPROVED_ITEM, service: "Something else", unitCost: 1, presentValue: 2, cptCode: "99999" });
    // The recorded object is untouched — this is what the renderer reads.
    expect(approved.specification.service).toBe("Total knee arthroplasty");
    expect(approved.specification.unitCost).toBe(42000);
    expect(approved.specification.cptCode).toBe("27447");
    // And the divergence is detectable.
    expect(after.basisHash).not.toBe(approved.basisHash);
  });
});

describe("the renderer reads the record, and never falls through to the live row", () => {
  const read = async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    return readFileSync(join(__dirname, "report.ts"), "utf8");
  };

  it("the heading is rendered AFTER the basis loads, from the recorded service", async () => {
    const src = await read();
    const headingAt = src.indexOf("spec0 ? spec0.service : it.service");
    const basisAt = src.indexOf("const recordedBasis = basisByItem.get(it.id)");
    expect(headingAt).toBeGreaterThan(-1);
    expect(basisAt).toBeGreaterThan(-1);
    expect(headingAt).toBeGreaterThan(basisAt);
  });

  it("a recorded null renders as 'not recorded', never as the live value", async () => {
    const src = await read();
    expect(src).toMatch(/const NOT_RECORDED = "not recorded"/);
    // The specific fallbacks the review named are gone.
    expect(src).not.toMatch(/spec\.supportingDiagnosis \?\? dxName/);
    expect(src).not.toMatch(/\(spec \? spec\.cptCode : it\.cptCode\) \|\|/);
    expect(src).not.toMatch(/spec \? spec\.unitCost \?\? 0 : it\.unitCost/);
  });

  it("the recorded narrative is used even when it is empty", async () => {
    // `||` silently replaced a recorded-but-blank narrative with a fresh one.
    const src = await read();
    expect(src).not.toMatch(/recordedBasis\?\.necessityNarrative \|\| dossier\.medicalNecessity/);
    expect(src).toMatch(/recordedBasis \? recordedBasis\.necessityNarrative \?\? "" : dossier\.medicalNecessity/);
  });

  it("a persisted assessment is used only when it was computed from THIS basis", async () => {
    const src = await read();
    expect(src).toMatch(/persistedHash === recordedBasis\.basisHash/);
    // And never on the strength of merely having content.
    expect(src).not.toMatch(/const assessment = persisted\?\.inclusionRationale/);
  });
});

describe("a reasoning refresh failure cannot release a final report", () => {
  it("the export route captures the failure instead of swallowing it", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "cases", "[caseId]", "export", "route.ts"), "utf8");
    expect(src).not.toMatch(/persistCaseReasoning\([^)]*\)\.catch\(\(\) => null\)/);
    expect(src).toMatch(/REASONING_NOT_REFRESHED/);
  });
});

// ── The rendered document ───────────────────────────────────────────────────

const deps = vi.hoisted(() => ({ bases: [] as unknown[], items: [] as unknown[] }));

vi.mock("@/lib/db", async () => {
  const { goldenCase, goldenAssessments, GOLDEN_CASE_ID } = await import("./goldenFixture");
  return {
    prisma: {
      case: {
        findUniqueOrThrow: async () => goldenCase(),
        findFirst: async () => ({ id: GOLDEN_CASE_ID, firmId: "firm-golden" }),
      },
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
      retrievalAttempt: { findFirst: async () => null, findMany: async () => [] },
      economicAssumption: { findFirst: async () => null },
      vocationalEntry: { findMany: async () => [] },
      economicScenario: { findMany: async () => [] },
      reportApproval: { findFirst: async () => null },
      futureDamagesEvaluation: { findFirst: async () => null },
    },
  };
});

beforeEach(() => { deps.bases = []; });

describe("rendered output: A is printed, B is not", () => {
  /** Every visible text run in the rendered DOCX. */
  const renderedText = async (): Promise<string> => {
    const { buildReportDocx } = await import("./report");
    const { buffer } = await buildReportDocx("case-golden-lcp-0001", "PLAINTIFF");
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    // Strip every tag rather than matching <w:t> pairs: the run-level regex
    // swallowed table markup wherever an element nested unexpectedly, so the
    // "text" it produced was half XML.
    return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  };

  it("prints the RECORDED service and cost after the live row is changed underneath", async () => {
    const { goldenCase } = await import("./goldenFixture");
    const live = goldenCase().futureCareItems[0] as unknown as Record<string, unknown>;

    // Record a basis for the item AS APPROVED.
    const approvedItem = { ...live, id: live.id as string };
    const recorded = assembleBasis({
      item: approvedItem as never,
      dossier: buildRecommendationDossier(approvedItem as never, CONDITION, CHRONO, KASE),
      conditions: [CONDITION as never],
      chronology: CHRONO,
      kase: KASE,
      assumptions: ASSUMPTIONS,
    });
    // Freeze the approved values, then let the recorded row describe A while
    // the live fixture row keeps its own (different) values.
    deps.bases = [{
      ...recorded,
      futureCareItemId: live.id,
      specification: {
        ...recorded.specification,
        service: "RECORDED-SERVICE-A",
        supportingDiagnosis: "RECORDED-DIAGNOSIS-A",
        cptCode: "11111",
        unitCost: 12345,
        presentValue: 54321,
      },
    }];

    const text = await renderedText();

    // A prints, as this recommendation's heading and specification.
    expect(text).toContain("RECORDED-SERVICE-A");

    // Scoped to THIS recommendation's block. The cost schedule elsewhere in the
    // document legitimately lists live rows, so a whole-document search would
    // conflate the narrative section with the worksheet.
    const start = text.indexOf("RECORDED-SERVICE-A");
    const block = text.slice(start, start + 1600);
    expect(block).toContain("RECORDED-DIAGNOSIS-A");
    expect(block).toContain("11111");
    // B — the live row's own coding — does not speak for the recorded plan.
    expect(block).not.toContain(String(live.cptCode ?? "___never___"));
    expect(block).toContain("$12,345");
  });

  it("prints 'not recorded' for a recorded null instead of the live value", async () => {
    const { goldenCase } = await import("./goldenFixture");
    const live = goldenCase().futureCareItems[0] as unknown as Record<string, unknown>;
    const item = { ...live, id: live.id as string };
    const recorded = assembleBasis({
      item: item as never,
      dossier: buildRecommendationDossier(item as never, CONDITION, CHRONO, KASE),
      conditions: [CONDITION as never],
      chronology: CHRONO,
      kase: KASE,
      assumptions: ASSUMPTIONS,
    });
    deps.bases = [{
      ...recorded,
      futureCareItemId: live.id,
      specification: { ...recorded.specification, cptCode: null, supportingDiagnosis: null },
    }];

    const text = await renderedText();

    expect(text).toContain("not recorded");
    // The live coding check must not get to speak for the record.
    expect(text).not.toContain("Pending coding review");
  });
});
