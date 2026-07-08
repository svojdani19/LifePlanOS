import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { generateReviews } from "@/lib/engine/generate";
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
    const item = await prisma.futureCareItem.findFirst({ where: { id: params.itemId, caseId: params.caseId } });
    if (!item) return ok({ error: "Item not found" }, 404);

    const input = schema.parse(await req.json());
    const updated = await prisma.futureCareItem.update({
      where: { id: item.id },
      data: {
        physicianStatus: input.status,
        physicianNote: input.note ?? item.physicianNote,
        probability: input.probability ?? item.probability,
        frequencyPerYear: input.frequencyPerYear ?? item.frequencyPerYear,
        durationYears: input.durationYears !== undefined ? input.durationYears : item.durationYears,
      },
    });

    await generateReviews(params.caseId);
    await audit(ctx, "physician.review", { type: "futureCareItem", id: item.id, caseId: params.caseId, meta: { status: input.status } });
    return ok({ item: updated });
  } catch (err) {
    return handleError(err);
  }
}
