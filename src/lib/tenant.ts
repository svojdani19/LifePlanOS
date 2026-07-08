import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { readSession } from "@/lib/auth/session";
import { can, type Permission } from "@/lib/rbac";
import { effectiveLimits, currentPeriod } from "@/lib/subscription/plans";
import type { Firm, Subscription, User, UsageMetric } from "@/generated/prisma";

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
  const userId = await readSession();
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { firm: { include: { subscription: true } } },
  });
  if (!user || user.status === "SUSPENDED") return null;
  const { firm, ...bare } = user;
  const { subscription, ...firmBare } = firm;
  return { user: bare as User, firm: firmBare as Firm, subscription };
}

/** For server components: redirect unauthenticated visitors to /login. */
export async function requireContext(): Promise<TenantContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** For API routes: throw TenantError instead of redirecting. */
export async function requireApiContext(): Promise<TenantContext> {
  const ctx = await getContext();
  if (!ctx) throw new TenantError("Not authenticated", "UNAUTHENTICATED", 401);
  return ctx;
}

export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!can(ctx.user.role, permission)) {
    throw new TenantError(`Your role cannot perform: ${permission}`, "FORBIDDEN", 403);
  }
}

/** Fetch a case, enforcing it belongs to the caller's firm. */
export async function requireCase(ctx: TenantContext, caseId: string) {
  const c = await prisma.case.findFirst({ where: { id: caseId, firmId: ctx.firm.id } });
  if (!c) throw new TenantError("Case not found", "FORBIDDEN", 404);
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

function reqMeta() {
  try {
    const h = headers();
    return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

export async function audit(
  ctx: Pick<TenantContext, "firm" | "user">,
  action: string,
  target?: { type?: string; id?: string; caseId?: string; meta?: unknown },
): Promise<void> {
  const { ip, userAgent } = reqMeta();
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
      meta: (target?.meta as any) ?? undefined,
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
