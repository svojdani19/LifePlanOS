import { NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook endpoint. In mock billing mode there are no events; this route
// exists so going live is purely additive.
//
// TODO(live billing): verify the signature with STRIPE_WEBHOOK_SECRET and handle
//   • checkout.session.completed  → set subscription ACTIVE, store stripe ids
//   • customer.subscription.updated → sync tier / period / status
//   • customer.subscription.deleted → set CANCELED
//   • invoice.payment_failed → set PAST_DUE
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ received: true, mode: "mock" });
  }
  // Placeholder for signature verification + event dispatch.
  const _body = await req.text();
  return NextResponse.json({ received: true });
}
