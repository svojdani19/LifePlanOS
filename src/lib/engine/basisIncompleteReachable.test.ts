// BASIS_INCOMPLETE must actually be produced, persisted and enforced.
//
// The earlier "reachability" tests called assessBasisCompleteness and
// incompleteBasisFinding directly and regex-read validation.ts. That proves the
// pieces exist, not that anything reaches them. These call validateCase and the
// export route.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

const db = vi.hoisted(() => ({ bases: [] as unknown[], items: [] as unknown[] }));
const routeDeps = vi.hoisted(() => ({ openBlocking: 0, findings: [] as { service: string; result: string; issue: string; suggestion: string; exportBlocking: boolean }[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    futureCareItem: { findMany: vi.fn(async () => db.items) },
    condition: { findMany: vi.fn(async () => [{ id: "c-1", name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED", evidenceSources: [] }]) },
    case: { updateMany: vi.fn(async () => ({ count: 1 })), findUniqueOrThrow: vi.fn(async () => { throw new Error("no snapshot"); }), findUnique: vi.fn(async () => ({ id: "case-1", dateOfBirth: new Date("1969-04-12"), sex: "FEMALE", lifeExpectancyYears: 30, lifeExpectancyBasis: null, specialty: null, additionalSpecialties: [], discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1 })) },
    chronologyEvent: { findMany: vi.fn(async () => []) },
    interviewFinding: { findMany: vi.fn(async () => []) },
    document: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    recommendationBasis: { findMany: vi.fn(async () => db.bases) },
    basisReconciliation: { findMany: vi.fn(async () => []) },
    recommendationEvidence: { findMany: vi.fn(async () => []) },
    validationFinding: { findMany: vi.fn(async () => routeDeps.findings), createMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : ops)),
    reportExport: { count: vi.fn(async () => 0), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "exp-1", version: 1, ...data })), findMany: vi.fn(async () => []) },
    caseSnapshot: { create: vi.fn(async () => ({})) },
  },
}));

import { assembleBasis } from "@/lib/engine/basisAssembly";
import { buildRecommendationDossier, type DossierCondition } from "@/lib/engine/medicalNecessity";
import { validateCase } from "@/lib/engine/validation";
import { isIncompleteBasisFinding, decodeIncompleteFinding } from "@/lib/engine/basisCompleteness";

const COND = { id: "c-1", name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED", evidenceSources: [] } as unknown as DossierCondition & { id: string };
const ITEM = {
  id: "item-1", caseId: "case-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY",
  specialty: "Orthopedic surgery", probability: "PROBABLE", frequencyPerYear: 1, durationYears: 1,
  isLifetime: false, unitCost: 42000, annualCost: 42000, lifetimeCost: 42000, presentValue: 38000,
  lowCost: 32300, highCost: 47500, cptCode: "27447", physicianStatus: "APPROVED",
  supportClass: "RECORD_RECOMMENDED", conditionId: "c-1", pricingSource: "CMS fee schedule",
  contingencyOnly: false, supersededAt: null, confidence: 80, evidenceStrength: "MODERATE",
  defenseVulnerability: "LOW", condition: { id: "c-1", name: COND.name },
};

const fullBasis = () =>
  JSON.parse(JSON.stringify(assembleBasis({
    item: ITEM as never,
    dossier: buildRecommendationDossier(ITEM as never, COND, [], { subject: "the patient", pronounPoss: "the patient's", lifeExpectancyYears: 30, adult: true }),
    conditions: [COND as never],
    chronology: [],
    kase: { subject: "the patient", pronounPoss: "the patient's", lifeExpectancyYears: 30, adult: true },
    assumptions: { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1, conditionName: COND.name },
  })));

beforeEach(() => {
  vi.clearAllMocks();
  db.items = [ITEM];
  db.bases = [];
});

describe("validateCase raises it for a partial persisted basis", () => {
  it.each([
    ["specification", "specification"],
    ["projectionBasis", "projectionBasis"],
    ["probabilityBasis", "probabilityBasis"],
    ["assessmentBasis", "assessmentBasis"],
  ])("removing %s produces a blocking BASIS_INCOMPLETE naming that path", async (drop, expectedPath) => {
    const b = fullBasis();
    delete b[drop];
    db.bases = [b];

    const v = await validateCase("case-1");
    const finding = v.findings.find((f) => isIncompleteBasisFinding(f.result));
    expect(finding, `no BASIS_INCOMPLETE when ${drop} is missing`).toBeTruthy();
    expect(finding!.exportBlocking).toBe(true);
    expect(finding!.severity).toBe("Critical");
    expect(finding!.issue).toContain(expectedPath);
    expect(decodeIncompleteFinding(finding!.result)!.futureCareItemId).toBe("item-1");
  });

  it("a nested field produces the exact dotted path", async () => {
    const b = fullBasis();
    delete b.specification.frequencyText;
    db.bases = [b];
    const f = (await validateCase("case-1")).findings.find((x) => isIncompleteBasisFinding(x.result))!;
    expect(f.issue).toContain("specification.frequencyText");
  });

  it("a COMPLETE basis raises no incompleteness finding", async () => {
    db.bases = [fullBasis()];
    const v = await validateCase("case-1");
    expect(v.findings.filter((f) => isIncompleteBasisFinding(f.result))).toHaveLength(0);
  });

  it("no basis at all raises BASIS_MISSING, not BASIS_INCOMPLETE", async () => {
    db.bases = [];
    const v = await validateCase("case-1");
    expect(v.findings.filter((f) => isIncompleteBasisFinding(f.result))).toHaveLength(0);
    expect(v.findings.some((f) => f.result.startsWith("BASIS_MISSING"))).toBe(true);
  });

  it("the whole case reports blocking when one item's basis is partial", async () => {
    const b = fullBasis();
    delete b.assessmentBasis;
    db.bases = [b];
    expect((await validateCase("case-1")).blocking).toBe(true);
  });
});

// ── The export route ────────────────────────────────────────────────────────

vi.mock("@/lib/engine/validation", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    persistCaseValidation: vi.fn(async () => ({ blocking: routeDeps.openBlocking > 0, findings: routeDeps.findings, counts: {} })),
    openBlockingCount: vi.fn(async () => routeDeps.openBlocking),
    unreconciledBasisDivergences: vi.fn(async () => []),
  };
});
vi.mock("@/lib/tenant", () => ({
  TenantError: class TenantError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) { super(message); }
  },
  requireApiContext: vi.fn(async () => ({ user: { id: "u-1", role: "ADMIN" }, firm: { id: "firm-1" } })),
  requirePermission: vi.fn(),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
  audit: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/export/report", () => ({ buildReportDocx: vi.fn(), buildCostCsv: vi.fn() }));
vi.mock("@/lib/export/pdf", () => ({ convertDocxToPdf: vi.fn() }));
vi.mock("@/lib/engine/clinicalReasoningPersist", () => ({ persistCaseReasoning: vi.fn(async () => null) }));
vi.mock("@/lib/engine/snapshot", () => ({ buildSnapshotPayload: vi.fn(() => ({})) }));
vi.mock("@/lib/engine/generate", () => ({ assumptionsFor: vi.fn(() => ({})) }));
vi.mock("@/lib/storage", () => ({ putObject: vi.fn(async () => "key-1") }));
vi.mock("@/lib/reports/professionalAuthority", () => ({ evaluatePhysicianReportAuthority: vi.fn(async () => ({ authorized: true })) }));

describe("the export route refuses a final release on it", () => {
  const req = (body: unknown) => new Request("http://t/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const params = { params: Promise.resolve({ caseId: "case-1" }) };

  beforeEach(() => {
    routeDeps.openBlocking = 1;
    routeDeps.findings = [{ service: "Total knee arthroplasty", result: "BASIS_INCOMPLETE:item-1:deadbeef", issue: "missing projectionBasis", suggestion: "Regenerate", exportBlocking: true }];
  });

  it.each(["DOCX", "PDF"])("422s a final %s", async (format) => {
    const { POST } = await import("@/app/api/cases/[caseId]/export/route");
    const res = await POST(req({ format, mode: "final" }), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.blocking).toBe(true);
    expect(JSON.stringify(body.defects)).toContain("BASIS_INCOMPLETE");
  });

  it("creates no artifact when it refuses", async () => {
    const { buildReportDocx } = await import("@/lib/export/report");
    const { POST } = await import("@/app/api/cases/[caseId]/export/route");
    await POST(req({ format: "DOCX", mode: "final" }), params);
    expect(buildReportDocx).not.toHaveBeenCalled();
  });

  it("permits a draft", async () => {
    const { buildReportDocx } = await import("@/lib/export/report");
    (buildReportDocx as Mock).mockResolvedValue({ buffer: Buffer.from("d"), totalLifetime: 1, totalPresentValue: 1, itemCount: 1 });
    const { POST } = await import("@/app/api/cases/[caseId]/export/route");
    const res = await POST(req({ format: "DOCX", mode: "draft" }), params);
    expect(res.status).toBe(200);
  });
});


describe("malformed elements reach validateCase and block the real export", () => {
  const MALFORMED: [string, (b: Record<string, unknown>) => void, string][] = [
    ["probabilityBasis.factors=[null]", (b) => { (b.probabilityBasis as Record<string, unknown>).factors = [null]; }, "probabilityBasis.factors[0]"],
    ["acceptedEvidence.objectiveFindings=[null]", (b) => { (b.acceptedEvidence as Record<string, unknown>).objectiveFindings = [null]; }, "acceptedEvidence.objectiveFindings[0]"],
    ["literature=[null]", (b) => { b.literature = [null]; }, "literature[0]"],
    ["contradictions=[object]", (b) => { b.contradictions = [{ x: 1 }]; }, "contradictions[0]"],
    ["invalid inclusion status", (b) => { (b.assessmentBasis as Record<string, unknown>).inclusionInTotalsStatus = "maybe"; }, "assessmentBasis.inclusionInTotalsStatus<value>"],
    ["invalid serviceFamily", (b) => { b.serviceFamily = "NOPE"; }, "serviceFamily<value>"],
    ["NaN unit cost", (b) => { (b.specification as Record<string, unknown>).unitCost = NaN; }, "specification.unitCost<type>"],
  ];

  it.each(MALFORMED)("validateCase raises blocking BASIS_INCOMPLETE for %s", async (_label, mutate, expectedPath) => {
    const b = fullBasis();
    mutate(b);
    db.bases = [b];

    const v = await validateCase("case-1");
    const f = v.findings.find((x) => isIncompleteBasisFinding(x.result));
    expect(f, `no finding for ${_label}`).toBeTruthy();
    expect(f!.exportBlocking).toBe(true);
    expect(f!.issue, expectedPath).toContain(expectedPath);
    expect(v.blocking).toBe(true);
  });
});

describe("the export route refuses on a REAL malformed-element result", () => {
  // Not a hand-constructed finding: validateCase runs for real and its output
  // drives the gate, with only external authority and storage mocked.
  it("422s a final DOCX when a persisted basis holds a null literature row", async () => {
    const b = fullBasis();
    b.literature = [null];
    db.bases = [b];

    // Confirm the real validator produces the blocking finding first.
    const v = await validateCase("case-1");
    const real = v.findings.filter((f) => f.exportBlocking && isIncompleteBasisFinding(f.result));
    expect(real.length).toBeGreaterThan(0);
    expect(real[0].issue).toContain("literature[0]");

    // Feed exactly that through the gate.
    routeDeps.findings = real.map((f) => ({ service: f.service, result: f.result, issue: f.issue, suggestion: f.suggestion, exportBlocking: true }));
    routeDeps.openBlocking = real.length;

    const { POST } = await import("@/app/api/cases/[caseId]/export/route");
    const res = await POST(
      new Request("http://t/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "DOCX", mode: "final" }) }),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body.defects)).toContain("BASIS_INCOMPLETE");
    expect(JSON.stringify(body.defects)).toContain("literature[0]");
  });
});


describe("the guideline and scalar classes reach validateCase and the real gate", () => {
  const CLASSES: [string, (b: Record<string, unknown>) => void, string][] = [
    ["supportingGuidelineAssessments=[null]", (b) => { (b.assessmentBasis as Record<string, unknown>).supportingGuidelineAssessments = [null]; }, "assessmentBasis.supportingGuidelineAssessments[0]"],
    ["acceptedEvidence.guidelines=[null]", (b) => { (b.acceptedEvidence as Record<string, unknown>).guidelines = [null]; }, "acceptedEvidence.guidelines[0]"],
    ["alternativesConsidered=[null]", (b) => { (b.assessmentBasis as Record<string, unknown>).alternativesConsidered = [null]; }, "assessmentBasis.alternativesConsidered[0]"],
    ["invalid physicianStatus", (b) => { (b.specification as Record<string, unknown>).physicianStatus = "SORT_OF"; }, "specification.physicianStatus<value>"],
    ["Infinity presentValue", (b) => { (b.specification as Record<string, unknown>).presentValue = Infinity; }, "specification.presentValue<type>"],
    ["NaN projection frequency", (b) => { (b.projectionBasis as Record<string, unknown>).frequencyPerYear = NaN; }, "projectionBasis.frequencyPerYear<type>"],
  ];

  it.each(CLASSES)("validateCase names the exact path for %s", async (_label, mutate, expected) => {
    const b = fullBasis();
    mutate(b);
    db.bases = [b];
    const v = await validateCase("case-1");
    const f = v.findings.find((x) => isIncompleteBasisFinding(x.result));
    expect(f, _label).toBeTruthy();
    expect(f!.exportBlocking).toBe(true);
    expect(f!.issue, expected).toContain(expected);
  });

  it("says missing OR malformed, because these are not absent", async () => {
    const b = fullBasis();
    (b.specification as Record<string, unknown>).presentValue = NaN;
    db.bases = [b];
    const f = (await validateCase("case-1")).findings.find((x) => isIncompleteBasisFinding(x.result))!;
    expect(f.issue).toMatch(/missing or malformed/i);
    expect(f.issue).toMatch(/wrong type/i);
  });

  it("the real gate 422s a final DOCX for a malformed guideline element", async () => {
    const b = fullBasis();
    (b.assessmentBasis as Record<string, unknown>).supportingGuidelineAssessments = [null];
    db.bases = [b];

    const v = await validateCase("case-1");
    const real = v.findings.filter((f) => f.exportBlocking && isIncompleteBasisFinding(f.result));
    expect(real.length).toBeGreaterThan(0);
    expect(real[0].issue).toContain("assessmentBasis.supportingGuidelineAssessments[0]");

    routeDeps.findings = real.map((f) => ({ service: f.service, result: f.result, issue: f.issue, suggestion: f.suggestion, exportBlocking: true }));
    routeDeps.openBlocking = real.length;

    const { POST } = await import("@/app/api/cases/[caseId]/export/route");
    const res = await POST(
      new Request("http://t/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "DOCX", mode: "final" }) }),
      { params: Promise.resolve({ caseId: "case-1" }) },
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify((await res.json()).defects)).toContain("supportingGuidelineAssessments[0]");
  });
});
