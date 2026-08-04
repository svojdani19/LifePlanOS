import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// All DB access is mocked — these tests never touch a database.
vi.mock("@/lib/db", () => ({
  prisma: {
    userRoleAssignment: { findMany: vi.fn(), count: vi.fn() },
    caseEngagement: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  accessibleCaseIds,
  externalOnlyCaseIds,
  isPlatformAdminAssignment,
  rolesWithPermission,
  templatesWithPermission,
  type CaseScopeContext,
} from "./caseScope";

const assignmentFindMany = prisma.userRoleAssignment.findMany as unknown as Mock;
const assignmentCount = prisma.userRoleAssignment.count as unknown as Mock;
const engagementFindMany = prisma.caseEngagement.findMany as unknown as Mock;

const ctx = (role: string): CaseScopeContext =>
  ({ user: { id: "u1", role }, firm: { id: "f1" } }) as CaseScopeContext;

beforeEach(() => {
  vi.clearAllMocks();
  assignmentFindMany.mockResolvedValue([]);
  assignmentCount.mockResolvedValue(0);
  engagementFindMany.mockResolvedValue([]);
});

describe("accessibleCaseIds", () => {
  it("grants firm-wide access to firm-staff legacy roles", async () => {
    const access = await accessibleCaseIds(ctx("PLANNER"), {
      firmWideRoles: ["ADMIN", "PLANNER"],
      assignmentTemplates: ["LIFE_CARE_PLANNER"],
    });
    expect(access).toEqual({ allowed: true, cases: "all", platformAdminReadOnly: false });
    // Firm-wide verdicts never need the engagement query.
    expect(engagementFindMany).not.toHaveBeenCalled();
  });

  it("returns the explicit case list for caseId-scoped assignments", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: "c1", builtInRole: "VOCATIONAL_EXPERT" },
      { caseId: "c2", builtInRole: "VOCATIONAL_EXPERT" },
      { caseId: "c9", builtInRole: "READ_ONLY_OBSERVER" }, // irrelevant template
    ]);
    const access = await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), {
      firmWideRoles: ["ADMIN"],
      assignmentTemplates: ["VOCATIONAL_EXPERT"],
      engagementSlots: ["assignedVocationalExpertId"],
    });
    expect(access.allowed).toBe(true);
    expect(access.cases).toEqual(["c1", "c2"]);
    expect(access.platformAdminReadOnly).toBe(false);
  });

  it("derives access from engagement slots naming the user", async () => {
    engagementFindMany.mockResolvedValue([{ caseId: "c7" }]);
    const access = await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), {
      firmWideRoles: ["ADMIN"],
      assignmentTemplates: ["FORENSIC_ECONOMIST"],
      engagementSlots: ["assignedEconomistId"],
    });
    expect(access.allowed).toBe(true);
    expect(access.cases).toEqual(["c7"]);
    // The engagement query targets exactly the requested slot, non-cancelled.
    const where = engagementFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ assignedEconomistId: "u1" }]);
    expect(where.status).toEqual({ notIn: ["CANCELLED"] });
    expect(where.firmId).toBe("f1");
  });

  it("unions assignment grants and engagement slots without duplicates", async () => {
    assignmentFindMany.mockResolvedValue([{ caseId: "c1", builtInRole: "VOCATIONAL_EXPERT" }]);
    engagementFindMany.mockResolvedValue([{ caseId: "c1" }, { caseId: "c2" }]);
    const access = await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), {
      assignmentTemplates: ["VOCATIONAL_EXPERT"],
      engagementSlots: ["assignedVocationalExpertId"],
    });
    expect(access.cases).toEqual(["c1", "c2"]);
  });

  it("physician surface (/physician and /review share this exact configuration): case-scoped assignment + assignedPhysicianId engagement, nothing wider", async () => {
    assignmentFindMany.mockResolvedValue([{ caseId: "c3", builtInRole: "PHYSICIAN_REVIEWER" }]);
    engagementFindMany.mockResolvedValue([{ caseId: "c4" }]);
    const access = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: rolesWithPermission("physician.review"),
      assignmentTemplates: templatesWithPermission("physician.review"),
      orgWideAssignmentGrantsAll: true,
      engagementSlots: ["assignedPhysicianId"],
    });
    expect(access.allowed).toBe(true);
    expect(access.cases).toEqual(["c3", "c4"]);
    expect(engagementFindMany.mock.calls[0][0].where.OR).toEqual([{ assignedPhysicianId: "u1" }]);
  });

  it("vocational surface (case-scoped policy): an org-scoped VOCATIONAL_EXPERT assignment never widens to firm-wide — access is exactly the assigned + engaged cases", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: null, builtInRole: "VOCATIONAL_EXPERT" }, // org-scoped (malformed for this policy)
      { caseId: "c8", builtInRole: "VOCATIONAL_EXPERT" },
    ]);
    engagementFindMany.mockResolvedValue([{ caseId: "c9" }]);
    const access = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: rolesWithPermission("vocational.view"),
      assignmentTemplates: templatesWithPermission("vocational.view"),
      orgWideAssignmentGrantsAll: false, // the /vocational surface's setting
      engagementSlots: ["assignedVocationalExpertId"],
    });
    expect(access.allowed).toBe(true);
    expect(access.cases).toEqual(["c8", "c9"]);
    expect(engagementFindMany.mock.calls[0][0].where.OR).toEqual([{ assignedVocationalExpertId: "u1" }]);
    // Cancelled engagements are excluded at the query.
    expect(engagementFindMany.mock.calls[0][0].where.status).toEqual({ notIn: ["CANCELLED"] });
  });

  it("economist surface (case-scoped policy): org-scoped FORENSIC_ECONOMIST assignments never widen to firm-wide — access is exactly the assigned + engaged cases", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: null, builtInRole: "FORENSIC_ECONOMIST" }, // org-scoped (malformed for this policy)
      { caseId: "c5", builtInRole: "FORENSIC_ECONOMIST" },
    ]);
    engagementFindMany.mockResolvedValue([{ caseId: "c8" }]);
    const access = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: rolesWithPermission("economic.view"),
      assignmentTemplates: templatesWithPermission("economic.view"),
      orgWideAssignmentGrantsAll: false, // the /economist surface's setting
      engagementSlots: ["assignedEconomistId"],
    });
    expect(access.allowed).toBe(true);
    expect(access.cases).toEqual(["c5", "c8"]);
    expect(engagementFindMany.mock.calls[0][0].where.OR).toEqual([{ assignedEconomistId: "u1" }]);
    expect(engagementFindMany.mock.calls[0][0].where.status).toEqual({ notIn: ["CANCELLED"] });
  });

  it("treats an org-scoped assignment as firm-wide only when the surface allows it", async () => {
    assignmentFindMany.mockResolvedValue([{ caseId: null, builtInRole: "QUALITY_ASSURANCE_REVIEWER" }]);
    const internal = await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), {
      firmWideRoles: ["ADMIN"],
      assignmentTemplates: ["QUALITY_ASSURANCE_REVIEWER"],
      orgWideAssignmentGrantsAll: true,
      engagementSlots: ["assignedQaReviewerId"],
    });
    expect(internal.cases).toBe("all");

    const external = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: [],
      assignmentTemplates: ["QUALITY_ASSURANCE_REVIEWER"],
      orgWideAssignmentGrantsAll: false,
      engagementSlots: [],
    });
    expect(external.allowed).toBe(false); // org-wide grant not honored here
  });

  it("queries only ACTIVE, unexpired assignments (expired excluded at the source)", async () => {
    await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), { assignmentTemplates: ["VOCATIONAL_EXPERT"] });
    const where = assignmentFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("ACTIVE");
    expect(where.userId).toBe("u1");
    expect(where.firmId).toBe("f1");
    // Unexpired = no effectiveUntil, or effectiveUntil still in the future.
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ effectiveUntil: null });
    expect(where.OR[1].effectiveUntil.gte).toBeInstanceOf(Date);
  });

  it("denies when nothing grants access", async () => {
    const access = await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), {
      firmWideRoles: ["ADMIN"],
      assignmentTemplates: ["QUALITY_ASSURANCE_REVIEWER"],
    });
    expect(access).toEqual({ allowed: false, cases: [], platformAdminReadOnly: false });
  });

  it("grants a platform-admin assignment read-only firm-wide view as a last resort", async () => {
    assignmentCount.mockResolvedValue(1);
    const access = await accessibleCaseIds(ctx("PHYSICIAN_REVIEWER"), {
      firmWideRoles: ["ADMIN"],
      assignmentTemplates: ["QUALITY_ASSURANCE_REVIEWER"],
    });
    expect(access).toEqual({ allowed: true, cases: "all", platformAdminReadOnly: true });
    expect(assignmentCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: "u1", status: "ACTIVE", builtInRole: "PLATFORM_SYSTEM_ADMINISTRATOR" }),
    });
  });

  it("never marks firm staff as platform-admin read-only", async () => {
    assignmentCount.mockResolvedValue(1); // also a platform admin — irrelevant
    const access = await accessibleCaseIds(ctx("ADMIN"), { firmWideRoles: ["ADMIN"] });
    expect(access).toEqual({ allowed: true, cases: "all", platformAdminReadOnly: false });
  });

  it("guest rule: caseId-scoped external-class grants override a firm-staff seat role", async () => {
    // A client seated as ATTORNEY_REVIEWER whose only grants are case-scoped
    // ATTORNEY_CLIENT assignments must NOT inherit firm-wide access.
    assignmentFindMany.mockResolvedValue([{ caseId: "c3", builtInRole: "ATTORNEY_CLIENT" }]);
    const access = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: ["ADMIN", "ATTORNEY_REVIEWER"],
      assignmentTemplates: ["ATTORNEY_CLIENT"],
      engagementSlots: [],
    });
    expect(access.cases).toEqual(["c3"]);
  });

  it("does not let an organization-scoped external grant widen a guest seat", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: "c3", builtInRole: "ATTORNEY_CLIENT" },
      { caseId: null, builtInRole: "ATTORNEY_CLIENT" },
    ]);
    const access = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: ["ADMIN", "ATTORNEY_REVIEWER"],
      assignmentTemplates: ["ATTORNEY_CLIENT"],
      engagementSlots: [],
    });
    expect(access.cases).toEqual(["c3"]);
  });

  it("does not apply the guest rule when the user also holds an internal role", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: "c3", builtInRole: "ATTORNEY_CLIENT" },
      { caseId: null, builtInRole: "LIFE_CARE_PLANNER" },
    ]);
    const access = await accessibleCaseIds(ctx("ATTORNEY_REVIEWER"), {
      firmWideRoles: ["ADMIN", "ATTORNEY_REVIEWER"],
      assignmentTemplates: ["ATTORNEY_CLIENT"],
      engagementSlots: [],
    });
    expect(access.cases).toBe("all");
  });
});

describe("externalOnlyCaseIds", () => {
  it("returns null for firm staff (no assignments)", async () => {
    expect(await externalOnlyCaseIds(ctx("PLANNER"))).toBeNull();
  });

  it("keeps organization-scoped external grants restricted", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: "c1", builtInRole: "READ_ONLY_OBSERVER" },
      { caseId: null, builtInRole: "READ_ONLY_OBSERVER" },
    ]);
    expect(await externalOnlyCaseIds(ctx("ATTORNEY_REVIEWER"))).toEqual(["c1"]);
  });

  it("returns null when any assignment is an internal role", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: "c1", builtInRole: "READ_ONLY_OBSERVER" },
      { caseId: null, builtInRole: "LIFE_CARE_PLANNER" },
    ]);
    expect(await externalOnlyCaseIds(ctx("ATTORNEY_REVIEWER"))).toBeNull();
  });

  it("returns the shared case list for a pure guest, including engagement slots", async () => {
    assignmentFindMany.mockResolvedValue([
      { caseId: "c1", builtInRole: "READ_ONLY_OBSERVER" },
      { caseId: "c2", builtInRole: "INSURANCE_CLIENT" },
    ]);
    engagementFindMany.mockResolvedValue([{ caseId: "c2" }, { caseId: "c4" }]);
    expect(await externalOnlyCaseIds(ctx("ATTORNEY_REVIEWER"))).toEqual(["c1", "c2", "c4"]);
  });

  it("never treats an ADMIN as a guest", async () => {
    assignmentFindMany.mockResolvedValue([{ caseId: "c1", builtInRole: "READ_ONLY_OBSERVER" }]);
    expect(await externalOnlyCaseIds(ctx("ADMIN"))).toBeNull();
  });
});

describe("isPlatformAdminAssignment", () => {
  it("is true only for an ACTIVE platform-admin assignment", async () => {
    assignmentCount.mockResolvedValue(0);
    expect(await isPlatformAdminAssignment("u1")).toBe(false);
    assignmentCount.mockResolvedValue(2);
    expect(await isPlatformAdminAssignment("u1")).toBe(true);
  });
});

describe("permission-derived role and template lists", () => {
  it("maps vocational.view to the staff roles and templates that hold it", () => {
    expect(rolesWithPermission("vocational.view").sort()).toEqual(["ADMIN", "PLANNER"]);
    expect(templatesWithPermission("vocational.view").sort()).toEqual([
      "FIRM_ADMINISTRATOR",
      "FORENSIC_ECONOMIST",
      "LIFE_CARE_PLANNER",
      "VOCATIONAL_EXPERT",
    ]);
  });

  it("keeps PHYSICIAN_REVIEWER out of vocational, economic, and qa surfaces", () => {
    for (const key of ["vocational.view", "economic.view", "qa.review"]) {
      expect(rolesWithPermission(key)).not.toContain("PHYSICIAN_REVIEWER");
      expect(templatesWithPermission(key)).not.toContain("PHYSICIAN_REVIEWER");
    }
  });

  it("maps qa.review and physician.review to their expected holders", () => {
    expect(rolesWithPermission("qa.review")).toEqual(["ADMIN"]);
    expect(rolesWithPermission("physician.review").sort()).toEqual(["ADMIN", "PHYSICIAN_REVIEWER"]);
    expect(templatesWithPermission("qa.review").sort()).toEqual([
      "FIRM_ADMINISTRATOR",
      "QUALITY_ASSURANCE_REVIEWER",
    ]);
  });
});
