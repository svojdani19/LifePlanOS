import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  summary: z.string().optional(),
  provider: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  diagnosis: z.string().nullable().optional(),
  treatment: z.string().nullable().optional(),
  objectiveFindings: z.string().nullable().optional(),
  relevanceScore: z.number().min(0).max(100).optional(),
  relatedness: z.enum(["RELATED", "AGGRAVATION", "PREEXISTING_UNRELATED", "SUBSEQUENT_UNRELATED", "UNCLEAR"]).optional(),
});

// Edit a chronology event; marks it human-edited to preserve the audit trail.
export async function PATCH(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string; eventId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "chronology.edit");
    await requireCase(ctx, params.caseId);
    const input = patchSchema.parse(await req.json());
    const updated = await prisma.chronologyEvent.updateMany({
      where: { id: params.eventId, caseId: params.caseId },
      // A human edit is preserved across regenerations and visibly labeled;
      // it is NOT verification — that is a separate explicit act below.
      data: { ...input, edited: true, reviewStatus: "HUMAN_EDITED", reviewedById: ctx.user.id, reviewedAt: new Date() },
    });
    if (updated.count === 0) return ok({ error: "Event not found" }, 404);
    await audit(ctx, "chronology.edit", { type: "chronologyEvent", id: params.eventId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}

const actionSchema = z.object({ action: z.enum(["verify", "review", "reopen"]), note: z.string().max(1000).optional() });

// Factual verification of a chronology event — a records.verify act
// (canonical, case-scoped; platform/super-admin status alone never grants it,
// and it requires no physician credential because it asserts no medical
// opinion). Verification never carries to materially changed content: a
// source change resets the row to STALE via the regeneration pass.
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string; eventId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = actionSchema.parse(await req.json());
    const data =
      input.action === "reopen"
        ? { reviewStatus: "AI_DRAFT", reviewedById: null, reviewedAt: null, verifiedById: null, verifiedAt: null }
        : input.action === "verify"
          ? { reviewStatus: "VERIFIED", reviewedById: ctx.user.id, reviewedAt: new Date(), verifiedById: ctx.user.id, verifiedAt: new Date() }
          : { reviewStatus: "REVIEWED", reviewedById: ctx.user.id, reviewedAt: new Date() };
    const updated = await prisma.chronologyEvent.updateMany({ where: { id: params.eventId, caseId: params.caseId }, data });
    if (updated.count === 0) return ok({ error: "Event not found" }, 404);
    await audit(ctx, `chronology.${input.action}`, { type: "chronologyEvent", id: params.eventId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
