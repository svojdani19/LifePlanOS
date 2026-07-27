import { prisma } from "@/lib/db";
import type { Prisma, UserRole } from "@/generated/prisma";
import {
  ALL_PERMISSION_KEYS,
  getDefinition,
  resolveKey,
  type PermissionScopeType,
} from "./registry";
import { ALL_ROLE_TEMPLATES, BUILT_IN_ROLES, LEGACY_ROLE_MAP, getRoleTemplate } from "./roles";

// ─────────────────────────────────────────────────────────────────────────────
// Enterprise authorization — admin service (docs/26, Phases 2/3).
//
// Mutation surface for custom roles, assignments, and the authz revision
// counter. Every function is prisma-backed but DB-thin: all policy (delegation
// ceiling, archived-role guards, optimistic concurrency) lives here so routes
// stay one-call shims and tests can mock @/lib/db entirely.
//
// Invariants:
//   • every mutation bumps Firm.authzRevision (cache key for evaluation);
//   • every role change writes a RoleVersion snapshot (full permission rows +
//     reason) — history is append-only, roles are archived, never deleted;
//   • the delegation ceiling is enforced on every permission list a firm user
//     authors: only valid, custom-role-assignable, non-platform, delegable
//     keys the GRANTOR HOLDS may be allowed; denials may name any valid
//     non-platform key (a deny restricts — it can never widen access).
// ─────────────────────────────────────────────────────────────────────────────

// ── Errors ───────────────────────────────────────────────────────────────────

export class AdminServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Optimistic-concurrency failure: the role changed since the caller read it. */
export class ConflictError extends AdminServiceError {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Role version conflict: expected ${expectedVersion}, found ${actualVersion}. Reload and retry.`,
      "VERSION_CONFLICT",
      409,
    );
  }
}

export interface DelegationOffense {
  key: string;
  reason: string;
}

/** Delegation-ceiling violation; names every offending key. */
export class DelegationError extends AdminServiceError {
  constructor(readonly offenders: DelegationOffense[]) {
    super(
      `Delegation ceiling: ${offenders.map((o) => `${o.key} (${o.reason})`).join(", ")}`,
      "DELEGATION_CEILING",
      403,
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

// ── Permission inputs ────────────────────────────────────────────────────────

export interface PermissionInput {
  key: string;
  effect: "ALLOW" | "DENY";
  scopeType?: PermissionScopeType;
  scopeConfig?: { caseId?: string; officeId?: string; reportType?: string };
}

export interface NormalizedPermission {
  key: string; // always canonical
  effect: "ALLOW" | "DENY";
  scopeType: PermissionScopeType;
  scopeConfig?: { caseId?: string; officeId?: string; reportType?: string };
}

/**
 * Effective canonical permission keys of a legacy User.role — the enum value
 * projected through its built-in template (the same projection evaluate.ts
 * uses), so the delegation ceiling reflects what the grantor can actually do.
 */
export function legacyEffectiveKeys(role: UserRole | string): string[] {
  const templateKey = LEGACY_ROLE_MAP[role as UserRole];
  const tpl = templateKey ? ALL_ROLE_TEMPLATES[templateKey] : undefined;
  return (tpl?.permissions ?? []).map(resolveKey);
}

/** Why this key/effect pair is outside the grantor's ceiling, or null if fine. */
function ceilingOffense(held: Set<string>, key: string, effect: "ALLOW" | "DENY"): string | null {
  const def = getDefinition(key);
  if (!def) return "unknown permission key";
  if (def.platformOnly) return "platform-only";
  // A DENY only ever narrows access, so any valid non-platform key may be
  // denied — held or not.
  if (effect === "DENY") return null;
  if (!def.customRoleAssignable) return "not assignable to custom roles";
  if (!def.delegable) return "not delegable";
  if (!held.has(def.key)) return "not held by grantor";
  return null;
}

/**
 * DELEGATION CEILING. Every requested ALLOW must be a valid, custom-role-
 * assignable, non-platform, delegable key the grantor holds; every requested
 * DENY must be a valid non-platform key. Throws DelegationError naming every
 * offender at once (so the caller can fix the whole list in one pass).
 */
export function assertDelegable(
  grantorPermissionKeys: string[],
  requested: Array<Pick<PermissionInput, "key" | "effect">>,
): void {
  const held = new Set(grantorPermissionKeys.map(resolveKey));
  const offenders: DelegationOffense[] = [];
  for (const r of requested) {
    const reason = ceilingOffense(held, r.key, r.effect);
    if (reason) offenders.push({ key: r.key, reason });
  }
  if (offenders.length > 0) throw new DelegationError(offenders);
}

/** Preferred scope if the key allows it, else the widest scope it does allow. */
function scopeFor(key: string, preferred: PermissionScopeType): PermissionScopeType {
  const def = getDefinition(key);
  if (!def) return preferred;
  if (def.scopes.includes(preferred)) return preferred;
  return def.scopes.includes("ORGANIZATION") ? "ORGANIZATION" : def.scopes[0];
}

/** Canonicalize keys, validate scopes against the registry, and dedupe. */
function normalizePermissions(perms: PermissionInput[]): NormalizedPermission[] {
  const out: NormalizedPermission[] = [];
  const seen = new Set<string>();
  for (const p of perms) {
    const def = getDefinition(p.key);
    if (!def) throw new AdminServiceError(`Unknown permission key: ${p.key}`, "UNKNOWN_PERMISSION", 422);
    const scopeType = p.scopeType ?? "ORGANIZATION";
    if (!def.scopes.includes(scopeType)) {
      throw new AdminServiceError(
        `Permission ${def.key} cannot be granted at ${scopeType} scope (allowed: ${def.scopes.join(", ")}).`,
        "INVALID_SCOPE",
        422,
      );
    }
    const sig = `${def.key}|${p.effect}|${scopeType}|${JSON.stringify(p.scopeConfig ?? null)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({
      key: def.key,
      effect: p.effect,
      scopeType,
      ...(p.scopeConfig ? { scopeConfig: p.scopeConfig } : {}),
    });
  }
  if (out.length === 0) {
    throw new AdminServiceError("A role must contain at least one permission entry.", "EMPTY_ROLE", 422);
  }
  return out;
}

function snapshotJson(permissions: NormalizedPermission[], reason: string): Prisma.InputJsonValue {
  return { permissions, reason } as unknown as Prisma.InputJsonValue;
}

// ── Revision counter ─────────────────────────────────────────────────────────

/**
 * Increment Firm.authzRevision — the cache key every future authz memoization
 * layer invalidates on. Called after EVERY mutation in this module.
 */
export async function bumpAuthzRevision(firmId: string): Promise<void> {
  await prisma.firm.update({ where: { id: firmId }, data: { authzRevision: { increment: 1 } } });
}

// ── Custom roles ─────────────────────────────────────────────────────────────

export interface CreateRoleInput {
  firmId: string;
  actorId: string;
  /** The grantor's effective permission keys (delegation ceiling). */
  grantorPermissionKeys: string[];
  name: string;
  description?: string;
  permissions: PermissionInput[];
  reason?: string;
  clonedFromSystemRole?: string;
}

export interface RoleWithPermissions {
  role: { id: string; firmId: string; name: string; version: number; status: string };
  permissions: NormalizedPermission[];
}

export async function createCustomRole(input: CreateRoleInput): Promise<RoleWithPermissions> {
  assertDelegable(input.grantorPermissionKeys, input.permissions);
  const rows = normalizePermissions(input.permissions);
  const reason = input.reason ?? "role created";

  let role;
  try {
    role = await prisma.$transaction(async (tx) => {
      const created = await tx.customRole.create({
        data: {
          firmId: input.firmId,
          name: input.name,
          description: input.description ?? null,
          status: "ACTIVE",
          clonedFromSystemRole: input.clonedFromSystemRole ?? null,
          version: 1,
          createdById: input.actorId,
        },
      });
      await tx.customRolePermission.createMany({
        data: rows.map((r) => ({
          customRoleId: created.id,
          permissionKey: r.key,
          effect: r.effect,
          scopeType: r.scopeType,
          scopeConfig: (r.scopeConfig as Prisma.InputJsonValue | undefined) ?? undefined,
        })),
      });
      await tx.roleVersion.create({
        data: {
          firmId: input.firmId,
          customRoleId: created.id,
          version: 1,
          permissionSnapshot: snapshotJson(rows, reason),
          changedById: input.actorId,
          changeReason: reason,
        },
      });
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AdminServiceError(`A role named "${input.name}" already exists.`, "NAME_TAKEN", 409);
    }
    throw err;
  }
  await bumpAuthzRevision(input.firmId);
  return { role, permissions: rows };
}

export interface CloneRoleInput {
  firmId: string;
  actorId: string;
  grantorPermissionKeys: string[];
  name: string;
  description?: string;
  /** Built-in template key OR a firm custom-role id. */
  cloneFrom: string;
  reason?: string;
}

export interface CloneRoleResult extends RoleWithPermissions {
  /** Source keys outside the grantor's ceiling, dropped (disclosed, not silent). */
  droppedKeys: DelegationOffense[];
}

/**
 * Clone a built-in template or an existing custom role into a new custom role.
 * Source keys outside the grantor's delegation ceiling (e.g. the non-delegable
 * expert-signature keys on the Physician Reviewer template) are DROPPED and
 * reported back — a clone yields the closest legal role rather than failing —
 * but a clone that would keep nothing is refused outright.
 */
export async function cloneRole(input: CloneRoleInput): Promise<CloneRoleResult> {
  const tpl = getRoleTemplate(input.cloneFrom);
  let source: PermissionInput[];
  let clonedFromSystemRole: string | undefined;

  if (tpl) {
    clonedFromSystemRole = tpl.key;
    source = tpl.permissions.map((k) => {
      const canonical = resolveKey(k);
      return {
        key: canonical,
        effect: "ALLOW" as const,
        scopeType: scopeFor(canonical, tpl.defaultScope === "CASE" ? "CASE" : "ORGANIZATION"),
      };
    });
  } else {
    const src = await prisma.customRole.findFirst({
      where: { id: input.cloneFrom, firmId: input.firmId },
      include: { permissions: true },
    });
    if (!src) throw new AdminServiceError("Clone source not found.", "NOT_FOUND", 404);
    clonedFromSystemRole = src.clonedFromSystemRole ?? undefined;
    source = src.permissions.map((p) => ({
      key: resolveKey(p.permissionKey),
      effect: p.effect as "ALLOW" | "DENY",
      scopeType: p.scopeType as PermissionScopeType,
      ...(p.scopeConfig ? { scopeConfig: p.scopeConfig as NonNullable<PermissionInput["scopeConfig"]> } : {}),
    }));
  }

  const held = new Set(input.grantorPermissionKeys.map(resolveKey));
  const kept: PermissionInput[] = [];
  const droppedKeys: DelegationOffense[] = [];
  for (const p of source) {
    const reason = ceilingOffense(held, p.key, p.effect);
    if (reason) droppedKeys.push({ key: p.key, reason });
    else kept.push(p);
  }
  if (kept.length === 0) throw new DelegationError(droppedKeys);

  const reason =
    input.reason ??
    `cloned from ${input.cloneFrom}` +
      (droppedKeys.length > 0 ? ` (outside delegation ceiling, dropped: ${droppedKeys.map((d) => d.key).join(", ")})` : "");

  const created = await createCustomRole({
    firmId: input.firmId,
    actorId: input.actorId,
    grantorPermissionKeys: input.grantorPermissionKeys,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    permissions: kept,
    reason,
    ...(clonedFromSystemRole ? { clonedFromSystemRole } : {}),
  });
  return { ...created, droppedKeys };
}

export interface UpdateRoleInput {
  firmId: string;
  roleId: string;
  actorId: string;
  /** Required when `permissions` is provided. */
  grantorPermissionKeys?: string[];
  expectedVersion: number;
  permissions?: PermissionInput[];
  name?: string;
  description?: string;
  /** Required when `permissions` is provided. */
  changeReason?: string;
}

/**
 * Update a custom role's name/description/permissions under optimistic
 * concurrency (expectedVersion). Permission changes require a changeReason and
 * re-pass the delegation ceiling. Every successful update bumps the role
 * version and writes a RoleVersion snapshot.
 */
export async function updateRolePermissions(
  input: UpdateRoleInput,
): Promise<{ roleId: string; version: number; permissions: NormalizedPermission[] }> {
  const role = await prisma.customRole.findFirst({
    where: { id: input.roleId, firmId: input.firmId },
    include: { permissions: true },
  });
  if (!role) throw new AdminServiceError("Role not found.", "NOT_FOUND", 404);
  if (role.status === "ARCHIVED") {
    throw new AdminServiceError("Archived roles cannot be modified — clone them instead.", "ROLE_ARCHIVED", 409);
  }
  if (role.version !== input.expectedVersion) throw new ConflictError(input.expectedVersion, role.version);

  let rows: NormalizedPermission[] | undefined;
  if (input.permissions) {
    if (!input.changeReason) {
      throw new AdminServiceError("A change reason is required when changing permissions.", "REASON_REQUIRED", 422);
    }
    assertDelegable(input.grantorPermissionKeys ?? [], input.permissions);
    rows = normalizePermissions(input.permissions);
  }
  const snapshotRows: NormalizedPermission[] =
    rows ??
    role.permissions.map((p) => ({
      key: resolveKey(p.permissionKey),
      effect: p.effect as "ALLOW" | "DENY",
      scopeType: p.scopeType as PermissionScopeType,
      ...(p.scopeConfig ? { scopeConfig: p.scopeConfig as NonNullable<PermissionInput["scopeConfig"]> } : {}),
    }));
  const reason = input.changeReason ?? "role metadata updated";
  const nextVersion = role.version + 1;

  try {
    await prisma.$transaction(async (tx) => {
      // The version predicate makes this a compare-and-swap: a concurrent
      // editor who won the race leaves count === 0 and we conflict cleanly.
      const res = await tx.customRole.updateMany({
        where: { id: input.roleId, firmId: input.firmId, version: input.expectedVersion },
        data: {
          version: nextVersion,
          updatedById: input.actorId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      });
      if (res.count === 0) throw new ConflictError(input.expectedVersion, nextVersion);
      if (rows) {
        await tx.customRolePermission.deleteMany({ where: { customRoleId: input.roleId } });
        await tx.customRolePermission.createMany({
          data: rows.map((r) => ({
            customRoleId: input.roleId,
            permissionKey: r.key,
            effect: r.effect,
            scopeType: r.scopeType,
            scopeConfig: (r.scopeConfig as Prisma.InputJsonValue | undefined) ?? undefined,
          })),
        });
      }
      await tx.roleVersion.create({
        data: {
          firmId: input.firmId,
          customRoleId: input.roleId,
          version: nextVersion,
          permissionSnapshot: snapshotJson(snapshotRows, reason),
          changedById: input.actorId,
          changeReason: reason,
        },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AdminServiceError(`A role named "${input.name}" already exists.`, "NAME_TAKEN", 409);
    }
    throw err;
  }
  await bumpAuthzRevision(input.firmId);
  return { roleId: input.roleId, version: nextVersion, permissions: snapshotRows };
}

export interface ArchiveRoleInput {
  firmId: string;
  roleId: string;
  actorId: string;
  reason?: string;
}

/**
 * Archive a custom role (never hard delete). Existing assignments are left in
 * place for the caller to review — their count is returned — but no NEW
 * assignment can ever target an archived role (assignRole guards it).
 */
export async function archiveRole(
  input: ArchiveRoleInput,
): Promise<{ roleId: string; version: number; activeAssignments: number }> {
  const role = await prisma.customRole.findFirst({
    where: { id: input.roleId, firmId: input.firmId },
    include: { permissions: true },
  });
  if (!role) throw new AdminServiceError("Role not found.", "NOT_FOUND", 404);
  if (role.status === "ARCHIVED") {
    throw new AdminServiceError("Role is already archived.", "ROLE_ARCHIVED", 409);
  }
  const activeAssignments = await prisma.userRoleAssignment.count({
    where: { firmId: input.firmId, customRoleId: input.roleId, status: { in: ["ACTIVE", "SCHEDULED"] } },
  });
  const reason = input.reason ?? "role archived";
  const nextVersion = role.version + 1;
  const snapshotRows: NormalizedPermission[] = role.permissions.map((p) => ({
    key: resolveKey(p.permissionKey),
    effect: p.effect as "ALLOW" | "DENY",
    scopeType: p.scopeType as PermissionScopeType,
    ...(p.scopeConfig ? { scopeConfig: p.scopeConfig as NonNullable<PermissionInput["scopeConfig"]> } : {}),
  }));

  await prisma.$transaction(async (tx) => {
    await tx.customRole.update({
      where: { id: input.roleId },
      data: {
        status: "ARCHIVED",
        archivedAt: new Date(),
        isAssignable: false,
        version: nextVersion,
        updatedById: input.actorId,
      },
    });
    await tx.roleVersion.create({
      data: {
        firmId: input.firmId,
        customRoleId: input.roleId,
        version: nextVersion,
        permissionSnapshot: snapshotJson(snapshotRows, reason),
        changedById: input.actorId,
        changeReason: reason,
      },
    });
  });
  await bumpAuthzRevision(input.firmId);
  return { roleId: input.roleId, version: nextVersion, activeAssignments };
}

// ── Assignments ──────────────────────────────────────────────────────────────

export interface AssignRoleInput {
  firmId: string;
  actorId: string;
  userId: string;
  builtInRole?: string;
  customRoleId?: string;
  officeId?: string;
  caseId?: string;
  responsibility?: string;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
  reason?: string;
}

export async function assignRole(input: AssignRoleInput, now: Date = new Date()) {
  const hasBuiltIn = Boolean(input.builtInRole);
  const hasCustom = Boolean(input.customRoleId);
  if (hasBuiltIn === hasCustom) {
    throw new AdminServiceError(
      "Provide exactly one of builtInRole or customRoleId.",
      "ROLE_XOR_REQUIRED",
      422,
    );
  }

  const target = await prisma.user.findFirst({ where: { id: input.userId, firmId: input.firmId } });
  if (!target) throw new AdminServiceError("User not found in this firm.", "NOT_FOUND", 404);

  if (input.builtInRole) {
    const tpl = getRoleTemplate(input.builtInRole);
    if (!tpl) throw new AdminServiceError(`Unknown built-in role: ${input.builtInRole}`, "UNKNOWN_ROLE", 422);
    if (tpl.key === "PLATFORM_SYSTEM_ADMINISTRATOR") {
      throw new AdminServiceError("The platform operator role is never assignable to firm users.", "PLATFORM_ROLE", 403);
    }
  } else if (input.customRoleId) {
    const role = await prisma.customRole.findFirst({
      where: { id: input.customRoleId, firmId: input.firmId },
    });
    if (!role) throw new AdminServiceError("Role not found.", "NOT_FOUND", 404);
    if (role.status !== "ACTIVE") {
      throw new AdminServiceError(
        `Role "${role.name}" is ${role.status} and cannot be assigned.`,
        "ROLE_NOT_ASSIGNABLE",
        409,
      );
    }
    if (!role.isAssignable) {
      throw new AdminServiceError(`Role "${role.name}" is not assignable.`, "ROLE_NOT_ASSIGNABLE", 409);
    }
  }

  const from = input.effectiveFrom ?? now;
  if (input.effectiveUntil && input.effectiveUntil.getTime() <= from.getTime()) {
    throw new AdminServiceError("effectiveUntil must be after effectiveFrom.", "INVALID_WINDOW", 422);
  }
  if (input.effectiveUntil && input.effectiveUntil.getTime() <= now.getTime()) {
    throw new AdminServiceError("effectiveUntil is already in the past.", "INVALID_WINDOW", 422);
  }
  // Scheduled activation: a future start is SCHEDULED (expireSweep flips it).
  const status = from.getTime() > now.getTime() ? "SCHEDULED" : "ACTIVE";

  const assignment = await prisma.userRoleAssignment.create({
    data: {
      userId: input.userId,
      firmId: input.firmId,
      builtInRole: input.builtInRole ?? null,
      customRoleId: input.customRoleId ?? null,
      officeId: input.officeId ?? null,
      caseId: input.caseId ?? null,
      responsibility: input.responsibility ?? null,
      effectiveFrom: from,
      effectiveUntil: input.effectiveUntil ?? null,
      status,
      assignedById: input.actorId,
      assignmentReason: input.reason ?? null,
    },
  });
  await bumpAuthzRevision(input.firmId);
  return assignment;
}

export interface RevokeAssignmentInput {
  firmId: string;
  actorId: string;
  assignmentId: string;
  reason?: string;
}

export async function revokeAssignment(input: RevokeAssignmentInput) {
  const row = await prisma.userRoleAssignment.findFirst({
    where: { id: input.assignmentId, firmId: input.firmId },
  });
  if (!row) throw new AdminServiceError("Assignment not found.", "NOT_FOUND", 404);
  if (row.status === "REVOKED") {
    throw new AdminServiceError("Assignment is already revoked.", "ALREADY_REVOKED", 409);
  }
  const updated = await prisma.userRoleAssignment.update({
    where: { id: input.assignmentId },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedById: input.actorId,
      revocationReason: input.reason ?? null,
    },
  });
  await bumpAuthzRevision(input.firmId);
  return updated;
}

export interface ExpireSweepResult {
  assignmentsExpired: number;
  assignmentsActivated: number;
  grantsExpired: number;
}

/**
 * Housekeeping sweep (exported for reuse from routes/jobs): expire ACTIVE
 * assignments and grants whose effectiveUntil has passed, and activate
 * SCHEDULED assignments whose effectiveFrom has arrived. Bumps the revision
 * only when something actually changed.
 */
export async function expireSweep(firmId: string, now: Date = new Date()): Promise<ExpireSweepResult> {
  const expired = await prisma.userRoleAssignment.updateMany({
    where: { firmId, status: "ACTIVE", effectiveUntil: { lte: now } },
    data: { status: "EXPIRED" },
  });
  const activated = await prisma.userRoleAssignment.updateMany({
    where: { firmId, status: "SCHEDULED", effectiveFrom: { lte: now } },
    data: { status: "ACTIVE" },
  });
  const grants = await prisma.accessGrant.updateMany({
    where: { firmId, status: "ACTIVE", effectiveUntil: { lte: now } },
    data: { status: "EXPIRED" },
  });
  const result: ExpireSweepResult = {
    assignmentsExpired: expired.count,
    assignmentsActivated: activated.count,
    grantsExpired: grants.count,
  };
  if (expired.count + activated.count + grants.count > 0) await bumpAuthzRevision(firmId);
  return result;
}

// ── Impact analysis & matrix ─────────────────────────────────────────────────

export interface ImpactAnalysis {
  usersAssigned: number;
  activeCasesAffected: number;
  added: string[];
  removed: string[];
  newlyDenied: string[];
  criticalChanged: string[];
  /** Placeholder until an external-user model exists (docs/26 audit). */
  externalUsersAffected: number;
  sessionsShouldRefresh: boolean;
}

/**
 * What would change if `proposedPermissions` replaced the role's current
 * permission set — who is touched and which keys move, with CRITICAL-risk and
 * privileged keys called out (those force a session refresh on apply).
 */
export async function impactAnalysis(
  firmId: string,
  roleId: string,
  proposedPermissions: Array<Pick<PermissionInput, "key" | "effect">>,
): Promise<ImpactAnalysis> {
  const role = await prisma.customRole.findFirst({
    where: { id: roleId, firmId },
    include: { permissions: true },
  });
  if (!role) throw new AdminServiceError("Role not found.", "NOT_FOUND", 404);

  const assignments = await prisma.userRoleAssignment.findMany({
    where: { firmId, customRoleId: roleId, status: { in: ["ACTIVE", "SCHEDULED"] } },
    select: { userId: true, caseId: true },
  });
  const usersAssigned = new Set(assignments.map((a) => a.userId)).size;
  const activeCasesAffected = new Set(assignments.map((a) => a.caseId).filter((c): c is string => Boolean(c))).size;

  const currentAllow = new Set(
    role.permissions.filter((p) => p.effect === "ALLOW").map((p) => resolveKey(p.permissionKey)),
  );
  const currentDeny = new Set(
    role.permissions.filter((p) => p.effect === "DENY").map((p) => resolveKey(p.permissionKey)),
  );
  const proposedAllow = new Set(
    proposedPermissions.filter((p) => p.effect === "ALLOW").map((p) => resolveKey(p.key)),
  );
  const proposedDeny = new Set(
    proposedPermissions.filter((p) => p.effect === "DENY").map((p) => resolveKey(p.key)),
  );

  const added = [...proposedAllow].filter((k) => !currentAllow.has(k)).sort();
  const removed = [...currentAllow].filter((k) => !proposedAllow.has(k)).sort();
  const newlyDenied = [...proposedDeny].filter((k) => !currentDeny.has(k)).sort();
  const changed = new Set([...added, ...removed, ...newlyDenied]);
  const criticalChanged = [...changed]
    .filter((k) => {
      const def = getDefinition(k);
      return Boolean(def && (def.risk === "CRITICAL" || def.privileged));
    })
    .sort();

  return {
    usersAssigned,
    activeCasesAffected,
    added,
    removed,
    newlyDenied,
    criticalChanged,
    externalUsersAffected: 0,
    sessionsShouldRefresh: criticalChanged.length > 0,
  };
}

export interface RoleMatrixRow {
  id: string;
  name: string;
  kind: "built-in" | "custom";
  status: string;
  /** canonical key → effect; keys absent from the role are omitted. */
  permissions: Record<string, "ALLOW" | "DENY">;
}

export interface RoleMatrix {
  generatedAt: string;
  firmId: string;
  permissionKeys: string[];
  roles: RoleMatrixRow[];
}

/** Role × permission export for audit/access review (built-ins + firm roles). */
export async function roleMatrix(firmId: string): Promise<RoleMatrix> {
  const custom = await prisma.customRole.findMany({
    where: { firmId },
    include: { permissions: true },
    orderBy: { name: "asc" },
  });

  const roles: RoleMatrixRow[] = [];
  for (const tpl of Object.values(BUILT_IN_ROLES)) {
    roles.push({
      id: tpl.key,
      name: tpl.name,
      kind: "built-in",
      status: "ACTIVE",
      permissions: Object.fromEntries(tpl.permissions.map((p) => [resolveKey(p), "ALLOW" as const])),
    });
  }
  for (const r of custom) {
    const cells: Record<string, "ALLOW" | "DENY"> = {};
    // ALLOW first so an explicit DENY on the same key wins in the export —
    // matching the evaluator, where a deny always beats an allow.
    for (const p of r.permissions.filter((x) => x.effect === "ALLOW")) cells[resolveKey(p.permissionKey)] = "ALLOW";
    for (const p of r.permissions.filter((x) => x.effect === "DENY")) cells[resolveKey(p.permissionKey)] = "DENY";
    roles.push({ id: r.id, name: r.name, kind: "custom", status: r.status, permissions: cells });
  }

  return {
    generatedAt: new Date().toISOString(),
    firmId,
    permissionKeys: [...ALL_PERMISSION_KEYS],
    roles,
  };
}
