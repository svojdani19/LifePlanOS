import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import { generateReviews, paraphraseSummary, recomputeCosts } from "@/lib/engine/generate";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { refreshCaseAttestations } from "@/lib/engine/attestationService";
import { lifecycleFor } from "@/lib/engine/lifecycle";
import { ok, handleError } from "@/lib/api";

const schema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "MODIFIED", "PENDING"]),
  note: z.string().optional(),
  // Physician may set/adjust clinical parameters on sign-off.
  probability: z.enum(["PROBABLE", "POSSIBLE", "SPECULATIVE", "NOT_SUPPORTED"]).optional(),
  frequencyPerYear: z.number().min(0).optional(),
  durationYears: z.number().min(0).nullable().optional(),
  // Structured correction taxonomy — why the physician rejected or modified.
  reasonCode: z
    .enum(["WRONG_INDICATION", "NOT_CAUSALLY_RELATED", "FREQUENCY_EXCESSIVE", "FREQUENCY_INSUFFICIENT", "DURATION_WRONG", "DUPLICATIVE", "COST_WRONG", "INSUFFICIENT_EVIDENCE", "OTHER"])
    .optional(),
});

// Physician review workflow (Module 12): approve / reject / modify an item and
// attach a medical-necessity statement. Restricted to physician.review permission.
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string; itemId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "physician.review", { caseId: params.caseId });
    // Review-class decision: requires a verified PHYSICIAN credential —
    // enforced for enterprise/demo firms, logged as credential.gap otherwise.
    await enforceReviewCredential(ctx, "PHYSICIAN", { action: "futurecare.physician_review", caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const item = await prisma.futureCareItem.findFirst({ where: { id: params.itemId, caseId: params.caseId, supersededAt: null } });
    if (!item) return ok({ error: "Item not found" }, 404);

    const input = schema.parse(await req.json());
    const note = input.note ?? item.physicianNote;
    // A physician setting a FINITE duration is bounding the item — the
    // lifetime flag must yield, or the stated duration would be silently
    // ignored by every downstream quantity and cost computation.
    const boundedDuration = typeof input.durationYears === "number";
    const merged = {
      service: item.service,
      rationale: item.rationale,
      probability: input.probability ?? item.probability,
      frequencyPerYear: input.frequencyPerYear ?? item.frequencyPerYear,
      isLifetime: boundedDuration ? false : item.isLifetime,
      durationYears: input.durationYears !== undefined ? input.durationYears : item.durationYears,
      evidenceStrength: item.evidenceStrength,
    };
    // Auto-regenerate the paraphrased summary, folding in the physician's note
    // when the item is modified (or when a note is provided on approve/reject).
    const summary = paraphraseSummary(merged, input.status === "MODIFIED" || input.note ? note : null);
    const newLifecycle = lifecycleFor(input.status);
    const clinicalChanged =
      merged.probability !== item.probability ||
      merged.frequencyPerYear !== item.frequencyPerYear ||
      merged.durationYears !== item.durationYears ||
      merged.isLifetime !== item.isLifetime;
    const updated = await prisma.futureCareItem.update({
      where: { id: item.id },
      data: {
        physicianStatus: input.status,
        lifecycleStatus: newLifecycle as never,
        physicianNote: note,
        probability: merged.probability,
        frequencyPerYear: merged.frequencyPerYear,
        durationYears: merged.durationYears,
        isLifetime: merged.isLifetime,
        physicianSummary: summary,
      },
    });
    // A changed frequency/duration/horizon changes the item's quantities and
    // dollars — recompute the cost projections immediately so totals, the
    // attestation snapshot, and the printed tables all reflect the decision.
    if (clinicalChanged) await recomputeCosts(params.caseId);

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
        reasonCode: input.reasonCode ?? null,
        // Field-level before→after diff: the physician's correction signal the
        // learning loop consumes. (Legacy rows hold bare field-name arrays.)
        modifiedFields: [
          ...(input.probability !== undefined && input.probability !== item.probability ? [{ field: "probability", from: item.probability, to: input.probability }] : []),
          ...(input.frequencyPerYear !== undefined && input.frequencyPerYear !== item.frequencyPerYear ? [{ field: "frequencyPerYear", from: item.frequencyPerYear, to: input.frequencyPerYear }] : []),
          ...(input.durationYears !== undefined && input.durationYears !== item.durationYears ? [{ field: "durationYears", from: item.durationYears, to: input.durationYears }] : []),
        ],
      },
    });

    await generateReviews(params.caseId);
    // Review actions change inclusion eligibility — refresh persisted findings
    // and the clinical reasoning assessment (physician status is a material
    // field). Incremental: only the reviewed item is reassessed (§19).
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});
    await persistCaseReasoning(params.caseId, ctx.firm.id, { recommendationIds: [params.itemId], actorUserId: ctx.user.id, reviewDecision: true }).catch(() => {});
    // A review action can materially change a signed-over item — re-verify any
    // active attestations (EPIC-005; drifted signatures are invalidated).
    await refreshCaseAttestations(params.caseId).catch(() => {});
    await audit(ctx, "physician.review", { type: "futureCareItem", id: item.id, caseId: params.caseId, meta: { status: input.status } });
    return ok({ item: updated });
  } catch (err) {
    return handleError(err);
  }
}
