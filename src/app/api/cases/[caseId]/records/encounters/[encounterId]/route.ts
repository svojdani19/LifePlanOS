import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { recordCorrectionExemplar, type CorrectionCategory } from "@/lib/llm/correctionExemplars";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { ok, handleError } from "@/lib/api";

// Human verification and correction of one extracted encounter.
//
//   PATCH — correct/supplement structured fields → HUMAN_EDITED (audited).
//           Editing VERIFIED content revokes the verification and requires a
//           documented reason; a note-only edit changes nothing material and
//           preserves the review state.
//   POST  — { action: "verify" | "review" | "reject" }.
//
// Verification is a statement about CONTENT, so the Verify action hashes the
// exact persisted content it verifies and stores that hash atomically with the
// status, reviewer, and timestamp (compare-and-set on updatedAt — a row that
// changed after it was read cannot be verified by mistake). Re-verifying
// unchanged content is idempotent. All of it is a records.verify act:
// canonical, case-scoped, never satisfied by platform/super-admin status.

/** Fields whose change alters the MEANING a verifier signed off on. */
const MATERIAL_FIELDS = ["factualSummary", "provider", "providerCredentials", "facility", "encounterType", "encounterDate", "substanceClass"] as const;

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
  // Stale-payload protection: the hash of the content the reviewer was
  // looking at. When provided and it no longer matches the persisted row,
  // verification is refused rather than silently blessing content the
  // reviewer never saw.
  expectedContentHash: z.string().length(64).optional(),
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

    const materialTouched = MATERIAL_FIELDS.filter((f) => input[f] !== undefined);

    // A note-only edit is NONMATERIAL: it must never demote a review state or
    // disturb a verification hash.
    if (materialTouched.length === 0) {
      if (input.reviewNote === undefined) return ok({ encounter: existing });
      const updated = await prisma.extractedEncounter.update({ where: { id: existing.id }, data: { reviewNote: input.reviewNote } });
      await audit(ctx, "records.encounter_note", { type: "extractedEncounter", id: existing.id, caseId: params.caseId });
      return ok({ encounter: updated });
    }

    // Editing VERIFIED content revokes the verification — and revoking a
    // colleague's (or your own) verification requires saying why.
    const revokesVerification = existing.status === "VERIFIED";
    if (revokesVerification && !input.reviewNote) {
      return ok({ error: "Editing verified content revokes its verification; a documented reason (reviewNote) is required." }, 400);
    }

    const editedFields = new Set<string>(Array.isArray(existing.editedFields) ? (existing.editedFields as string[]) : []);
    for (const f of materialTouched) editedFields.add(f);
    const dateProvided = input.encounterDate !== undefined;

    // Compare-and-set on updatedAt: an edit lands on the exact version that
    // was read, or not at all.
    const applied = await prisma.extractedEncounter.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
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
        // separate explicit act and is never implied by an edit. A revoked
        // verification clears its hash — the verified bytes no longer exist.
        status: "HUMAN_EDITED",
        ...(revokesVerification ? { verifiedContentHash: null } : {}),
        reviewedById: ctx.user.id,
        reviewedAt: new Date(),
      },
    });
    if (applied.count === 0) {
      return ok({ error: "The encounter changed while you were editing it; reload and reapply your correction." }, 409);
    }
    const updated = await load(params.caseId, params.encounterId, ctx.firm.id);
    await audit(ctx, "records.encounter_edit", {
      type: "extractedEncounter",
      id: existing.id,
      caseId: params.caseId,
      meta: { fields: [...editedFields], ...(revokesVerification ? { revokedVerification: true, reason: input.reviewNote } : {}) },
    });
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

    // The hash of the exact content this verification covers, computed from
    // the latest PERSISTED row — never from anything the client sent.
    const currentHash = encounterContentHash(existing);
    if (input.expectedContentHash && input.expectedContentHash !== currentHash) {
      return ok(
        { error: "The encounter's content changed since it was displayed; review the current content before verifying.", currentContentHash: currentHash },
        409,
      );
    }

    const verify = input.action === "verify";

    // Idempotent: re-verifying unchanged content is a no-op, not a new event.
    if (verify && existing.status === "VERIFIED" && existing.verifiedContentHash === currentHash) {
      return ok({ encounter: existing, idempotent: true });
    }

    // Atomic: status, hash, reviewer and timestamp land together, and only on
    // the exact version that was read (compare-and-set on updatedAt).
    const applied = await prisma.extractedEncounter.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: {
        status: verify ? "VERIFIED" : "REVIEWED",
        reviewedById: ctx.user.id,
        reviewedAt: new Date(),
        ...(verify ? { verifiedById: ctx.user.id, verifiedAt: new Date(), verifiedContentHash: currentHash } : {}),
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    });
    if (applied.count === 0) {
      return ok({ error: "The encounter changed while you were verifying it; review the current content and verify again.", currentContentHash: null }, 409);
    }
    const updated = await load(params.caseId, params.encounterId, ctx.firm.id);

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
        corrected: { factualSummary: updated?.factualSummary, provider: updated?.provider, facility: updated?.facility, encounterType: updated?.encounterType },
        reviewerId: ctx.user.id,
        promptVersion: existing.promptVersion,
        schemaVersion: existing.schemaVersion,
        model: existing.model,
      }).catch(() => {});
    }

    await audit(ctx, verify ? "records.encounter_verify" : "records.encounter_review", {
      type: "extractedEncounter",
      id: existing.id,
      caseId: params.caseId,
      meta: verify ? { verifiedContentHash: currentHash } : {},
    });
    return ok({ encounter: updated });
  } catch (err) {
    return handleError(err);
  }
}
