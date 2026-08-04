import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { authorize } from "@/lib/authz/evaluate";
import { shadowCompare } from "@/lib/authz/shadow";
import { readSessionContext } from "@/lib/auth/session";
import { can, type Permission } from "@/lib/rbac";
import { effectiveLimits, currentPeriod } from "@/lib/subscription/plans";
import type { Firm, Subscription, User, UsageMetric } from "@/generated/prisma";
import {
  accessibleCaseIds,
  rolesWithPermission,
  templatesWithPermission,
  type CaseAccess,
} from "@/lib/authz/caseScope";
import type { AuthzContext, AuthzInput } from "@/lib/authz/evaluate";

// ─────────────────────────────────────────────────────────────────────────────
// The tenant guard is the ONLY sanctioned way server code obtains identity and
// touches tenant data. It resolves the session to a { user, firm, subscription }
// context, enforces RBAC + plan limits, and writes the audit/usage trail. Every
// query downstream must be scoped by `ctx.firm.id` — never trust a client-sent
// firmId.
// ─────────────────────────────────────────────────────────────────────────────

export interface TenantContext {
  user: User;
  firm: Firm;
  subscription: Subscription | null;
  /** Set when a platform operator is inspecting a target tenant. */
  supportMode?: boolean;
  /** The actor's home tenant; differs from firm.id only in support mode. */
  actorFirmId?: string;
  /** Server-side session id, used to mutate audited support context safely. */
  sessionId?: string;
  authz?: AuthzContext;
  authzLoadFailed?: boolean;
}

export class TenantError extends Error {
  constructor(
    message: string,
    readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "LIMIT_REACHED" | "SUSPENDED",
    readonly status: number,
  ) {
    super(message);
  }
}

/** Resolve the current context, or null if not authenticated. */
export async function getContext(): Promise<TenantContext | null> {
  const session = await readSessionContext();
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { firm: { include: { subscription: true } } },
  });
  if (!user || user.status === "SUSPENDED") return null;

  if (session.supportFirmId && session.supportFirmId !== user.firmId) {
    const now = new Date();
    const [platformGrant, targetFirm] = await Promise.all([
      prisma.userRoleAssignment.count({
        where: {
          userId: user.id,
          builtInRole: "PLATFORM_SYSTEM_ADMINISTRATOR",
          status: "ACTIVE",
          effectiveFrom: { lte: now },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
        },
      }),
      prisma.firm.findUnique({
        where: { id: session.supportFirmId },
        include: { subscription: true },
      }),
    ]);
    if (platformGrant > 0 && targetFirm) {
      const { firm: _actorFirm, ...actor } = user;
      const { subscription, ...firm } = targetFirm;
      return {
        user: actor as User,
        firm: firm as Firm,
        subscription,
        supportMode: true,
        actorFirmId: user.firmId,
        sessionId: session.id,
      };
    }
    // A deleted tenant or revoked platform grant invalidates the selection.
    await prisma.session.update({ where: { id: session.id }, data: { supportFirmId: null } }).catch(() => {});
  }
  const { firm, ...bare } = user;
  const { subscription, ...firmBare } = firm;
  return { user: bare as User, firm: firmBare as Firm, subscription, sessionId: session.id };
}

/** For server components: redirect unauthenticated visitors to /login. */
export async function requireContext(): Promise<TenantContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  await attachAuthzContext(ctx);
  return ctx;
}

/** For API routes: throw TenantError instead of redirecting. */
export async function requireApiContext(): Promise<TenantContext> {
  const ctx = await getContext();
  if (!ctx) throw new TenantError("Not authenticated", "UNAUTHENTICATED", 401);
  await attachAuthzContext(ctx);
  return ctx;
}

async function attachAuthzContext(ctx: TenantContext): Promise<void> {
  if (ctx.authz || ctx.authzLoadFailed) return;
  try {
    const { loadAuthzContext } = await import("@/lib/authz/context");
    ctx.authz = await loadAuthzContext(
      ctx.user.id,
      ctx.firm.id,
      ctx.user.role,
      (ctx.firm as { features?: unknown }).features,
    );
  } catch {
    ctx.authzLoadFailed = true;
  }
}

export function requirePermission(ctx: TenantContext, permission: Permission): void {
  // A target-tenant support context is observation-only. The platform actor may
  // inspect case data, but no legacy role or view-as selection can authorize a
  // mutation or professional act in the target tenant.
  if (ctx.supportMode) {
    if (permission === "case.view" || permission === "audit.view") return;
    throw new TenantError("Platform support context is read-only.", "FORBIDDEN", 403);
  }

  const legacyAllowed = can(ctx.user.role, permission);
  // Enterprise evaluator: shadow-compare always; enforce only when the firm
  // has opted in via the authorization.enterprise feature flag (docs/26 P6).
  const authz = ctx.authz;
  const features = (ctx.firm as { features?: unknown }).features as Record<string, unknown> | null | undefined;
  const strictAuthorization = ctx.firm.isDemo === true || features?.["authorization.enterprise"] === true;
  if (!authz && ctx.authzLoadFailed && strictAuthorization) {
    throw new TenantError("Authorization could not be evaluated safely.", "FORBIDDEN", 403);
  }
  let canonicalAllowed = false;
  if (authz) {
    try {
      const result = authorize({ userId: ctx.user.id, firmId: ctx.firm.id, permission }, authz);
      shadowCompare(legacyAllowed, result, { permission, route: "requirePermission" });
      if (features && features["authorization.enterprise"] === true) {
        if (!result.allowed) throw new TenantError(result.userSafeReason, "FORBIDDEN", 403);
        return; // enterprise verdict is authoritative for opted-in firms
      }
      canonicalAllowed = result.allowed;
    } catch (err) {
      if (err instanceof TenantError) throw err;
      /* evaluator failure never breaks legacy authorization */
    }
  }
  if (!legacyAllowed) {
    // Compatibility layer: a currently effective role-template assignment
    // (evaluated by the canonical system — org scope here, since no resource
    // is in view) grants the legacy permission its template carries. This is
    // how an assignment-based Life Care Planner authors on a legacy seat that
    // lacks the permission. Case-scoped assignments do not widen org-level
    // checks; resource surfaces (requireCase / caseAccessFor) enforce those.
    if (canonicalAllowed) return;
    throw new TenantError(`Your role cannot perform: ${permission}`, "FORBIDDEN", 403);
  }
}

/**
 * Fail-closed authorization for canonical, resource-aware permissions. Use this
 * for specialist authorship, professional decisions, attestations, downloads,
 * and every new high-risk route. Unlike the legacy compatibility helper above,
 * absence or failure of the evaluator is a denial.
 */
export function requireCanonicalPermission(
  ctx: TenantContext,
  permission: string,
  resource: Omit<AuthzInput, "userId" | "firmId" | "permission"> = {},
): void {
  if (ctx.supportMode) {
    const readOnly = new Set([
      "case.view",
      "records.view",
      "chronology.view",
      "futurecare.view",
      "causation.view",
      "reasoning.view",
      "costs.view",
      "report.view",
      "attestation.view",
      "vocational.view",
      "economic.view",
      "audit.view",
    ]);
    if (readOnly.has(permission)) return;
    throw new TenantError("Platform support context is read-only.", "FORBIDDEN", 403);
  }
  if (!ctx.authz || ctx.authzLoadFailed) {
    throw new TenantError("Authorization could not be evaluated safely.", "FORBIDDEN", 403);
  }
  const result = authorize(
    { userId: ctx.user.id, firmId: ctx.firm.id, permission, ...resource },
    ctx.authz,
  );
  if (!result.allowed) throw new TenantError(result.userSafeReason, "FORBIDDEN", 403);
}

export function canCanonicalPermission(
  ctx: TenantContext,
  permission: string,
  resource: Omit<AuthzInput, "userId" | "firmId" | "permission"> = {},
): boolean {
  try {
    requireCanonicalPermission(ctx, permission, resource);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the caller's effective access to cases for direct-resource guards. */
export async function caseAccessFor(ctx: TenantContext): Promise<CaseAccess> {
  return accessibleCaseIds(ctx, {
    firmWideRoles: rolesWithPermission("case.view"),
    assignmentTemplates: templatesWithPermission("case.view"),
    orgWideAssignmentGrantsAll: true,
  });
}

/** Fetch a case, enforcing it belongs to the caller's firm. */
export async function requireCase(ctx: TenantContext, caseId: string) {
  const c = await prisma.case.findFirst({ where: { id: caseId, firmId: ctx.firm.id } });
  if (!c) throw new TenantError("Case not found", "FORBIDDEN", 404);
  const access = await caseAccessFor(ctx);
  if (!access.allowed || (access.cases !== "all" && !access.cases.includes(caseId))) {
    // Do not disclose whether a same-tenant case exists outside the caller's
    // assignment/grant scope.
    throw new TenantError("Case not found", "FORBIDDEN", 404);
  }
  return c;
}

// ── Plan limit enforcement ───────────────────────────────────────────────────

/** Count active (not closed/archived) cases for a firm. */
export async function activeCaseCount(firmId: string): Promise<number> {
  return prisma.case.count({
    where: { firmId, status: { notIn: ["CLOSED", "ARCHIVED"] } },
  });
}

/** Throws LIMIT_REACHED if the firm is at its plan's active-case ceiling. */
export async function assertCaseCapacity(ctx: TenantContext): Promise<void> {
  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  if (limits.caseLimit === null) return; // unlimited
  const count = await activeCaseCount(ctx.firm.id);
  if (count >= limits.caseLimit) {
    throw new TenantError(
      `Your ${ctx.subscription?.tier ?? "SOLO"} plan allows ${limits.caseLimit} active cases. Upgrade or close a case to add more.`,
      "LIMIT_REACHED",
      402,
    );
  }
}

/** Count ACTIVE + INVITED seats consuming a seat. */
export async function seatCount(firmId: string): Promise<number> {
  return prisma.user.count({ where: { firmId, status: { in: ["ACTIVE", "INVITED"] } } });
}

export async function assertSeatCapacity(ctx: TenantContext): Promise<void> {
  const limits = effectiveLimits(ctx.subscription?.tier ?? "SOLO", ctx.subscription ?? undefined);
  const count = await seatCount(ctx.firm.id);
  if (count >= limits.seatLimit) {
    throw new TenantError(
      `Your plan includes ${limits.seatLimit} seats. Upgrade to invite more teammates.`,
      "LIMIT_REACHED",
      402,
    );
  }
}

// ── Audit + usage ────────────────────────────────────────────────────────────

async function reqMeta() {
  try {
    const h = await headers();
    return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

export async function audit(
  ctx: Pick<TenantContext, "firm" | "user" | "supportMode" | "actorFirmId">,
  action: string,
  target?: { type?: string; id?: string; caseId?: string; meta?: unknown },
): Promise<void> {
  const { ip, userAgent } = await reqMeta();
  await prisma.auditLog.create({
    data: {
      firmId: ctx.firm.id,
      userId: ctx.user.id,
      action,
      targetType: target?.type,
      targetId: target?.id,
      caseId: target?.caseId,
      ip,
      userAgent,
      meta: ({
        ...((target?.meta && typeof target.meta === "object" ? target.meta : {}) as Record<string, unknown>),
        ...(ctx.supportMode
          ? { supportMode: true, actorFirmId: ctx.actorFirmId, targetFirmId: ctx.firm.id }
          : {}),
      } as any),
    },
  });
}

export async function recordUsage(
  ctx: Pick<TenantContext, "firm" | "user">,
  metric: UsageMetric,
  opts?: { quantity?: number; caseId?: string; meta?: unknown },
): Promise<void> {
  await prisma.usageRecord.create({
    data: {
      firmId: ctx.firm.id,
      userId: ctx.user.id,
      metric,
      quantity: opts?.quantity ?? 1,
      period: currentPeriod(),
      caseId: opts?.caseId,
      meta: (opts?.meta as any) ?? undefined,
    },
  });
}
