import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { generateReviews, paraphraseSummary } from "@/lib/engine/generate";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { lifecycleFor } from "@/lib/engine/lifecycle";
import { ok, handleError } from "@/lib/api";

const schema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "MODIFIED", "PENDING"]),
  note: z.string().optional(),
  // Physician may set/adjust clinical parameters on sign-off.
  probability: z.enum(["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"]).optional(),
  frequencyPerYear: z.number().min(0).optional(),
  durationYears: z.number().min(0).nullable().optional(),
});

// Physician review workflow (Module 12): approve / reject / modify an item and
// attach a medical-necessity statement. Restricted to physician.review permission.
export async function POST(req: Request, { params }: { params: { caseId: string; itemId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "physician.review");
    await requireCase(ctx, params.caseId);
    const item = await prisma.futureCareItem.findFirst({ where: { id: params.itemId, caseId: params.caseId, supersededAt: null } });
    if (!item) return ok({ error: "Item not found" }, 404);

    const input = schema.parse(await req.json());
    const note = input.note ?? item.physicianNote;
    const merged = {
      service: item.service,
      rationale: item.rationale,
      probability: input.probability ?? item.probability,
      frequencyPerYear: input.frequencyPerYear ?? item.frequencyPerYear,
      isLifetime: item.isLifetime,
      durationYears: input.durationYears !== undefined ? input.durationYears : item.durationYears,
      evidenceStrength: item.evidenceStrength,
    };
    // Auto-regenerate the paraphrased summary, folding in the physician's note
    // when the item is modified (or when a note is provided on approve/reject).
    const summary = paraphraseSummary(merged, input.status === "MODIFIED" || input.note ? note : null);
    const newLifecycle = lifecycleFor(input.status);
    const updated = await prisma.futureCareItem.update({
      where: { id: item.id },
      data: {
        physicianStatus: input.status,
        lifecycleStatus: newLifecycle as never,
        physicianNote: note,
        probability: merged.probability,
        frequencyPerYear: merged.frequencyPerYear,
        durationYears: merged.durationYears,
        physicianSummary: summary,
      },
    });

    // Ledger the review action (P2.R1 §4).
    await prisma.recommendationTransition.create({
      data: {
        caseId: params.caseId,
        firmId: ctx.firm.id,
        lineageId: item.lineageId,
        itemId: item.id,
        userId: ctx.user.id,
        role: ctx.user.role,
        priorStatus: item.lifecycleStatus,
        newStatus: newLifecycle,
        comment: input.note ?? null,
        modifiedFields: [
          ...(input.probability !== undefined && input.probability !== item.probability ? ["probability"] : []),
          ...(input.frequencyPerYear !== undefined && input.frequencyPerYear !== item.frequencyPerYear ? ["frequencyPerYear"] : []),
          ...(input.durationYears !== undefined && input.durationYears !== item.durationYears ? ["durationYears"] : []),
        ],
      },
    });

    await generateReviews(params.caseId);
    // Review actions change inclusion eligibility — refresh persisted findings
    // and the clinical reasoning assessment (physician status is a material
    // field). Incremental: only the reviewed item is reassessed (§19).
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
    await persistCaseReasoning(params.caseId, ctx.firm.id, { recommendationIds: [params.itemId], actorUserId: ctx.user.id }).catch(() => {});
    await audit(ctx, "physician.review", { type: "futureCareItem", id: item.id, caseId: params.caseId, meta: { status: input.status } });
    return ok({ item: updated });
  } catch (err) {
    return handleError(err);
  }
}
