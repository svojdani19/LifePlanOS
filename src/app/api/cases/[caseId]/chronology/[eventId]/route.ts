import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
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
export async function PATCH(req: Request, { params }: { params: { caseId: string; eventId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "chronology.edit");
    await requireCase(ctx, params.caseId);
    const input = patchSchema.parse(await req.json());
    const updated = await prisma.chronologyEvent.updateMany({
      where: { id: params.eventId, caseId: params.caseId },
      data: { ...input, edited: true },
    });
    if (updated.count === 0) return ok({ error: "Event not found" }, 404);
    await audit(ctx, "chronology.edit", { type: "chronologyEvent", id: params.eventId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
