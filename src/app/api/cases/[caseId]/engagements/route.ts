import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, type TenantContext } from "@/lib/tenant";
import type { Permission } from "@/lib/rbac";
import { ok, handleError } from "@/lib/api";
import {
  EngagementError,
  MAX_FEE,
  createEngagement,
  authorizeEngagement,
  assignExperts,
  advanceStatus,
  cancelEngagement,
} from "@/lib/engagements/service";
import { REPORTS } from "@/lib/reports/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Case engagements API (MDIP docs/28, Agent B).
//   GET    — list the case's engagements (case.view)
//   POST   — create an engagement request (report.export OR case.edit)
//   PATCH  — ?id= + {action} with per-action permissions:
//              authorize: report.export (attorney seats hold it) OR team.manage
//              assign:    team.manage OR case.edit
//              advance:   team.manage OR case.edit
//              cancel:    team.manage OR case.edit, reason required
// All mutations audit + notify inside the engagement service.
// ─────────────────────────────────────────────────────────────────────────────

// An engagement can only be created for a report type the registry knows —
// unknown/free-text types are rejected (this route is server-only, so the
// registry import never reaches a client bundle).
const VALID_REPORT_TYPES = new Set(REPORTS.map((r) => r.id));

const postSchema = z.object({
  reportType: z
    .string()
    .min(1)
    .max(100)
    .refine((t) => VALID_REPORT_TYPES.has(t), { message: "Unknown report type — must be a registered report id." }),
  // finite() rejects Infinity (z.number() already rejects NaN); MAX_FEE bounds it.
  feeEstimate: z.number().finite().nonnegative().max(MAX_FEE).optional(),
  status: z.enum(["RECOMMENDED", "AWAITING_AUTHORIZATION"]).optional(),
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("authorize") }),
  z.object({
    action: z.literal("assign"),
    plannerId: z.string().nullable().optional(),
    physicianId: z.string().nullable().optional(),
    vocationalExpertId: z.string().nullable().optional(),
    economistId: z.string().nullable().optional(),
    qaReviewerId: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal("advance"), status: z.string().min(1) }),
  z.object({ action: z.literal("cancel"), reason: z.string().min(1).max(1000) }),
]);

/** Pass if the caller holds ANY of the listed permissions; else rethrow the last refusal. */
function requireAnyPermission(ctx: TenantContext, permissions: Permission[]): void {
  let lastError: unknown;
  for (const permission of permissions) {
    try {
      requirePermission(ctx, permission);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function engagementError(err: unknown) {
  if (err instanceof EngagementError) return ok({ error: err.message }, err.status);
  return handleError(err);
}

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const engagements = await prisma.caseEngagement.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id },
      orderBy: { createdAt: "desc" },
    });
    return ok({ engagements });
  } catch (err) {
    return engagementError(err);
  }
}

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    // Attorney seats (report.export) and case-team editors may request engagements.
    requireAnyPermission(ctx, ["report.export", "case.edit"]);
    await requireCase(ctx, params.caseId);
    const input = postSchema.parse(await req.json());
    const engagement = await createEngagement(
      { firmId: ctx.firm.id, userId: ctx.user.id },
      {
        caseId: params.caseId,
        reportType: input.reportType,
        requestedById: ctx.user.id,
        feeEstimate: input.feeEstimate,
        status: input.status,
        firmFeatures: ctx.firm.features,
      },
    );
    return ok({ engagement }, 201);
  } catch (err) {
    return engagementError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return ok({ error: "Provide ?id=" }, 400);
    const input = patchSchema.parse(await req.json());
    const actor = { firmId: ctx.firm.id, userId: ctx.user.id };

    // Per-action permission before any case/engagement load.
    if (input.action === "authorize") requireAnyPermission(ctx, ["report.export", "team.manage"]);
    else requireAnyPermission(ctx, ["team.manage", "case.edit"]);
    await requireCase(ctx, params.caseId);

    // The engagement must belong to this case (the service enforces firm scope).
    const existing = await prisma.caseEngagement.findFirst({
      where: { id, caseId: params.caseId, firmId: ctx.firm.id },
      select: { id: true },
    });
    if (!existing) return ok({ error: "Engagement not found" }, 404);

    let engagement;
    if (input.action === "authorize") {
      engagement = await authorizeEngagement(actor, id);
    } else if (input.action === "assign") {
      engagement = await assignExperts(actor, id, {
        plannerId: input.plannerId,
        physicianId: input.physicianId,
        vocationalExpertId: input.vocationalExpertId,
        economistId: input.economistId,
        qaReviewerId: input.qaReviewerId,
      });
    } else if (input.action === "advance") {
      engagement = await advanceStatus(actor, id, input.status);
    } else {
      engagement = await cancelEngagement(actor, id, input.reason);
    }
    return ok({ engagement });
  } catch (err) {
    return engagementError(err);
  }
}
