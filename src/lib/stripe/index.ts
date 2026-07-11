import Stripe from "stripe";
import { prisma } from "@/lib/db";
import { PLANS } from "@/lib/subscription/plans";
import type { PlanTier } from "@/generated/prisma";

let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set.");
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const APP_URL = process.env.APP_URL ?? "http://localhost:3100";

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
    if (!plan.stripePriceId) throw new Error(`No Stripe price id configured for the ${tier} plan (set STRIPE_PRICE_${tier}).`);
    const stripe = getStripe();
    const sub = await prisma.subscription.findUnique({ where: { firmId }, include: { firm: true } });
    if (!sub) throw new Error("Subscription not found for firm.");

    // Ensure a Stripe customer exists for the firm.
    let customerId = sub.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ name: sub.firm.name, metadata: { firmId } });
      customerId = customer.id;
      await prisma.subscription.update({ where: { firmId }, data: { stripeCustomerId: customerId } });
    }

    // Hosted Checkout for the subscription; the webhook activates on completion.
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${APP_URL}/billing?status=success`,
      cancel_url: `${APP_URL}/billing?status=cancel`,
      metadata: { firmId, tier },
      subscription_data: { metadata: { firmId, tier } },
    });
    return { mode: "live", url: session.url ?? undefined, applied: false };
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
  if (billingMode() === "live") {
    const sub = await prisma.subscription.findUnique({ where: { firmId } });
    if (sub?.stripeSubscriptionId) {
      await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
    }
  }
  await prisma.subscription.update({
    where: { firmId },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
}
