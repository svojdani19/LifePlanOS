import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, TenantError, type TenantContext } from "@/lib/tenant";
import { persistCaseValidation } from "@/lib/engine/validation";
import { recomputeCosts } from "@/lib/engine/generate";
import { ok, handleError } from "@/lib/api";
import type { Permission } from "@/lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Integrity-finding dispositions. Any case-team viewer who can see the report
// surface (report.export or case.edit) may resolve-as-is, ignore, or reopen a
// finding; accept_changes applies the deterministic correction and therefore
// requires clinical edit rights (futurecare.edit). Every action re-runs the
// validation engine (dispositions survive via service+result matching) and,
// when items changed, the cost pipeline — so downstream gates update
// immediately. Every action is audited with the real actor.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  action: z.enum(["resolve_as_is", "ignore", "accept_changes", "reopen"]),
});

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

/** Deterministic appliers by finding kind. Returns true if items were changed. */
async function applyCorrection(caseId: string, finding: { service: string; result: string }): Promise<boolean> {
  // Duplicate / overlapping recommendations both totaled — the finding's
  // service is "A / B"; the correction excludes the second item from totals
  // (contingency-only keeps it disclosed, never silently deleted).
  if (/duplicate|overlap/i.test(finding.result)) {
    const parts = finding.service.split(" / ").map((sv) => sv.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const dup = await prisma.futureCareItem.findFirst({
        where: { caseId, service: parts[1], supersededAt: null, contingencyOnly: false },
        select: { id: true },
      });
      if (dup) {
        await prisma.futureCareItem.update({ where: { id: dup.id }, data: { contingencyOnly: true } });
        return true;
      }
    }
  }
  throw new TenantError(
    "This correction requires a clinical edit — use Go To and adjust the item directly.",
    "FORBIDDEN",
    409,
  );
}

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string; findingId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    const { action } = schema.parse(await req.json());
    if (action === "accept_changes") {
      requirePermission(ctx, "futurecare.edit");
    } else {
      requireAnyPermission(ctx, ["report.export", "case.edit"]);
    }
    await requireCase(ctx, params.caseId);

    const finding = await prisma.validationFinding.findFirst({
      where: { id: params.findingId, caseId: params.caseId, firmId: ctx.firm.id },
    });
    if (!finding) return ok({ error: "Finding not found" }, 404);

    let itemsChanged = false;
    if (action === "accept_changes") {
      itemsChanged = await applyCorrection(params.caseId, finding);
    } else {
      const status = action === "resolve_as_is" ? "RESOLVED_AS_IS" : action === "ignore" ? "IGNORED" : "OPEN";
      await prisma.validationFinding.update({
        where: { id: finding.id },
        data: {
          status,
          resolvedById: status === "OPEN" ? null : ctx.user.id,
          resolvedAt: status === "OPEN" ? null : new Date(),
        },
      });
    }

    // Re-run the pipeline so every downstream gate reflects the disposition.
    if (itemsChanged) await recomputeCosts(params.caseId);
    const v = await persistCaseValidation(params.caseId, ctx.firm.id);

    await audit(ctx, "validation.finding_action", {
      type: "validationFinding",
      id: finding.id,
      caseId: params.caseId,
      meta: { action, service: finding.service, result: finding.result, itemsChanged },
    });

    const findings = await prisma.validationFinding.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "asc" } });
    const openBlocking = findings.filter((f) => f.exportBlocking && f.status === "OPEN").length;
    return ok({ findings, blocking: openBlocking, counts: v.counts, itemsChanged });
  } catch (err) {
    return handleError(err);
  }
}
