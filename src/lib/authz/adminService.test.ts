import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// All DB access is mocked — these tests never touch a database.
vi.mock("@/lib/db", () => ({
  prisma: {
    firm: { update: vi.fn() },
    customRole: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customRolePermission: { createMany: vi.fn(), deleteMany: vi.fn() },
    roleVersion: { create: vi.fn() },
    userRoleAssignment: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    accessGrant: { updateMany: vi.fn() },
    user: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/db";
import { ALL_PERMISSION_KEYS } from "./registry";
import {
  AdminServiceError,
  ConflictError,
  DelegationError,
  archiveRole,
  assignRole,
  assertDelegable,
  bumpAuthzRevision,
  cloneRole,
  createCustomRole,
  expireSweep,
  impactAnalysis,
  legacyEffectiveKeys,
  revokeAssignment,
  roleMatrix,
  updateRolePermissions,
  type PermissionInput,
} from "./adminService";

const firmUpdate = prisma.firm.update as unknown as Mock;
const roleCreate = prisma.customRole.create as unknown as Mock;
const roleFindFirst = prisma.customRole.findFirst as unknown as Mock;
const roleFindMany = prisma.customRole.findMany as unknown as Mock;
const roleUpdate = prisma.customRole.update as unknown as Mock;
const roleUpdateMany = prisma.customRole.updateMany as unknown as Mock;
const permCreateMany = prisma.customRolePermission.createMany as unknown as Mock;
const permDeleteMany = prisma.customRolePermission.deleteMany as unknown as Mock;
const versionCreate = prisma.roleVersion.create as unknown as Mock;
const assignCreate = prisma.userRoleAssignment.create as unknown as Mock;
const assignFindFirst = prisma.userRoleAssignment.findFirst as unknown as Mock;
const assignFindMany = prisma.userRoleAssignment.findMany as unknown as Mock;
const assignUpdate = prisma.userRoleAssignment.update as unknown as Mock;
const assignUpdateMany = prisma.userRoleAssignment.updateMany as unknown as Mock;
const assignCount = prisma.userRoleAssignment.count as unknown as Mock;
const grantUpdateMany = prisma.accessGrant.updateMany as unknown as Mock;
const userFindFirst = prisma.user.findFirst as unknown as Mock;
const transaction = prisma.$transaction as unknown as Mock;

const ADMIN_KEYS = legacyEffectiveKeys("ADMIN");
const PARALEGAL_KEYS = legacyEffectiveKeys("PARALEGAL");

const allow = (key: string, scopeType?: PermissionInput["scopeType"]): PermissionInput => ({
  key,
  effect: "ALLOW",
  ...(scopeType ? { scopeType } : {}),
});
const den = (key: string): PermissionInput => ({ key, effect: "DENY" });

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  firmUpdate.mockResolvedValue({});
  roleCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "role-1", ...data }));
  permCreateMany.mockResolvedValue({ count: 1 });
  permDeleteMany.mockResolvedValue({ count: 1 });
  versionCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "rv-1", ...data }));
});

// ── legacyEffectiveKeys ──────────────────────────────────────────────────────

describe("legacyEffectiveKeys — legacy enum projected through its template", () => {
  it("projects ADMIN onto the Firm Administrator template's canonical keys", () => {
    expect(ADMIN_KEYS).toContain("team.manage");
    expect(ADMIN_KEYS).toContain("futurecare.edit");
    expect(ADMIN_KEYS).toContain("records.view"); // non-legacy key on the template
  });

  it("projects BILLING_USER onto billing keys only, and unknown roles onto nothing", () => {
    expect(legacyEffectiveKeys("BILLING_USER").sort()).toEqual(["billing.manage", "billing.view"]);
    expect(legacyEffectiveKeys("NOT_A_ROLE")).toEqual([]);
  });
});

// ── assertDelegable — the delegation ceiling ─────────────────────────────────

describe("assertDelegable — delegation ceiling", () => {
  it("accepts held, delegable, custom-role-assignable ALLOW keys", () => {
    expect(() => assertDelegable(ADMIN_KEYS, [allow("case.view"), allow("futurecare.edit")])).not.toThrow();
  });

  it("resolves aliases before checking heldness", () => {
    // recommendation.edit is an alias of futurecare.edit, which ADMIN holds.
    expect(() => assertDelegable(ADMIN_KEYS, [allow("recommendation.edit")])).not.toThrow();
  });

  it("rejects platform-only keys, naming the offender", () => {
    expect(() => assertDelegable(ADMIN_KEYS, [allow("featureflags.manage")])).toThrow(DelegationError);
    try {
      assertDelegable(ADMIN_KEYS, [allow("featureflags.manage")]);
    } catch (err) {
      expect((err as DelegationError).offenders).toEqual([
        { key: "featureflags.manage", reason: "platform-only" },
      ]);
      expect((err as DelegationError).message).toContain("featureflags.manage");
    }
  });

  it("rejects non-delegable keys even when the grantor holds them", () => {
    // ADMIN's template holds physician.review, but the key is delegable: false.
    try {
      assertDelegable(ADMIN_KEYS, [allow("physician.review")]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DelegationError).offenders[0]).toEqual({
        key: "physician.review",
        reason: "not delegable",
      });
    }
  });

  it("rejects keys the grantor does not hold", () => {
    // PARALEGAL (Case Manager template) holds costs.view but not costs.edit.
    try {
      assertDelegable(PARALEGAL_KEYS, [allow("costs.edit")]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DelegationError).offenders[0]).toEqual({
        key: "costs.edit",
        reason: "not held by grantor",
      });
    }
  });

  it("rejects keys that are not custom-role assignable, and unknown keys", () => {
    try {
      assertDelegable(ADMIN_KEYS, [allow("roles.create"), allow("no.such.key")]);
      expect.unreachable("should have thrown");
    } catch (err) {
      const offenders = (err as DelegationError).offenders;
      expect(offenders).toContainEqual({ key: "roles.create", reason: "not assignable to custom roles" });
      expect(offenders).toContainEqual({ key: "no.such.key", reason: "unknown permission key" });
    }
  });

  it("allows DENY entries for any valid non-platform key — held or not", () => {
    // A deny only restricts, so a paralegal-ceiling role may still deny keys
    // the grantor never held (billing.manage) or cannot delegate.
    expect(() => assertDelegable(PARALEGAL_KEYS, [den("billing.manage"), den("physician.review")])).not.toThrow();
  });

  it("still rejects DENY entries for platform-only or unknown keys", () => {
    expect(() => assertDelegable(ADMIN_KEYS, [den("platform.audit")])).toThrow(DelegationError);
    expect(() => assertDelegable(ADMIN_KEYS, [den("bogus.key")])).toThrow(DelegationError);
  });
});

// ── bumpAuthzRevision ────────────────────────────────────────────────────────

describe("bumpAuthzRevision", () => {
  it("increments Firm.authzRevision", async () => {
    await bumpAuthzRevision("firm-1");
    expect(firmUpdate).toHaveBeenCalledWith({
      where: { id: "firm-1" },
      data: { authzRevision: { increment: 1 } },
    });
  });
});

// ── createCustomRole ─────────────────────────────────────────────────────────

describe("createCustomRole", () => {
  const base = {
    firmId: "firm-1",
    actorId: "user-1",
    grantorPermissionKeys: ADMIN_KEYS,
    name: "Intake Specialist",
  };

  it("creates the role, its permission rows, and a version-1 snapshot, then bumps the revision", async () => {
    const result = await createCustomRole({
      ...base,
      permissions: [allow("case.view"), allow("records.upload"), den("billing.manage")],
      reason: "initial",
    });

    expect(roleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ firmId: "firm-1", name: "Intake Specialist", version: 1, status: "ACTIVE" }) }),
    );
    expect(permCreateMany).toHaveBeenCalledTimes(1);
    const rows = permCreateMany.mock.calls[0][0].data as Array<{ permissionKey: string; effect: string }>;
    expect(rows.map((r) => `${r.effect}:${r.permissionKey}`)).toEqual([
      "ALLOW:case.view",
      "ALLOW:records.upload",
      "DENY:billing.manage",
    ]);
    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 1,
          changedById: "user-1",
          changeReason: "initial",
          permissionSnapshot: expect.objectContaining({ reason: "initial" }),
        }),
      }),
    );
    expect(firmUpdate).toHaveBeenCalledTimes(1); // authz revision bumped
    expect(result.permissions).toHaveLength(3);
  });

  it("canonicalizes aliased keys in stored rows", async () => {
    await createCustomRole({ ...base, permissions: [allow("recommendation.edit")] });
    const rows = permCreateMany.mock.calls[0][0].data as Array<{ permissionKey: string }>;
    expect(rows[0].permissionKey).toBe("futurecare.edit");
  });

  it("maps a P2002 unique violation to a NAME_TAKEN conflict and does not bump the revision", async () => {
    roleCreate.mockRejectedValueOnce({ code: "P2002", meta: { target: ["firmId", "name"] } });
    await expect(createCustomRole({ ...base, permissions: [allow("case.view")] })).rejects.toMatchObject({
      code: "NAME_TAKEN",
      status: 409,
    });
    expect(firmUpdate).not.toHaveBeenCalled();
  });

  it("rejects a scope the registry does not permit for the key", async () => {
    // audit.view is ORGANIZATION-only.
    await expect(
      createCustomRole({ ...base, permissions: [allow("audit.view", "CASE")] }),
    ).rejects.toMatchObject({ code: "INVALID_SCOPE", status: 422 });
    expect(roleCreate).not.toHaveBeenCalled();
  });

  it("enforces the delegation ceiling before touching the database", async () => {
    await expect(
      createCustomRole({ ...base, permissions: [allow("organizations.manage")] }),
    ).rejects.toBeInstanceOf(DelegationError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

// ── cloneRole ────────────────────────────────────────────────────────────────

describe("cloneRole", () => {
  const base = { firmId: "firm-1", actorId: "user-1", grantorPermissionKeys: ADMIN_KEYS, name: "Clone" };

  it("clones a built-in template, dropping (and disclosing) keys outside the ceiling", async () => {
    const result = await cloneRole({ ...base, cloneFrom: "PHYSICIAN_REVIEWER" });

    const droppedKeys = result.droppedKeys.map((d) => d.key).sort();
    expect(droppedKeys).toEqual(["physician.review", "report.approve", "report.attest"]);
    expect(result.permissions.map((p) => p.key)).toContain("case.view");
    expect(result.permissions.map((p) => p.key)).not.toContain("report.attest");
    expect(roleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clonedFromSystemRole: "PHYSICIAN_REVIEWER" }) }),
    );
    expect(firmUpdate).toHaveBeenCalledTimes(1);
  });

  it("clones an existing custom role's rows", async () => {
    roleFindFirst.mockResolvedValueOnce({
      id: "src-1",
      firmId: "firm-1",
      clonedFromSystemRole: null,
      permissions: [
        { permissionKey: "case.view", effect: "ALLOW", scopeType: "ORGANIZATION", scopeConfig: null },
        { permissionKey: "billing.manage", effect: "DENY", scopeType: "ORGANIZATION", scopeConfig: null },
      ],
    });
    const result = await cloneRole({ ...base, cloneFrom: "src-1" });
    expect(result.droppedKeys).toEqual([]);
    expect(result.permissions.map((p) => `${p.effect}:${p.key}`)).toEqual([
      "ALLOW:case.view",
      "DENY:billing.manage",
    ]);
  });

  it("404s when the clone source is neither a template nor a firm role", async () => {
    roleFindFirst.mockResolvedValueOnce(null);
    await expect(cloneRole({ ...base, cloneFrom: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("refuses a clone the grantor's ceiling would empty out entirely", async () => {
    await expect(
      cloneRole({ ...base, grantorPermissionKeys: legacyEffectiveKeys("BILLING_USER"), cloneFrom: "CASE_MANAGER" }),
    ).rejects.toBeInstanceOf(DelegationError);
    expect(roleCreate).not.toHaveBeenCalled();
  });
});

// ── updateRolePermissions ────────────────────────────────────────────────────

describe("updateRolePermissions", () => {
  const existingRole = {
    id: "role-1",
    firmId: "firm-1",
    status: "ACTIVE",
    version: 3,
    permissions: [{ permissionKey: "case.view", effect: "ALLOW", scopeType: "ORGANIZATION", scopeConfig: null }],
  };
  const base = {
    firmId: "firm-1",
    roleId: "role-1",
    actorId: "user-1",
    grantorPermissionKeys: ADMIN_KEYS,
  };

  it("throws ConflictError on an expectedVersion mismatch", async () => {
    roleFindFirst.mockResolvedValueOnce(existingRole);
    await expect(
      updateRolePermissions({ ...base, expectedVersion: 2, permissions: [allow("case.view")], changeReason: "x" }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", expectedVersion: 2, actualVersion: 3 });
    expect(firmUpdate).not.toHaveBeenCalled();
  });

  it("refuses to modify an archived role", async () => {
    roleFindFirst.mockResolvedValueOnce({ ...existingRole, status: "ARCHIVED" });
    await expect(
      updateRolePermissions({ ...base, expectedVersion: 3, permissions: [allow("case.view")], changeReason: "x" }),
    ).rejects.toMatchObject({ code: "ROLE_ARCHIVED", status: 409 });
  });

  it("requires a changeReason for permission changes", async () => {
    roleFindFirst.mockResolvedValueOnce(existingRole);
    await expect(
      updateRolePermissions({ ...base, expectedVersion: 3, permissions: [allow("case.view")] }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED", status: 422 });
  });

  it("replaces rows, bumps the role version, snapshots, and bumps the revision", async () => {
    roleFindFirst.mockResolvedValueOnce(existingRole);
    roleUpdateMany.mockResolvedValueOnce({ count: 1 });

    const result = await updateRolePermissions({
      ...base,
      expectedVersion: 3,
      permissions: [allow("case.view"), allow("records.view")],
      changeReason: "add records read",
    });

    expect(roleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "role-1", firmId: "firm-1", version: 3 }, // compare-and-swap
        data: expect.objectContaining({ version: 4, updatedById: "user-1" }),
      }),
    );
    expect(permDeleteMany).toHaveBeenCalledWith({ where: { customRoleId: "role-1" } });
    expect(permCreateMany).toHaveBeenCalledTimes(1);
    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 4,
          changeReason: "add records read",
          permissionSnapshot: expect.objectContaining({ reason: "add records read" }),
        }),
      }),
    );
    expect(firmUpdate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ roleId: "role-1", version: 4 });
  });

  it("conflicts cleanly when a concurrent editor wins the compare-and-swap", async () => {
    roleFindFirst.mockResolvedValueOnce(existingRole);
    roleUpdateMany.mockResolvedValueOnce({ count: 0 }); // raced: version moved after the read
    await expect(
      updateRolePermissions({ ...base, expectedVersion: 3, permissions: [allow("case.view")], changeReason: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(firmUpdate).not.toHaveBeenCalled();
  });

  it("snapshots the EXISTING rows on a metadata-only rename", async () => {
    roleFindFirst.mockResolvedValueOnce(existingRole);
    roleUpdateMany.mockResolvedValueOnce({ count: 1 });
    await updateRolePermissions({ ...base, expectedVersion: 3, name: "Renamed" });
    expect(permDeleteMany).not.toHaveBeenCalled();
    const snapshot = versionCreate.mock.calls[0][0].data.permissionSnapshot as {
      permissions: Array<{ key: string }>;
    };
    expect(snapshot.permissions.map((p) => p.key)).toEqual(["case.view"]);
  });
});

// ── archiveRole ──────────────────────────────────────────────────────────────

describe("archiveRole", () => {
  it("archives (never deletes), snapshots, reports live assignments, bumps revision", async () => {
    roleFindFirst.mockResolvedValueOnce({
      id: "role-1",
      firmId: "firm-1",
      status: "ACTIVE",
      version: 2,
      permissions: [{ permissionKey: "case.view", effect: "ALLOW", scopeType: "ORGANIZATION", scopeConfig: null }],
    });
    assignCount.mockResolvedValueOnce(2);
    roleUpdate.mockResolvedValueOnce({});

    const result = await archiveRole({ firmId: "firm-1", roleId: "role-1", actorId: "user-1" });

    expect(roleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ARCHIVED", isAssignable: false, version: 3 }),
      }),
    );
    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 3 }) }),
    );
    expect(firmUpdate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ roleId: "role-1", version: 3, activeAssignments: 2 });
  });

  it("409s when the role is already archived", async () => {
    roleFindFirst.mockResolvedValueOnce({ id: "role-1", firmId: "firm-1", status: "ARCHIVED", version: 2, permissions: [] });
    await expect(archiveRole({ firmId: "firm-1", roleId: "role-1", actorId: "user-1" })).rejects.toMatchObject({
      code: "ROLE_ARCHIVED",
      status: 409,
    });
  });
});

// ── assignRole ───────────────────────────────────────────────────────────────

describe("assignRole", () => {
  const NOW = new Date("2026-07-27T12:00:00Z");
  const base = { firmId: "firm-1", actorId: "admin-1", userId: "user-2" };

  beforeEach(() => {
    userFindFirst.mockResolvedValue({ id: "user-2", firmId: "firm-1" });
    assignCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "a-1", ...data }));
  });

  it("requires exactly one of builtInRole / customRoleId", async () => {
    await expect(assignRole({ ...base }, NOW)).rejects.toMatchObject({ code: "ROLE_XOR_REQUIRED" });
    await expect(
      assignRole({ ...base, builtInRole: "CASE_MANAGER", customRoleId: "role-1" }, NOW),
    ).rejects.toMatchObject({ code: "ROLE_XOR_REQUIRED" });
  });

  it("rejects users outside the firm and unknown templates", async () => {
    userFindFirst.mockResolvedValueOnce(null);
    await expect(assignRole({ ...base, builtInRole: "CASE_MANAGER" }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assignRole({ ...base, builtInRole: "NOT_A_TEMPLATE" }, NOW)).rejects.toMatchObject({ code: "UNKNOWN_ROLE" });
  });

  it("never assigns the platform operator role to a firm user", async () => {
    await expect(
      assignRole({ ...base, builtInRole: "PLATFORM_SYSTEM_ADMINISTRATOR" }, NOW),
    ).rejects.toMatchObject({ code: "PLATFORM_ROLE", status: 403 });
  });

  it("rejects assignment to an archived (non-ACTIVE) custom role", async () => {
    roleFindFirst.mockResolvedValueOnce({ id: "role-1", firmId: "firm-1", name: "Old", status: "ARCHIVED", isAssignable: false });
    await expect(assignRole({ ...base, customRoleId: "role-1" }, NOW)).rejects.toMatchObject({
      code: "ROLE_NOT_ASSIGNABLE",
      status: 409,
    });
    expect(assignCreate).not.toHaveBeenCalled();
  });

  it("rejects an ACTIVE role flagged not assignable", async () => {
    roleFindFirst.mockResolvedValueOnce({ id: "role-1", firmId: "firm-1", name: "Hidden", status: "ACTIVE", isAssignable: false });
    await expect(assignRole({ ...base, customRoleId: "role-1" }, NOW)).rejects.toMatchObject({ code: "ROLE_NOT_ASSIGNABLE" });
  });

  it("creates an ACTIVE assignment now and bumps the revision", async () => {
    const row = await assignRole({ ...base, builtInRole: "CASE_MANAGER", caseId: "case-9", reason: "coverage" }, NOW);
    expect(row).toMatchObject({ status: "ACTIVE", builtInRole: "CASE_MANAGER", caseId: "case-9", assignedById: "admin-1" });
    expect(firmUpdate).toHaveBeenCalledTimes(1);
  });

  it("schedules a future-dated assignment as SCHEDULED", async () => {
    const future = new Date("2026-08-01T00:00:00Z");
    const row = await assignRole({ ...base, builtInRole: "CASE_MANAGER", effectiveFrom: future }, NOW);
    expect(row).toMatchObject({ status: "SCHEDULED", effectiveFrom: future });
  });

  it("rejects an inverted or already-expired window", async () => {
    await expect(
      assignRole(
        { ...base, builtInRole: "CASE_MANAGER", effectiveFrom: new Date("2026-08-02T00:00:00Z"), effectiveUntil: new Date("2026-08-01T00:00:00Z") },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INVALID_WINDOW" });
    await expect(
      assignRole({ ...base, builtInRole: "CASE_MANAGER", effectiveUntil: new Date("2026-07-01T00:00:00Z") }, NOW),
    ).rejects.toMatchObject({ code: "INVALID_WINDOW" });
  });
});

// ── revokeAssignment ─────────────────────────────────────────────────────────

describe("revokeAssignment", () => {
  it("soft-revokes with who/when/why and bumps the revision", async () => {
    assignFindFirst.mockResolvedValueOnce({ id: "a-1", firmId: "firm-1", status: "ACTIVE" });
    assignUpdate.mockImplementation(async ({ data }: { data: object }) => ({ id: "a-1", userId: "user-2", ...data }));

    const row = await revokeAssignment({ firmId: "firm-1", actorId: "admin-1", assignmentId: "a-1", reason: "left the case" });

    expect(assignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REVOKED", revokedById: "admin-1", revocationReason: "left the case" }),
      }),
    );
    expect(row.status).toBe("REVOKED");
    expect(firmUpdate).toHaveBeenCalledTimes(1);
  });

  it("409s on double revocation and 404s on unknown assignments", async () => {
    assignFindFirst.mockResolvedValueOnce({ id: "a-1", firmId: "firm-1", status: "REVOKED" });
    await expect(revokeAssignment({ firmId: "firm-1", actorId: "admin-1", assignmentId: "a-1" })).rejects.toMatchObject({
      code: "ALREADY_REVOKED",
    });
    assignFindFirst.mockResolvedValueOnce(null);
    await expect(revokeAssignment({ firmId: "firm-1", actorId: "admin-1", assignmentId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ── expireSweep ──────────────────────────────────────────────────────────────

describe("expireSweep", () => {
  const NOW = new Date("2026-07-27T12:00:00Z");

  it("expires past-due ACTIVE rows, activates due SCHEDULED rows, expires grants, bumps once", async () => {
    assignUpdateMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
    grantUpdateMany.mockResolvedValueOnce({ count: 1 });

    const result = await expireSweep("firm-1", NOW);

    expect(assignUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { firmId: "firm-1", status: "ACTIVE", effectiveUntil: { lte: NOW } },
      data: { status: "EXPIRED" },
    });
    expect(assignUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { firmId: "firm-1", status: "SCHEDULED", effectiveFrom: { lte: NOW } },
      data: { status: "ACTIVE" },
    });
    expect(result).toEqual({ assignmentsExpired: 2, assignmentsActivated: 1, grantsExpired: 1 });
    expect(firmUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not bump the revision when nothing changed", async () => {
    assignUpdateMany.mockResolvedValue({ count: 0 });
    grantUpdateMany.mockResolvedValue({ count: 0 });
    const result = await expireSweep("firm-1", NOW);
    expect(result).toEqual({ assignmentsExpired: 0, assignmentsActivated: 0, grantsExpired: 0 });
    expect(firmUpdate).not.toHaveBeenCalled();
  });
});

// ── impactAnalysis ───────────────────────────────────────────────────────────

describe("impactAnalysis", () => {
  const roleRow = {
    id: "role-1",
    firmId: "firm-1",
    status: "ACTIVE",
    version: 1,
    permissions: [
      { permissionKey: "case.view", effect: "ALLOW", scopeType: "ORGANIZATION", scopeConfig: null },
      { permissionKey: "futurecare.edit", effect: "ALLOW", scopeType: "ORGANIZATION", scopeConfig: null },
      { permissionKey: "report.attest", effect: "ALLOW", scopeType: "ORGANIZATION", scopeConfig: null },
    ],
  };

  it("computes assignees, distinct cases, adds/removes/denies, and critical changes", async () => {
    roleFindFirst.mockResolvedValueOnce(roleRow);
    assignFindMany.mockResolvedValueOnce([
      { userId: "u1", caseId: "c1" },
      { userId: "u1", caseId: "c2" },
      { userId: "u2", caseId: null },
    ]);

    const impact = await impactAnalysis("firm-1", "role-1", [
      allow("case.view"),
      allow("costs.edit"),
      den("futurecare.edit"),
    ]);

    expect(impact.usersAssigned).toBe(2); // u1 twice counts once
    expect(impact.activeCasesAffected).toBe(2); // null caseId excluded
    expect(impact.added).toEqual(["costs.edit"]);
    expect(impact.removed).toEqual(["futurecare.edit", "report.attest"]);
    expect(impact.newlyDenied).toEqual(["futurecare.edit"]);
    expect(impact.criticalChanged).toContain("report.attest"); // CRITICAL risk
    expect(impact.externalUsersAffected).toBe(0);
    expect(impact.sessionsShouldRefresh).toBe(true);
  });

  it("does not force a session refresh for low-risk changes", async () => {
    roleFindFirst.mockResolvedValueOnce({ ...roleRow, permissions: [roleRow.permissions[0]] });
    assignFindMany.mockResolvedValueOnce([]);
    const impact = await impactAnalysis("firm-1", "role-1", [allow("case.view"), allow("costs.view")]);
    expect(impact.added).toEqual(["costs.view"]);
    expect(impact.criticalChanged).toEqual([]);
    expect(impact.sessionsShouldRefresh).toBe(false);
  });
});

// ── roleMatrix ───────────────────────────────────────────────────────────────

describe("roleMatrix", () => {
  it("exports built-ins + custom roles over the full permission-key axis, deny winning per cell", async () => {
    roleFindMany.mockResolvedValueOnce([
      {
        id: "role-1",
        name: "Custom A",
        status: "ACTIVE",
        permissions: [
          { permissionKey: "case.view", effect: "ALLOW" },
          { permissionKey: "billing.manage", effect: "ALLOW" },
          { permissionKey: "billing.manage", effect: "DENY" }, // deny beats allow
        ],
      },
    ]);

    const matrix = await roleMatrix("firm-1");

    expect(matrix.permissionKeys).toEqual(ALL_PERMISSION_KEYS);
    expect(matrix.roles).toHaveLength(13 + 1); // 13 built-in templates + 1 custom
    const builtIn = matrix.roles.find((r) => r.id === "FIRM_ADMINISTRATOR");
    expect(builtIn).toMatchObject({ kind: "built-in", status: "ACTIVE" });
    expect(builtIn?.permissions["team.manage"]).toBe("ALLOW");
    const custom = matrix.roles.find((r) => r.id === "role-1");
    expect(custom?.kind).toBe("custom");
    expect(custom?.permissions["case.view"]).toBe("ALLOW");
    expect(custom?.permissions["billing.manage"]).toBe("DENY");
  });
});

// ── AdminServiceError shape ──────────────────────────────────────────────────

describe("error taxonomy", () => {
  it("ConflictError and DelegationError are AdminServiceErrors with HTTP-ready status codes", () => {
    const conflict = new ConflictError(2, 5);
    expect(conflict).toBeInstanceOf(AdminServiceError);
    expect(conflict.status).toBe(409);
    const delegation = new DelegationError([{ key: "x", reason: "y" }]);
    expect(delegation).toBeInstanceOf(AdminServiceError);
    expect(delegation.status).toBe(403);
  });
});
