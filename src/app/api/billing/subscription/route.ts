import { z } from "zod";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { changePlan, cancelPlan, billingMode } from "@/lib/stripe";
import { PLANS, effectiveLimits } from "@/lib/subscription/plans";
import { activeCaseCount, seatCount } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "billing.manage");
    const sub = ctx.subscription;
    const limits = effectiveLimits(sub?.tier ?? "SOLO", sub ?? undefined);
    return ok({
      subscription: sub,
      plan: PLANS[sub?.tier ?? "SOLO"],
      limits,
      usage: { activeCases: await activeCaseCount(ctx.firm.id), seats: await seatCount(ctx.firm.id) },
      billingMode: billingMode(),
    });
  } catch (err) {
    return handleError(err);
  }
}

const changeSchema = z.object({ tier: z.enum(["SOLO", "SMALL_FIRM", "ENTERPRISE"]) });

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "billing.manage");
    const { tier } = changeSchema.parse(await req.json());
    const result = await changePlan(ctx.firm.id, tier);
    await audit(ctx, "subscription.change", { type: "subscription", meta: { tier, mode: result.mode } });
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "billing.manage");
    await cancelPlan(ctx.firm.id);
    await audit(ctx, "subscription.cancel", { type: "subscription" });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
