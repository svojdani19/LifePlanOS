// requirePermission — the centralized compatibility layer: a currently
// effective role-template assignment (canonical evaluator verdict) grants a
// legacy permission the seat role lacks; everything else keeps failing closed.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({
  headers: () => ({ get: () => null }),
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { requirePermission, requireCanonicalPermission, type TenantContext } from "@/lib/tenant";

function ctxWith(over: Partial<Record<string, unknown>> = {}): TenantContext {
  return {
    user: { id: "u1", role: "ATTORNEY_REVIEWER", name: "Test", email: "t@x" },
    firm: { id: "f1", isDemo: false, features: null },
    subscription: null,
    supportMode: false,
    ...over,
  } as unknown as TenantContext;
}

const plannerAssignmentAuthz = {
  userFirmId: "f1",
  legacyRole: "ATTORNEY_REVIEWER",
  assignments: [
    {
      builtInRole: "LIFE_CARE_PLANNER",
      status: "ACTIVE",
      caseId: null,
      officeId: null,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveUntil: null,
    },
  ],
  grants: [],
  credentials: [],
  firmFeatures: null,
  now: new Date(),
};

describe("requirePermission compatibility layer", () => {
  it("an effective LIFE_CARE_PLANNER assignment grants futurecare.edit on a seat that lacks it", () => {
    const ctx = ctxWith({ authz: plannerAssignmentAuthz });
    expect(() => requirePermission(ctx, "futurecare.edit")).not.toThrow();
    expect(() => requirePermission(ctx, "chronology.edit")).not.toThrow();
    expect(() => requirePermission(ctx, "records.upload")).not.toThrow();
  });

  it("the same assignment never grants physician review or firm administration", () => {
    const ctx = ctxWith({ authz: plannerAssignmentAuthz });
    expect(() => requirePermission(ctx, "physician.review")).toThrow();
    expect(() => requirePermission(ctx, "team.manage")).toThrow();
    expect(() => requirePermission(ctx, "billing.manage")).toThrow();
    expect(() => requirePermission(ctx, "firm.settings")).toThrow();
  });

  it("an attorney seat WITHOUT an assignment stays read-only — no authoring leak", () => {
    const ctx = ctxWith({
      authz: { ...plannerAssignmentAuthz, assignments: [] },
    });
    expect(() => requirePermission(ctx, "case.view")).not.toThrow();
    expect(() => requirePermission(ctx, "futurecare.edit")).toThrow();
    expect(() => requirePermission(ctx, "case.edit")).toThrow();
  });

  it("a REVOKED or future-dated assignment grants nothing", () => {
    for (const assignment of [
      { ...plannerAssignmentAuthz.assignments[0], status: "REVOKED" },
      { ...plannerAssignmentAuthz.assignments[0], effectiveFrom: new Date(Date.now() + 86_400_000) },
      { ...plannerAssignmentAuthz.assignments[0], effectiveUntil: new Date(Date.now() - 86_400_000) },
    ]) {
      const ctx = ctxWith({ authz: { ...plannerAssignmentAuthz, assignments: [assignment] } });
      expect(() => requirePermission(ctx, "futurecare.edit")).toThrow();
    }
  });

  it("a case-scoped assignment does not widen org-level checks (no caseId in view)", () => {
    const ctx = ctxWith({
      authz: {
        ...plannerAssignmentAuthz,
        assignments: [{ ...plannerAssignmentAuthz.assignments[0], caseId: "case-1" }],
      },
    });
    expect(() => requirePermission(ctx, "futurecare.edit")).toThrow();
  });

  it("platform-support mode stays observation-only regardless of assignments", () => {
    const ctx = ctxWith({ authz: plannerAssignmentAuthz, supportMode: true });
    expect(() => requirePermission(ctx, "case.view")).not.toThrow();
    expect(() => requirePermission(ctx, "futurecare.edit")).toThrow();
  });
});

// ── Physician Reviewer — assignment-based privileges through the same layer ──

const verifiedPhysicianCredential = {
  category: "PHYSICIAN",
  status: "ORG_VERIFIED",
  expiresAt: null,
};

const physicianAssignmentAuthz = {
  ...plannerAssignmentAuthz,
  assignments: [
    { ...plannerAssignmentAuthz.assignments[0], builtInRole: "PHYSICIAN_REVIEWER" },
  ],
  credentials: [verifiedPhysicianCredential],
};

describe("requirePermission — physician reviewer compatibility", () => {
  it("an effective org-wide PHYSICIAN_REVIEWER assignment (with verified credential) grants physician.review on a seat that lacks it", () => {
    const ctx = ctxWith({ authz: physicianAssignmentAuthz });
    expect(() => requirePermission(ctx, "physician.review")).not.toThrow();
  });

  it("the physician assignment never grants authoring, records, or administration", () => {
    const ctx = ctxWith({ authz: physicianAssignmentAuthz });
    expect(() => requirePermission(ctx, "futurecare.edit")).toThrow();
    expect(() => requirePermission(ctx, "chronology.edit")).toThrow();
    expect(() => requirePermission(ctx, "case.edit")).toThrow();
    expect(() => requirePermission(ctx, "records.upload")).toThrow();
    expect(() => requirePermission(ctx, "team.manage")).toThrow();
    expect(() => requirePermission(ctx, "billing.manage")).toThrow();
    expect(() => requirePermission(ctx, "precedents.manage")).toThrow();
  });

  it("without a verified PHYSICIAN credential the assignment grants no review authority (fail closed)", () => {
    const ctx = ctxWith({ authz: { ...physicianAssignmentAuthz, credentials: [] } });
    expect(() => requirePermission(ctx, "physician.review")).toThrow();
  });

  it("an expired credential is as good as none", () => {
    const ctx = ctxWith({
      authz: {
        ...physicianAssignmentAuthz,
        credentials: [{ ...verifiedPhysicianCredential, expiresAt: new Date(Date.now() - 86_400_000) }],
      },
    });
    expect(() => requirePermission(ctx, "physician.review")).toThrow();
  });
});

describe("requireCanonicalPermission — case-scoped physician evaluation", () => {
  const caseScoped = {
    ...physicianAssignmentAuthz,
    assignments: [
      { ...physicianAssignmentAuthz.assignments[0], caseId: "case-1" },
    ],
  };

  it("a case-scoped PHYSICIAN_REVIEWER assignment authorizes review on exactly that case", () => {
    const ctx = ctxWith({ authz: caseScoped });
    expect(() => requireCanonicalPermission(ctx, "physician.review", { caseId: "case-1" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "physician.review", { caseId: "case-2" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "physician.review")).toThrow();
  });

  it("a SELF_REPORTED credential never authorizes a physician decision", () => {
    const ctx = ctxWith({
      authz: { ...caseScoped, credentials: [{ ...verifiedPhysicianCredential, status: "SELF_REPORTED" }] },
    });
    expect(() => requireCanonicalPermission(ctx, "physician.review", { caseId: "case-1" })).toThrow();
  });

  it("platform-support mode may view but never decide", () => {
    const ctx = ctxWith({ authz: caseScoped, supportMode: true });
    expect(() => requireCanonicalPermission(ctx, "records.view", { caseId: "case-1" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "physician.review", { caseId: "case-1" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "report.attest", { caseId: "case-1" })).toThrow();
  });
});

// ── Vocational Expert — case-scoped, feature-gated, credential-gated ─────────

const VOC_FLAG_ON = { "report.vocational_assessment": true };

const vocationalCredential = {
  category: "VOCATIONAL",
  status: "ORG_VERIFIED",
  expiresAt: null,
};

const vocationalCaseScopedAuthz = {
  ...plannerAssignmentAuthz,
  assignments: [
    { ...plannerAssignmentAuthz.assignments[0], builtInRole: "VOCATIONAL_EXPERT", caseId: "case-8" },
  ],
  credentials: [vocationalCredential],
  firmFeatures: VOC_FLAG_ON,
};

describe("requireCanonicalPermission — vocational expert evaluation", () => {
  it("a case-scoped VOCATIONAL_EXPERT assignment authorizes vocational work on exactly that case", () => {
    const ctx = ctxWith({ authz: vocationalCaseScopedAuthz, firm: { id: "f1", isDemo: false, features: VOC_FLAG_ON } });
    expect(() => requireCanonicalPermission(ctx, "vocational.view", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.edit", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.attest", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.edit", { caseId: "case-9" })).toThrow();
  });

  it("the vocational feature flag gates viewing, editing, and attestation alike", () => {
    const ctx = ctxWith({ authz: { ...vocationalCaseScopedAuthz, firmFeatures: {} } });
    expect(() => requireCanonicalPermission(ctx, "vocational.view", { caseId: "case-8" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.edit", { caseId: "case-8" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.attest", { caseId: "case-8" })).toThrow();
  });

  it("vocational.attest requires a verified VOCATIONAL credential — SELF_REPORTED or expired never signs", () => {
    for (const credentials of [
      [],
      [{ ...vocationalCredential, status: "SELF_REPORTED" }],
      [{ ...vocationalCredential, expiresAt: new Date(Date.now() - 86_400_000) }],
      [{ ...vocationalCredential, category: "PHYSICIAN" }],
    ]) {
      const ctx = ctxWith({ authz: { ...vocationalCaseScopedAuthz, credentials } });
      expect(() => requireCanonicalPermission(ctx, "vocational.attest", { caseId: "case-8" })).toThrow();
    }
  });

  it("the assignment never confers physician, economist, planner, QA, or administrative authority", () => {
    const ctx = ctxWith({ authz: vocationalCaseScopedAuthz });
    for (const p of ["physician.review", "economic.edit", "economic.attest", "futurecare.edit", "causation.edit", "costs.edit", "qa.review", "team.manage", "credentials.verify", "audit.view"]) {
      expect(() => requireCanonicalPermission(ctx, p, { caseId: "case-8" })).toThrow();
    }
  });

  it("platform-support mode may view vocational data but never edit or attest", () => {
    const ctx = ctxWith({ authz: vocationalCaseScopedAuthz, supportMode: true });
    expect(() => requireCanonicalPermission(ctx, "vocational.view", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.edit", { caseId: "case-8" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "vocational.attest", { caseId: "case-8" })).toThrow();
  });
});

// ── Forensic Economist — case-scoped, feature-gated, credential-gated ────────

const ECON_FLAG_ON = { "report.forensic_economist": true };

const economistCredential = {
  category: "ECONOMIST",
  status: "ORG_VERIFIED",
  expiresAt: null,
};

const economistCaseScopedAuthz = {
  ...plannerAssignmentAuthz,
  assignments: [
    { ...plannerAssignmentAuthz.assignments[0], builtInRole: "FORENSIC_ECONOMIST", caseId: "case-8" },
  ],
  credentials: [economistCredential],
  firmFeatures: ECON_FLAG_ON,
};

describe("requireCanonicalPermission — forensic economist evaluation", () => {
  it("a case-scoped FORENSIC_ECONOMIST assignment authorizes economic work on exactly that case", () => {
    const ctx = ctxWith({ authz: economistCaseScopedAuthz });
    expect(() => requireCanonicalPermission(ctx, "economic.view", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.edit", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.attest", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.edit", { caseId: "case-9" })).toThrow();
  });

  it("the economist feature flag gates viewing, editing, and attestation alike", () => {
    const ctx = ctxWith({ authz: { ...economistCaseScopedAuthz, firmFeatures: {} } });
    expect(() => requireCanonicalPermission(ctx, "economic.view", { caseId: "case-8" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.edit", { caseId: "case-8" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.attest", { caseId: "case-8" })).toThrow();
  });

  it("economic.attest requires a verified ECONOMIST credential — missing, self-reported, expired, or wrong-category never signs", () => {
    for (const credentials of [
      [],
      [{ ...economistCredential, status: "SELF_REPORTED" }],
      [{ ...economistCredential, expiresAt: new Date(Date.now() - 86_400_000) }],
      [{ ...economistCredential, category: "VOCATIONAL" }],
      [{ ...economistCredential, category: "PHYSICIAN" }],
    ]) {
      const ctx = ctxWith({ authz: { ...economistCaseScopedAuthz, credentials } });
      expect(() => requireCanonicalPermission(ctx, "economic.attest", { caseId: "case-8" })).toThrow();
    }
  });

  it("the assignment never confers planner, physician, vocational, QA, or administrative authority", () => {
    const ctx = ctxWith({ authz: economistCaseScopedAuthz });
    for (const p of ["physician.review", "vocational.edit", "vocational.attest", "futurecare.edit", "causation.edit", "costs.edit", "chronology.edit", "records.upload", "qa.review", "team.manage", "credentials.verify", "audit.view"]) {
      expect(() => requireCanonicalPermission(ctx, p, { caseId: "case-8" })).toThrow();
    }
  });

  it("platform-support mode may view economic data but never edit or attest", () => {
    const ctx = ctxWith({ authz: economistCaseScopedAuthz, supportMode: true });
    expect(() => requireCanonicalPermission(ctx, "economic.view", { caseId: "case-8" })).not.toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.edit", { caseId: "case-8" })).toThrow();
    expect(() => requireCanonicalPermission(ctx, "economic.attest", { caseId: "case-8" })).toThrow();
  });
});
