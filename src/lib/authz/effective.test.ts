// Effective legacy permissions — the single compatibility layer translating
// currently effective role-template assignments into the legacy permission
// vocabulary the existing interface and routes consume, plus the case-view
// presentation classification.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ assignmentFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { userRoleAssignment: { findMany: db.assignmentFindMany } },
}));

import {
  effectiveLegacyPermissions,
  effectiveAssignmentTemplates,
  legacyPermissionsForTemplates,
  isAttorneyPresentation,
  isAttorneyPresentationForCase,
} from "./effective";
import { ROLE_PERMISSIONS } from "@/lib/rbac";

beforeEach(() => {
  vi.clearAllMocks();
  db.assignmentFindMany.mockResolvedValue([]);
});

describe("legacyPermissionsForTemplates (pure translation)", () => {
  it("LIFE_CARE_PLANNER translates to the full planner authoring set", () => {
    const perms = legacyPermissionsForTemplates(["LIFE_CARE_PLANNER"]);
    for (const p of ["case.view", "case.create", "case.edit", "records.upload", "chronology.edit", "futurecare.edit", "report.export", "precedents.manage"]) {
      expect(perms).toContain(p);
    }
  });

  it("LIFE_CARE_PLANNER never grants physician, billing, team, or firm administration", () => {
    const perms = legacyPermissionsForTemplates(["LIFE_CARE_PLANNER"]);
    expect(perms).not.toContain("physician.review");
    expect(perms).not.toContain("billing.manage");
    expect(perms).not.toContain("team.manage");
    expect(perms).not.toContain("firm.settings");
    expect(perms).not.toContain("audit.view");
  });

  it("PHYSICIAN_REVIEWER translates to review + export, never authoring or administration", () => {
    const perms = legacyPermissionsForTemplates(["PHYSICIAN_REVIEWER"]);
    for (const p of ["case.view", "physician.review", "report.export"]) expect(perms).toContain(p);
    for (const p of [
      "case.create", "case.edit", "case.delete", "records.upload", "chronology.edit",
      "futurecare.edit", "precedents.manage", "team.manage", "billing.manage",
      "firm.settings", "audit.view",
    ]) {
      expect(perms).not.toContain(p);
    }
  });

  it("attorney-client template stays read-oriented — no clinical authoring", () => {
    const perms = legacyPermissionsForTemplates(["ATTORNEY_CLIENT"]);
    expect(perms).not.toContain("futurecare.edit");
    expect(perms).not.toContain("chronology.edit");
  });

  it("VOCATIONAL_EXPERT translates to case viewing only — no authoring, review, or administration in the legacy vocabulary", () => {
    const perms = legacyPermissionsForTemplates(["VOCATIONAL_EXPERT"]);
    expect(perms).toContain("case.view");
    for (const p of [
      "case.create", "case.edit", "case.delete", "records.upload", "chronology.edit",
      "futurecare.edit", "physician.review", "precedents.manage", "team.manage",
      "billing.manage", "firm.settings", "audit.view",
    ]) {
      expect(perms).not.toContain(p);
    }
  });

  it("FORENSIC_ECONOMIST translates to case viewing only — no authoring, review, or administration in the legacy vocabulary", () => {
    const perms = legacyPermissionsForTemplates(["FORENSIC_ECONOMIST"]);
    expect(perms).toContain("case.view");
    for (const p of [
      "case.create", "case.edit", "case.delete", "records.upload", "chronology.edit",
      "futurecare.edit", "physician.review", "precedents.manage", "team.manage",
      "billing.manage", "firm.settings", "audit.view",
    ]) {
      expect(perms).not.toContain(p);
    }
  });

  it("unknown template keys translate to nothing", () => {
    expect(legacyPermissionsForTemplates(["NOT_A_TEMPLATE"])).toEqual([]);
  });
});

describe("effectiveAssignmentTemplates (server-derived)", () => {
  it("returns the applicable template keys under the same scope rules as the permission union", async () => {
    db.assignmentFindMany.mockResolvedValue([{ builtInRole: "VOCATIONAL_EXPERT" }, { builtInRole: "VOCATIONAL_EXPERT" }]);
    const keys = await effectiveAssignmentTemplates({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER", caseId: "case-8" });
    expect(keys).toEqual(["VOCATIONAL_EXPERT"]);
    const where = db.assignmentFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("ACTIVE");
    expect(where.officeId).toBeNull();
    expect(where.OR).toEqual([{ caseId: null }, { caseId: "case-8" }]);
  });
});

describe("effectiveLegacyPermissions (server-derived)", () => {
  it("a legacy PLANNER seat keeps its full planner set with no assignments", async () => {
    const perms = await effectiveLegacyPermissions({ userId: "u1", firmId: "f1", role: "PLANNER" });
    expect(perms).toEqual([...ROLE_PERMISSIONS.PLANNER].sort());
  });

  it("an assignment-based LIFE_CARE_PLANNER on a non-planner seat receives the same authoring set", async () => {
    db.assignmentFindMany.mockResolvedValue([{ builtInRole: "LIFE_CARE_PLANNER" }]);
    const perms = await effectiveLegacyPermissions({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER", caseId: "c1" });
    for (const p of ROLE_PERMISSIONS.PLANNER) expect(perms).toContain(p);
  });

  it("scope is enforced in the assignment query: ACTIVE, effective window, office-unscoped, org-wide or this case", async () => {
    await effectiveLegacyPermissions({ userId: "u1", firmId: "f1", role: "PARALEGAL", caseId: "case-9" });
    const where = db.assignmentFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("ACTIVE");
    expect(where.officeId).toBeNull();
    expect(where.OR).toEqual([{ caseId: null }, { caseId: "case-9" }]);
    expect(where.effectiveFrom.lte).toBeInstanceOf(Date);
    expect(where.AND[0].OR).toEqual([{ effectiveUntil: null }, { effectiveUntil: { gt: expect.any(Date) } }]);
  });

  it("without a caseId, only org-wide assignments are consulted — a case-scoped grant never widens org-level checks", async () => {
    await effectiveLegacyPermissions({ userId: "u1", firmId: "f1", role: "PARALEGAL" });
    const where = db.assignmentFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ caseId: null }]);
  });

  it("an assignment-based PHYSICIAN_REVIEWER gains the review set without planner authoring", async () => {
    db.assignmentFindMany.mockResolvedValue([{ builtInRole: "PHYSICIAN_REVIEWER" }]);
    const perms = await effectiveLegacyPermissions({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER", caseId: "c1" });
    expect(perms).toContain("physician.review");
    expect(perms).not.toContain("futurecare.edit");
    expect(perms).not.toContain("case.edit");
  });

  it("never trusts client input — permissions derive from the DB rows only", async () => {
    db.assignmentFindMany.mockResolvedValue([]);
    const perms = await effectiveLegacyPermissions({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER" });
    expect(perms).toEqual([...ROLE_PERMISSIONS.ATTORNEY_REVIEWER].sort());
    expect(perms).not.toContain("futurecare.edit");
  });
});

describe("isAttorneyPresentation (case-view classification)", () => {
  it("an attorney seat without clinical authoring gets the attorney presentation", () => {
    expect(isAttorneyPresentation("ATTORNEY_REVIEWER", [...ROLE_PERMISSIONS.ATTORNEY_REVIEWER])).toBe(true);
  });

  it("a planner-assigned user on an attorney seat gets the normal clinical view", () => {
    expect(isAttorneyPresentation("ATTORNEY_REVIEWER", ["case.view", "futurecare.edit", "chronology.edit"])).toBe(false);
  });

  it("a physician-assigned user on an attorney seat gets the clinical view — independent review needs the evidence", () => {
    expect(isAttorneyPresentation("ATTORNEY_REVIEWER", ["case.view", "physician.review", "report.export"])).toBe(false);
  });

  it("a vocational-expert-assigned user on an attorney seat gets the clinical view — restrictions must trace to clinical sources", () => {
    expect(isAttorneyPresentation("ATTORNEY_REVIEWER", ["case.view", "report.export"], ["VOCATIONAL_EXPERT"])).toBe(false);
    // Without the specialist template, the same seat keeps the attorney presentation.
    expect(isAttorneyPresentation("ATTORNEY_REVIEWER", ["case.view", "report.export"], ["ATTORNEY_CLIENT"])).toBe(true);
  });

  it("a forensic-economist-assigned user on an attorney seat gets the clinical view — the loss analysis needs the actual cost data", () => {
    expect(isAttorneyPresentation("ATTORNEY_REVIEWER", ["case.view", "report.export"], ["FORENSIC_ECONOMIST"])).toBe(false);
  });

  it("legacy planner and physician seats never get the attorney presentation", () => {
    expect(isAttorneyPresentation("PLANNER", [...ROLE_PERMISSIONS.PLANNER])).toBe(false);
    expect(isAttorneyPresentation("PHYSICIAN_REVIEWER", [...ROLE_PERMISSIONS.PHYSICIAN_REVIEWER])).toBe(false);
  });

  it("firm administrators keep the attorney presentation", () => {
    expect(isAttorneyPresentation("ADMIN", [...ROLE_PERMISSIONS.ADMIN])).toBe(true);
  });
});

describe("isAttorneyPresentationForCase (server-side attorney-allowance gate)", () => {
  it("a genuine attorney seat keeps the attorney contribution paths", async () => {
    db.assignmentFindMany.mockResolvedValue([{ builtInRole: "ATTORNEY_CLIENT" }]);
    await expect(
      isAttorneyPresentationForCase({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER", caseId: "c1" }),
    ).resolves.toBe(true);
  });

  it("a vocational expert on an attorney seat never inherits the attorney allowances (intake/upload/deposition paths)", async () => {
    db.assignmentFindMany.mockResolvedValue([{ builtInRole: "VOCATIONAL_EXPERT" }]);
    await expect(
      isAttorneyPresentationForCase({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER", caseId: "c1" }),
    ).resolves.toBe(false);
  });

  it("a forensic economist on an attorney seat never inherits the attorney allowances either", async () => {
    db.assignmentFindMany.mockResolvedValue([{ builtInRole: "FORENSIC_ECONOMIST" }]);
    await expect(
      isAttorneyPresentationForCase({ userId: "u1", firmId: "f1", role: "ATTORNEY_REVIEWER", caseId: "c1" }),
    ).resolves.toBe(false);
  });

  it("non-attorney seats are never the attorney presentation here — admins use their own permissions", async () => {
    await expect(
      isAttorneyPresentationForCase({ userId: "u1", firmId: "f1", role: "ADMIN", caseId: "c1" }),
    ).resolves.toBe(false);
    expect(db.assignmentFindMany).not.toHaveBeenCalled();
  });
});
