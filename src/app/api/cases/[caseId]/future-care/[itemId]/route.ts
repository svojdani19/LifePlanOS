import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { project } from "@/lib/engine/cost";
import { assumptionsFor, generateReviews } from "@/lib/engine/generate";
import { materialChanges, changedFields, hasReviewHistory } from "@/lib/engine/lifecycle";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  service: z.string().min(1).optional(),
  rationale: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  cptCode: z.string().nullable().optional(),
  probability: z.enum(["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"]).optional(),
  confidence: z.number().min(0).max(100).optional(),
  frequencyPerYear: z.number().min(0).optional(),
  durationYears: z.number().min(0).nullable().optional(),
  isLifetime: z.boolean().optional(),
  unitCost: z.number().min(0).optional(),
  defenseVulnerability: z.enum(["LOW", "MODERATE", "HIGH"]).optional(),
});

// Edit a future-care item; cost-affecting fields trigger a reprojection. Human
// edits set `edited=true` (preserved on regeneration awareness) and re-run the
// adversarial reviews so flags stay in sync.
export async function PATCH(req: Request, { params }: { params: { caseId: string; itemId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    const c = await requireCase(ctx, params.caseId);
    const item = await prisma.futureCareItem.findFirst({ where: { id: params.itemId, caseId: params.caseId, supersededAt: null } });
    if (!item) return ok({ error: "Item not found" }, 404);

    const input = patchSchema.parse(await req.json());
    const merged = { ...item, ...input };
    // P2.R1 §3 — a material change to an APPROVED/MODIFIED item invalidates the
    // approval. The approved version is preserved verbatim as a superseded copy
    // (with its review actions), and the edited row returns to review.
    const material = materialChanges(input as Record<string, unknown>, item as unknown as Record<string, unknown>);
    const approved = item.physicianStatus === "APPROVED" || item.physicianStatus === "MODIFIED";
    const invalidates = approved && material.length > 0;
    const p = project(
      { category: item.category, unitCost: merged.unitCost, frequencyPerYear: merged.frequencyPerYear, durationYears: merged.durationYears, isLifetime: merged.isLifetime },
      assumptionsFor(c),
    );

    if (invalidates) {
      // Preserve the approved version: a frozen superseded copy carrying the
      // physician's review, pointing forward to the (edited) current row.
      const frozen = await prisma.futureCareItem.create({
        data: {
          caseId: item.caseId,
          conditionId: item.conditionId,
          category: item.category,
          service: item.service,
          rationale: item.rationale,
          specialty: item.specialty,
          cptCode: item.cptCode,
          probability: item.probability,
          confidence: item.confidence,
          frequencyPerYear: item.frequencyPerYear,
          startTrigger: item.startTrigger,
          durationYears: item.durationYears,
          isLifetime: item.isLifetime,
          unitCost: item.unitCost,
          annualCost: item.annualCost,
          lifetimeCost: item.lifetimeCost,
          presentValue: item.presentValue,
          lowCost: item.lowCost,
          highCost: item.highCost,
          pricingSource: item.pricingSource,
          evidenceStrength: item.evidenceStrength,
          literatureSupport: item.literatureSupport,
          citation: item.citation ?? undefined,
          lowerCostAlternative: item.lowerCostAlternative,
          plaintiffValue: item.plaintiffValue,
          defenseVulnerability: item.defenseVulnerability,
          missingSupport: item.missingSupport,
          physicianStatus: item.physicianStatus,
          physicianNote: item.physicianNote,
          physicianSummary: item.physicianSummary,
          edited: item.edited,
          lineageId: item.lineageId,
          version: item.version,
          supersededById: item.id,
          supersededAt: new Date(),
          lifecycleStatus: "SUPERSEDED",
        },
      });
      await prisma.recommendationTransition.create({
        data: {
          caseId: params.caseId,
          firmId: ctx.firm.id,
          lineageId: item.lineageId,
          itemId: frozen.id,
          userId: ctx.user.id,
          role: ctx.user.role,
          priorStatus: item.lifecycleStatus,
          newStatus: "PLANNER_PROPOSED",
          comment: `Material change (${material.join(", ")}) invalidated the prior approval; re-review required.`,
          modifiedFields: material,
          materialChange: true,
        },
      });
      await audit(ctx, "recommendation.approval_invalidated", { type: "futureCareItem", id: item.id, caseId: params.caseId, meta: { lineageId: item.lineageId, fields: material } });
    }

    const updated = await prisma.futureCareItem.update({
      where: { id: item.id },
      data: {
        ...input,
        ...(invalidates
          ? { physicianStatus: "PENDING" as const, lifecycleStatus: "PLANNER_PROPOSED" as const, version: item.version + 1 }
          : {}),
        edited: true,
        unitCost: p.unitCost,
        annualCost: p.annualCost,
        lifetimeCost: p.lifetimeCost,
        presentValue: p.presentValue,
        lowCost: p.lowCost,
        highCost: p.highCost,
      },
    });

    if (!invalidates) {
      const fields = changedFields(input as Record<string, unknown>, item as unknown as Record<string, unknown>);
      if (fields.length) {
        await prisma.recommendationTransition.create({
          data: {
            caseId: params.caseId, firmId: ctx.firm.id, lineageId: item.lineageId, itemId: item.id,
            userId: ctx.user.id, role: ctx.user.role,
            priorStatus: item.lifecycleStatus, newStatus: item.lifecycleStatus,
            comment: "Nonmaterial edit; approval status unchanged.",
            modifiedFields: fields, materialChange: false,
          },
        });
      }
    }
    await generateReviews(params.caseId);
    await audit(ctx, "futurecare.edit", { type: "futureCareItem", id: item.id, caseId: params.caseId });
    return ok({ item: updated });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: { caseId: string; itemId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    await requireCase(ctx, params.caseId);
    const item = await prisma.futureCareItem.findFirst({ where: { id: params.itemId, caseId: params.caseId } });
    if (!item) return ok({ error: "Item not found" }, 404);
    if (hasReviewHistory(item)) {
      // Review actions are work product — retire the item instead of deleting.
      await prisma.futureCareItem.update({ where: { id: item.id }, data: { supersededAt: new Date(), lifecycleStatus: "SUPERSEDED" } });
      await prisma.recommendationTransition.create({
        data: {
          caseId: params.caseId, firmId: ctx.firm.id, lineageId: item.lineageId, itemId: item.id,
          userId: ctx.user.id, role: ctx.user.role,
          priorStatus: item.lifecycleStatus, newStatus: "SUPERSEDED",
          comment: "Removed from the plan by the planner; review history preserved.",
        },
      });
      await audit(ctx, "recommendation.supersede", { type: "futureCareItem", id: item.id, caseId: params.caseId, meta: { lineageId: item.lineageId, reason: "planner removal" } });
    } else {
      await prisma.futureCareItem.deleteMany({ where: { id: params.itemId, caseId: params.caseId } });
      await audit(ctx, "futurecare.delete", { type: "futureCareItem", id: params.itemId, caseId: params.caseId });
    }
    await generateReviews(params.caseId);
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
