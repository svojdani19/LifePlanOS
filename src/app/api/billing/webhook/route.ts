import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook. In mock billing mode there are no events and this is a no-op.
// In live mode it verifies the signature with STRIPE_WEBHOOK_SECRET and syncs
// the firm's Subscription from Stripe events.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ received: true, mode: "mock" });
  }

  const body = await req.text();
  const sig = headers().get("stripe-signature");
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig ?? "", secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid signature";
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const firmId = s.metadata?.firmId;
        const tier = s.metadata?.tier as "SOLO" | "SMALL_FIRM" | "ENTERPRISE" | undefined;
        if (firmId) {
          await prisma.subscription.update({
            where: { firmId },
            data: {
              status: "ACTIVE",
              ...(tier ? { tier } : {}),
              stripeCustomerId: (s.customer as string) ?? undefined,
              stripeSubscriptionId: (s.subscription as string) ?? undefined,
              canceledAt: null,
            },
          });
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const period = sub as unknown as { current_period_start?: number; current_period_end?: number };
        const firmId = sub.metadata?.firmId;
        const status = sub.cancel_at_period_end ? "CANCELED" : sub.status === "past_due" ? "PAST_DUE" : sub.status === "active" ? "ACTIVE" : "TRIALING";
        await prisma.subscription.updateMany({
          where: firmId ? { firmId } : { stripeSubscriptionId: sub.id },
          data: {
            status,
            currentPeriodStart: period.current_period_start ? new Date(period.current_period_start * 1000) : undefined,
            currentPeriodEnd: period.current_period_end ? new Date(period.current_period_end * 1000) : undefined,
          },
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: { status: "CANCELED", canceledAt: new Date() },
        });
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = (inv as unknown as { subscription?: string }).subscription;
        if (subId) await prisma.subscription.updateMany({ where: { stripeSubscriptionId: subId }, data: { status: "PAST_DUE" } });
        break;
      }
    }
  } catch {
    // Never fail the webhook on a downstream error — Stripe would retry forever.
    return NextResponse.json({ received: true, handled: false });
  }

  return NextResponse.json({ received: true });
}
