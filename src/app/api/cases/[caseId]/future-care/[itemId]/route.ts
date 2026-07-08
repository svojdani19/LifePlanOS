import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { project } from "@/lib/engine/cost";
import { assumptionsFor, generateReviews } from "@/lib/engine/generate";
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
    const item = await prisma.futureCareItem.findFirst({ where: { id: params.itemId, caseId: params.caseId } });
    if (!item) return ok({ error: "Item not found" }, 404);

    const input = patchSchema.parse(await req.json());
    const merged = { ...item, ...input };
    const p = project(
      { category: item.category, unitCost: merged.unitCost, frequencyPerYear: merged.frequencyPerYear, durationYears: merged.durationYears, isLifetime: merged.isLifetime },
      assumptionsFor(c),
    );

    const updated = await prisma.futureCareItem.update({
      where: { id: item.id },
      data: {
        ...input,
        edited: true,
        unitCost: p.unitCost,
        annualCost: p.annualCost,
        lifetimeCost: p.lifetimeCost,
        presentValue: p.presentValue,
        lowCost: p.lowCost,
        highCost: p.highCost,
      },
    });

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
    await prisma.futureCareItem.deleteMany({ where: { id: params.itemId, caseId: params.caseId } });
    await generateReviews(params.caseId);
    await audit(ctx, "futurecare.delete", { type: "futureCareItem", id: params.itemId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
