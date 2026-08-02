import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Firm engagement pricing config (MDIP docs/28 decision 4). Pricing lives in
// Firm.features["pricing"] as { [reportType]: {fixed?, hourly?, rush?,
// turnaroundDays?} } — no new billing engine, no new table. Guarded by
// firm.settings; every change audited as "pricing.update". Pricing is not an
// authorization input, so authzRevision is deliberately NOT bumped.
// The existing /api/firm PATCH edits scalar branding/retention columns and has
// no Json-merge semantics, hence this dedicated route.
// ─────────────────────────────────────────────────────────────────────────────

const entrySchema = z
  .object({
    fixed: z.number().nonnegative().optional(),
    hourly: z.number().nonnegative().optional(),
    rush: z.number().nonnegative().optional(),
    turnaroundDays: z.number().nonnegative().max(3650).optional(),
  })
  .strict();

const patchSchema = z.object({
  // Full replacement of the pricing map — the editor always submits the whole
  // config. Report types with an empty entry are dropped.
  pricing: z.record(z.string().min(1).max(100), entrySchema),
});

function currentPricing(features: unknown): Record<string, unknown> {
  if (typeof features !== "object" || features === null || Array.isArray(features)) return {};
  const pricing = (features as Record<string, unknown>)["pricing"];
  if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) return {};
  return pricing as Record<string, unknown>;
}

export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "firm.settings");
    return ok({ pricing: currentPricing(ctx.firm.features) });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "firm.settings");
    const input = patchSchema.parse(await req.json());

    // Drop entries with no values so the config never accumulates empty rows.
    const pricing = Object.fromEntries(
      Object.entries(input.pricing).filter(([, entry]) => Object.values(entry).some((v) => v !== undefined)),
    );

    const baseFeatures =
      typeof ctx.firm.features === "object" && ctx.firm.features !== null && !Array.isArray(ctx.firm.features)
        ? (ctx.firm.features as Record<string, unknown>)
        : {};
    const firm = await prisma.firm.update({
      where: { id: ctx.firm.id },
      data: { features: { ...baseFeatures, pricing } as never },
    });
    await audit(ctx, "pricing.update", { type: "firm", id: ctx.firm.id, meta: { pricing } });
    return ok({ pricing: currentPricing(firm.features) });
  } catch (err) {
    return handleError(err);
  }
}
