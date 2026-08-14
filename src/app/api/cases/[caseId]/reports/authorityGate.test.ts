// Report Library route — physician-required FINALS must pass the central
// professional-authority gate (same contract as the legacy expert report),
// drafts stay available, custom reports inherit the requirement through their
// sections, and a blocked attempt stores nothing and advances nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const deps = vi.hoisted(() => ({
  audit: vi.fn(),
  recordUsage: vi.fn(),
  evaluate: vi.fn(),
  storeAndRecord: vi.fn(),
  loadReportData: vi.fn(),
  caseUpdateMany: vi.fn(),
  // Factual-review gate inputs (source-grounded pipeline).
  extractedEncounterFindMany: vi.fn(async () => [] as unknown[]),
  chronologyEventFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    case: { updateMany: deps.caseUpdateMany, findUnique: vi.fn(), findFirst: vi.fn() },
    caseSnapshot: {
      aggregate: vi.fn(async () => ({ _max: { version: null } })),
      create: vi.fn(),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    reportExport: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      update: vi.fn(),
    },
    reportApproval: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    validationFinding: { findMany: vi.fn(async () => []), aggregate: vi.fn(async () => ({ _max: { createdAt: null } })), count: vi.fn(async () => 0) },
    futureCareItem: { findMany: vi.fn(async () => []) },
    economicAssumption: { findMany: vi.fn(async () => []) },
    economicScenario: { findMany: vi.fn(async () => []) },
    vocationalEntry: { findMany: vi.fn(async () => []) },
    // Factual-review gate (source-grounded pipeline): empty state = review
    // complete, so the authority-gate scenarios stay focused on authority.
    document: { findMany: vi.fn(async () => []) },
    recordExtraction: { findMany: vi.fn(async () => []) },
    extractedEncounter: { findMany: deps.extractedEncounterFindMany, count: vi.fn(async () => 0) },
    chronologyEvent: { findMany: deps.chronologyEventFindMany },
    sourcePage: { findMany: vi.fn(async () => [] as { status: string }[]) },
  },
}));
vi.mock("@/lib/tenant", () => ({
  TenantError: class TenantError extends Error {
    constructor(message: string, public code = "FORBIDDEN", public status = 403) { super(message); }
  },
  requireApiContext: vi.fn(async () => ({
    user: { id: "user-1", role: "ADMIN" },
    firm: { id: "firm-1", features: { "report.medical_necessity": true, "report.causation": true, "report.custom": true } },
  })),
  requirePermission: vi.fn(),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
  audit: deps.audit,
  recordUsage: deps.recordUsage,
}));
vi.mock("@/lib/engine/validation", () => ({
  persistCaseValidation: vi.fn(async () => ({ blocking: 0, findings: [], counts: {} })),
}));
vi.mock("@/lib/engine/snapshot", () => ({
  buildSnapshotPayload: vi.fn(() => ({})),
  diffSnapshots: vi.fn(() => ({})),
}));
vi.mock("@/lib/engine/generate", () => ({ assumptionsFor: vi.fn(() => ({})) }));
vi.mock("@/lib/reports/data", () => ({ loadReportData: deps.loadReportData }));
vi.mock("@/lib/reports/persist", () => ({
  storeAndRecord: deps.storeAndRecord,
  approvalStale: vi.fn(() => false),
  ExportRecordError: class ExportRecordError extends Error {},
}));
vi.mock("@/lib/reports/doc", () => ({
  renderDocx: vi.fn(async () => Buffer.from("docx")),
  renderHtml: vi.fn(() => "<html/>"),
  renderCsv: vi.fn(() => "csv"),
}));
vi.mock("@/lib/export/pdf", () => ({ convertDocxToPdf: vi.fn(async (b: Buffer) => b) }));
vi.mock("@/lib/reports/vocational", () => ({
  composeVocational: vi.fn(),
  vocationalReadiness: vi.fn(),
}));
vi.mock("@/lib/reports/economist", () => ({
  composeEconomist: vi.fn(),
  economistReadiness: vi.fn(),
}));
vi.mock("@/lib/reports/versionDiff", () => ({
  changesSection: vi.fn(() => []),
  isMaterialDiff: vi.fn(() => false),
}));
vi.mock("@/lib/reports/professionalAuthority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, evaluateProfessionalReportAuthority: deps.evaluate };
});
// Section composition is exercised by the report-library suites; here the
// composer is stubbed so only ROUTE enforcement is under test. Gating metadata
// (approval, deriveApproval, formats, flags) stays real.
vi.mock("@/lib/reports/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports/registry")>();
  return {
    ...actual,
    getReport: (id: string) => {
      const def = actual.getReport(id);
      return def ? { ...def, compose: () => ({ title: "stub", blocks: [] }) } : def;
    },
  };
});

import { POST } from "./route";

const AUTHORIZED = {
  authorized: true as const,
  attestationId: "att-1",
  signerUserId: "md-1",
  signerName: "Dr. Test, MD",
  signerCredentialSummary: null,
  statementText: "signed",
  signedAt: new Date(),
  contentHash: "h".repeat(64),
  attestedItemCount: 1,
  attestedPresentValue: 1000,
  includedFingerprint: "f1",
  includedItemIds: ["a"],
  includedCount: 1,
  includedPresentValue: 1000,
  includedLifetimeCost: 1200,
  clinicalFingerprint: "cf1",
  financialFingerprint: "ff1",
  reportFingerprint: "rf1",
  coveredScopes: ["FUTURE_CARE_MEDICAL_NECESSITY", "FREQUENCY_AND_DURATION"],
};

function reportData() {
  // Minimal shape the composers + route logic read. Content quality is not
  // under test — authority enforcement is.
  return {
    case: {
      id: "case-1",
      clientName: "Client",
      caseNumber: "C-1",
      dateOfInjury: null,
      dateOfBirth: null,
      futureCareItems: [
        { id: "a", physicianStatus: "APPROVED", presentValue: 1000, lifetimeCost: 1200, service: "svc", category: "PHYSICIAN_VISIT", probability: "PROBABLE" },
      ],
      conditions: [],
      documents: [],
      chronologyEvents: [],
      treatingProviders: [],
      interviewFindings: [],
    },
    assessments: [],
    transitions: [],
    integrity: { findings: [], counts: {} },
    includedIds: new Set(["a"]),
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/cases/case-1/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ caseId: "case-1" }) };

beforeEach(() => {
  Object.values(deps).forEach((fn) => fn.mockReset());
  deps.loadReportData.mockResolvedValue(reportData());
  deps.storeAndRecord.mockResolvedValue({ id: "exp-1", version: 1, createdAt: new Date() });
  deps.extractedEncounterFindMany.mockResolvedValue([]);
  deps.chronologyEventFindMany.mockResolvedValue([]);
});

describe("Report Library — physician-required finals use the central authority gate", () => {
  it("blocks a MEDICAL_NECESSITY final without authority: 422, PHI-free reasons, nothing stored, audited", async () => {
    deps.evaluate.mockResolvedValue({ authorized: false, reasons: ["NO_ACTIVE_ATTESTATION"], includedFingerprint: null });
    const res = await POST(req({ reportId: "MEDICAL_NECESSITY", format: "HTML", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.reasons).toEqual(["NO_ACTIVE_ATTESTATION"]);
    expect(JSON.stringify(body)).not.toMatch(/Client|C-1/);
    expect(deps.storeAndRecord).not.toHaveBeenCalled();
    expect(deps.caseUpdateMany).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.anything(),
      "export.final_denied",
      expect.objectContaining({ meta: expect.objectContaining({ reportType: "MEDICAL_NECESSITY" }) }),
    );
  });

  it("a CAUSATION_ANALYSIS final demands the CAUSATION opinion scope from the gate", async () => {
    deps.evaluate.mockResolvedValue({ authorized: false, reasons: ["OPINION_SCOPE_NOT_COVERED"], includedFingerprint: null });
    const res = await POST(req({ reportId: "CAUSATION_ANALYSIS", format: "HTML", mode: "final" }), params);
    expect(res.status).toBe(422);
    expect(deps.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ requiredScopes: expect.arrayContaining(["CAUSATION"]), reportKind: "CAUSATION_ANALYSIS" }),
    );
  });

  it("a CUSTOM report inherits physician authority when its sections require it", async () => {
    deps.evaluate.mockResolvedValue({ authorized: false, reasons: ["NO_ACTIVE_ATTESTATION"], includedFingerprint: null });
    const res = await POST(
      req({ reportId: "CUSTOM", format: "HTML", mode: "final", config: { sections: ["caseHeader", "medicalNecessity"] } }),
      params,
    );
    expect(res.status).toBe(422);
    expect(deps.evaluate).toHaveBeenCalled();
  });

  it("a factual supporting report (MEDICAL_CHRONOLOGY) exports final without professional authority", async () => {
    const res = await POST(req({ reportId: "MEDICAL_CHRONOLOGY", format: "HTML", mode: "final" }), params);
    expect(res.status).toBe(200);
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.storeAndRecord).toHaveBeenCalled();
  });

  it("a FINAL factual report is blocked until factual record review completes — never by physician authority", async () => {
    deps.extractedEncounterFindMany.mockResolvedValue([
      { status: "AI_DRAFT", encounterDate: null, page: null, dateStatus: "UNKNOWN", claims: [], warnings: [] },
    ]);
    const res = await POST(req({ reportId: "MEDICAL_RECORD_SUMMARY", format: "HTML", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.blockers.join(" ")).toMatch(/pending human review/);
    // The block is REVIEW completion, not a credential gate.
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.storeAndRecord).not.toHaveBeenCalled();
  });

  it("DRAFT factual reports stay available with unreviewed AI-draft content", async () => {
    deps.extractedEncounterFindMany.mockResolvedValue([
      { status: "AI_DRAFT", encounterDate: null, page: null, dateStatus: "UNKNOWN", claims: [], warnings: [] },
    ]);
    const res = await POST(req({ reportId: "MEDICAL_RECORD_SUMMARY", format: "HTML", mode: "draft" }), params);
    expect(res.status).toBe(200);
    expect(deps.storeAndRecord).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ draft: true }));
  });

  it("stale chronology events block the FINAL factual chronology export", async () => {
    deps.chronologyEventFindMany.mockResolvedValue([{ reviewStatus: "STALE", edited: false }]);
    const res = await POST(req({ reportId: "MEDICAL_CHRONOLOGY", format: "HTML", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.blockers.join(" ")).toMatch(/stale/i);
  });

  it("drafts of physician-required reports remain available without authority", async () => {
    const res = await POST(req({ reportId: "MEDICAL_NECESSITY", format: "HTML", mode: "draft" }), params);
    expect(res.status).toBe(200);
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.storeAndRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ draft: true }),
    );
  });

  it("authorized final stores; drift before recording fails closed with 409 and stores nothing", async () => {
    deps.evaluate
      .mockResolvedValueOnce(AUTHORIZED)
      .mockResolvedValueOnce({ ...AUTHORIZED, reportFingerprint: "rf-CHANGED" });
    const res = await POST(req({ reportId: "MEDICAL_NECESSITY", format: "HTML", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.reasons).toEqual(["PLAN_CHANGED_DURING_GENERATION"]);
    expect(deps.storeAndRecord).not.toHaveBeenCalled();
    expect(deps.caseUpdateMany).not.toHaveBeenCalled();
  });

  it("a stable authorized final succeeds end to end", async () => {
    deps.evaluate.mockResolvedValue(AUTHORIZED);
    const res = await POST(req({ reportId: "MEDICAL_NECESSITY", format: "HTML", mode: "final" }), params);
    expect(res.status).toBe(200);
    expect(deps.evaluate).toHaveBeenCalledTimes(2);
    expect(deps.storeAndRecord).toHaveBeenCalled();
  });


  it("AI_AUDIT_PASSED content still blocks a FINAL factual report — an automated audit is not a human review", async () => {
    deps.extractedEncounterFindMany.mockResolvedValue([
      { status: "AI_AUDIT_PASSED", auditResult: "PASS", encounterDate: null, page: null, dateStatus: "UNKNOWN", claims: [], warnings: [], verifiedContentHash: null },
    ]);
    const res = await POST(req({ reportId: "MEDICAL_RECORD_SUMMARY", format: "HTML", mode: "final" }), params);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.blockers.join(" ")).toMatch(/pending human review/);
    expect(body.blockers.join(" ")).toMatch(/automated audit is not a human review/);
  });
});
