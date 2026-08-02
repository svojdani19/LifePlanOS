import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { assumptionsFor, generateReviews, paraphraseSummary } from "@/lib/engine/generate";
import { project } from "@/lib/engine/cost";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { ok, handleError } from "@/lib/api";

// Manually add a future-care item — the path for care the template engine
// missed but the records support. The item enters the normal lifecycle
// exactly like a generated one: PENDING physician review, full validation
// and reasoning assessment, honest origin (PLANNER_ADDED / PHYSICIAN_ADDED
// by creator role), costs projected by the same engine as everything else.

const createSchema = z.object({
  service: z.string().min(3),
  category: z.string().min(1),
  specialty: z.string().min(1),
  conditionId: z.string().nullable().optional(),
  rationale: z.string().min(10, "A clinical rationale is required for a manually added item."),
  cptCode: z.string().nullable().optional(),
  probability: z.enum(["PROBABLE", "POSSIBLE", "SPECULATIVE"]).default("POSSIBLE"),
  frequencyPerYear: z.number().min(0),
  durationYears: z.number().min(0).nullable().optional(),
  isLifetime: z.boolean().default(false),
  unitCost: z.number().min(0),
});

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "futurecare.edit");
    const c = await requireCase(ctx, params.caseId);
    const input = createSchema.parse(await req.json());
    if (!input.isLifetime && input.durationYears == null) {
      return ok({ error: "Provide a duration in years, or mark the item as lifetime care." }, 400);
    }
    if (input.conditionId) {
      const cond = await prisma.condition.findFirst({ where: { id: input.conditionId, caseId: params.caseId } });
      if (!cond) return ok({ error: "Supporting diagnosis not found on this case." }, 400);
    }

    // Same projection engine as generated items — one cost model everywhere.
    const p = project(
      { category: input.category as never, unitCost: input.unitCost, frequencyPerYear: input.frequencyPerYear, durationYears: input.durationYears ?? null, isLifetime: input.isLifetime },
      assumptionsFor(c),
    );

    const origin = ctx.user.role === "PHYSICIAN_REVIEWER" ? "PHYSICIAN_ADDED" : "PLANNER_ADDED";
    const item = await prisma.futureCareItem.create({
      data: {
        caseId: params.caseId,
        conditionId: input.conditionId ?? null,
        category: input.category as never,
        service: input.service,
        specialty: input.specialty,
        rationale: input.rationale,
        cptCode: input.cptCode ?? null,
        probability: input.probability,
        confidence: 50, // manual items carry no engine confidence; midpoint until reviewed
        frequencyPerYear: input.frequencyPerYear,
        durationYears: input.durationYears ?? null,
        isLifetime: input.isLifetime,
        unitCost: input.unitCost,
        annualCost: p.annualCost,
        lifetimeCost: p.lifetimeCost,
        presentValue: p.presentValue,
        lowCost: p.lowCost,
        highCost: p.highCost,
        pricingSource: "Manually entered — verify against the firm pricing library",
        evidenceStrength: "Case-specific — physician confirmation required",
        origin: origin as never,
        missingSupport: "Manually added item — physician confirmation of medical necessity required.",
        physicianSummary: paraphraseSummary({
          service: input.service,
          rationale: input.rationale,
          probability: input.probability,
          frequencyPerYear: input.frequencyPerYear,
          isLifetime: input.isLifetime,
          durationYears: input.durationYears ?? null,
          evidenceStrength: "Case-specific — physician confirmation required",
        }),
      },
    });

    // Same downstream discipline as generation: reviews, validation, and an
    // incremental reasoning assessment for the new item.
    await generateReviews(params.caseId);
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
    await persistCaseReasoning(params.caseId, ctx.firm.id, { recommendationIds: [item.id], actorUserId: ctx.user.id }).catch(() => {});
    await audit(ctx, "futurecare.add", { type: "futureCareItem", id: item.id, caseId: params.caseId, meta: { service: input.service, origin } });
    return ok({ item });
  } catch (err) {
    return handleError(err);
  }
}
