import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { isAttorneyPresentationForCase } from "@/lib/authz/effective";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  credentials: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  facility: z.string().nullable().optional(),
  contact: z.string().nullable().optional(),
  isTreating: z.boolean().optional(),
  status: z.enum(["SUGGESTED", "CONFIRMED", "DISMISSED"]).optional(),
  depositionSummary: z.string().max(20000).nullable().optional(),
  attorneyNotes: z.string().max(20000).nullable().optional(),
});

// The retaining attorney may contribute ONLY these fields — never clinical or
// roster edits. Everything else stays behind case.edit.
const ATTORNEY_FIELDS = new Set(["depositionSummary", "attorneyNotes"]);

export async function PATCH(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string; providerId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    const input = patchSchema.parse(await req.json());
    const attorneyOnlyPatch =
      ctx.user.role === "ATTORNEY_REVIEWER" &&
      Object.keys(input).length > 0 &&
      Object.keys(input).every((k) => ATTORNEY_FIELDS.has(k)) &&
      (await isAttorneyPresentationForCase({ userId: ctx.user.id, firmId: ctx.firm.id, role: ctx.user.role, caseId: params.caseId }));
    if (attorneyOnlyPatch) {
      requirePermission(ctx, "case.view");
    } else {
      requirePermission(ctx, "case.edit");
    }
    await requireCase(ctx, params.caseId);
    const res = await prisma.treatingProvider.updateMany({ where: { id: params.providerId, caseId: params.caseId }, data: input });
    if (res.count === 0) return ok({ error: "Provider not found" }, 404);
    await audit(ctx, attorneyOnlyPatch ? "provider.attorney_input" : "provider.edit", { type: "treatingProvider", id: params.providerId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string; providerId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    await prisma.treatingProvider.deleteMany({ where: { id: params.providerId, caseId: params.caseId } });
    await audit(ctx, "provider.remove", { type: "treatingProvider", id: params.providerId, caseId: params.caseId });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
