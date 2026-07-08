import { prisma } from "@/lib/db";
import { PLANS } from "@/lib/subscription/plans";
import type { PlanTier } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Billing abstraction. Runs in one of two modes:
//   • mock  (default) — plan changes apply instantly in the DB, no charges.
//   • live  — swap the mock bodies for the Stripe SDK using STRIPE_SECRET_KEY.
// The rest of the app only ever calls these functions, so going live is a
// localized change here plus wiring the webhook route.
// ─────────────────────────────────────────────────────────────────────────────

export function billingMode(): "mock" | "live" {
  return process.env.STRIPE_SECRET_KEY ? "live" : "mock";
}

export interface CheckoutResult {
  mode: "mock" | "live";
  /** In live mode this is the Stripe Checkout URL to redirect to. */
  url?: string;
  applied: boolean;
}

/**
 * Move a firm to a new plan tier. In mock mode we activate immediately; in live
 * mode this would create a Stripe Checkout / subscription update session.
 */
export async function changePlan(firmId: string, tier: PlanTier): Promise<CheckoutResult> {
  const plan = PLANS[tier];

  if (billingMode() === "live") {
    // TODO(live billing): create/update the Stripe subscription here, e.g.
    //   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    //   const session = await stripe.checkout.sessions.create({ ... price: plan.stripePriceId });
    //   return { mode: "live", url: session.url!, applied: false };
    // The webhook (src/app/api/billing/webhook) then flips the subscription to
    // ACTIVE once payment settles.
    throw new Error("Live Stripe billing not configured. Provide STRIPE_SECRET_KEY and price ids.");
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await prisma.subscription.update({
    where: { firmId },
    data: {
      tier,
      status: "ACTIVE",
      seats: plan.seatLimit,
      stripePriceId: plan.stripePriceId ?? null,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      canceledAt: null,
    },
  });

  return { mode: "mock", applied: true };
}

export async function cancelPlan(firmId: string): Promise<void> {
  await prisma.subscription.update({
    where: { firmId },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
}
