import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { recordCorrectionExemplar, type CorrectionCategory } from "@/lib/llm/correctionExemplars";
import { ok, handleError } from "@/lib/api";

// Human verification and correction of one extracted encounter.
//   PATCH  — correct/supplement structured fields → HUMAN_EDITED (audited).
//   POST   — { action: "verify" | "review" | "reject" } — verification is a
//            records.verify act (canonical, case-scoped, never satisfied by
//            platform/super-admin status alone). Corrections verified here
//            become firm-scoped, fact-free learning exemplars.
const EDITABLE = ["factualSummary", "provider", "providerCredentials", "facility", "encounterType", "substanceClass"] as const;

const patchSchema = z.object({
  factualSummary: z.string().min(3).max(2000).optional(),
  provider: z.string().max(200).nullable().optional(),
  providerCredentials: z.string().max(60).nullable().optional(),
  facility: z.string().max(200).nullable().optional(),
  encounterType: z.string().max(60).nullable().optional(),
  encounterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Reviewer reclassification: promote an excluded administrative/ancillary
  // encounter onto the timeline, or demote a misfiled one off it.
  substanceClass: z.enum(["CLINICAL", "ANCILLARY", "ADMINISTRATIVE"]).optional(),
  reviewNote: z.string().max(2000).optional(),
});

const actionSchema = z.object({
  action: z.enum(["verify", "review", "reject"]),
  note: z.string().max(2000).optional(),
  category: z.enum(["WRONG_FIELD", "BOILERPLATE_REMOVED", "DATE_CORRECTED", "PROVIDER_CORRECTED", "EXCERPT_MISMATCH", "SUMMARY_REWORDED", "OTHER"]).optional(),
});

type Params = { params: Promise<{ caseId: string; encounterId: string }> };

async function load(caseId: string, encounterId: string, firmId: string) {
  return prisma.extractedEncounter.findFirst({ where: { id: encounterId, caseId, firmId } });
}

export async function PATCH(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = patchSchema.parse(await req.json());
    const existing = await load(params.caseId, params.encounterId, ctx.firm.id);
    if (!existing) return ok({ error: "Encounter not found" }, 404);

    const editedFields = new Set<string>(Array.isArray(existing.editedFields) ? (existing.editedFields as string[]) : []);
    for (const f of EDITABLE) if (input[f] !== undefined) editedFields.add(f);
    const dateProvided = input.encounterDate !== undefined;
    if (dateProvided) editedFields.add("encounterDate");

    const updated = await prisma.extractedEncounter.update({
      where: { id: existing.id },
      data: {
        ...(input.factualSummary !== undefined ? { factualSummary: input.factualSummary } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.providerCredentials !== undefined ? { providerCredentials: input.providerCredentials } : {}),
        ...(input.facility !== undefined ? { facility: input.facility } : {}),
        ...(input.encounterType !== undefined ? { encounterType: input.encounterType } : {}),
        ...(input.substanceClass !== undefined
          ? { substanceClass: input.substanceClass, substanceReason: "Classified by reviewer." }
          : {}),
        ...(dateProvided
          ? input.encounterDate
            ? { encounterDate: new Date(`${input.encounterDate}T00:00:00Z`), dateStatus: "DOCUMENTED" }
            : { encounterDate: null, dateStatus: "UNKNOWN" }
          : {}),
        ...(input.reviewNote !== undefined ? { reviewNote: input.reviewNote } : {}),
        editedFields: [...editedFields] as never,
        // A human correction is always visible as such; verification is a
        // separate explicit act and is never implied by an edit.
        status: existing.status === "VERIFIED" || existing.status === "REVIEWED" ? "HUMAN_EDITED" : "HUMAN_EDITED",
        reviewedById: ctx.user.id,
        reviewedAt: new Date(),
      },
    });
    await audit(ctx, "records.encounter_edit", { type: "extractedEncounter", id: existing.id, caseId: params.caseId, meta: { fields: [...editedFields] } });
    return ok({ encounter: updated });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = actionSchema.parse(await req.json());
    const existing = await load(params.caseId, params.encounterId, ctx.firm.id);
    if (!existing) return ok({ error: "Encounter not found" }, 404);

    if (input.action === "reject") {
      const updated = await prisma.extractedEncounter.update({
        where: { id: existing.id },
        data: { status: "SUPERSEDED", staleReason: `Rejected on human review${input.note ? `: ${input.note}` : ""}`, reviewedById: ctx.user.id, reviewedAt: new Date() },
      });
      await audit(ctx, "records.encounter_reject", { type: "extractedEncounter", id: existing.id, caseId: params.caseId });
      return ok({ encounter: updated });
    }

    const verify = input.action === "verify";
    const updated = await prisma.extractedEncounter.update({
      where: { id: existing.id },
      data: {
        status: verify ? "VERIFIED" : "REVIEWED",
        reviewedById: ctx.user.id,
        reviewedAt: new Date(),
        ...(verify ? { verifiedById: ctx.user.id, verifiedAt: new Date() } : {}),
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    });

    // A VERIFIED correction (human-edited fields exist) becomes a firm-scoped,
    // fact-free learning exemplar for future drafts.
    const edited = Array.isArray(existing.editedFields) ? (existing.editedFields as string[]) : [];
    if (verify && edited.length) {
      const doc = await prisma.document.findFirst({ where: { id: existing.sourceDocumentId, firmId: ctx.firm.id }, select: { type: true } });
      await recordCorrectionExemplar({
        firmId: ctx.firm.id,
        caseId: params.caseId,
        encounterId: existing.id,
        documentType: doc?.type ?? null,
        category: (input.category ?? "OTHER") as CorrectionCategory,
        draft: { factualSummary: existing.factualSummary, provider: existing.provider, facility: existing.facility, encounterType: existing.encounterType },
        corrected: { factualSummary: updated.factualSummary, provider: updated.provider, facility: updated.facility, encounterType: updated.encounterType },
        reviewerId: ctx.user.id,
        promptVersion: existing.promptVersion,
        schemaVersion: existing.schemaVersion,
        model: existing.model,
      }).catch(() => {});
    }

    await audit(ctx, verify ? "records.encounter_verify" : "records.encounter_review", { type: "extractedEncounter", id: existing.id, caseId: params.caseId });
    return ok({ encounter: updated });
  } catch (err) {
    return handleError(err);
  }
}
