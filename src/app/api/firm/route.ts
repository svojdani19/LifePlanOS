import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  state: z.string().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  letterhead: z.string().max(2000).optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
});

export async function PATCH(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "firm.settings");
    const input = patchSchema.parse(await req.json());
    const firm = await prisma.firm.update({
      where: { id: ctx.firm.id },
      data: { ...input, logoUrl: input.logoUrl || null },
    });
    await audit(ctx, "firm.settings.update", { type: "firm", id: firm.id, meta: input });
    return ok({ firm });
  } catch (err) {
    return handleError(err);
  }
}
