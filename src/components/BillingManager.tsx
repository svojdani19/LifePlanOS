"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

interface PlanDef {
  tier: string;
  name: string;
  blurb: string;
  monthlyPrice: number;
  seatLimit: number;
  caseLimit: number | null;
  features: string[];
}

interface State {
  subscription: { tier: string; status: string } | null;
  plan: PlanDef;
  limits: { caseLimit: number | null; seatLimit: number };
  usage: { activeCases: number; seats: number };
  billingMode: "mock" | "live";
}

const CATALOG: Record<string, { price: number; caseLimit: number | null; seatLimit: number; features: string[] }> = {
  SOLO: { price: 3000, caseLimit: 10, seatLimit: 2, features: ["Chronology", "Future care", "Cost projection", "Defense flags", "DOCX/PDF export"] },
  SMALL_FIRM: { price: 7000, caseLimit: 75, seatLimit: 10, features: ["Everything in Solo", "Physician review", "Firm templates", "Version comparison", "Recommendation library"] },
  ENTERPRISE: { price: 10000, caseLimit: null, seatLimit: 100, features: ["Everything in Small Firm", "Unlimited cases", "SSO", "Benchmarking", "API access", "BAA"] },
};
const ORDER = ["SOLO", "SMALL_FIRM", "ENTERPRISE"];

export function BillingManager() {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/billing/subscription");
    if (res.ok) setState(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function change(tier: string) {
    setBusy(tier);
    const res = await fetch("/api/billing/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json();
    setBusy(null);
    if (res.ok && data.url) {
      window.location.href = data.url; // live Stripe checkout
      return;
    }
    await load();
    router.refresh();
  }

  if (!state) return <p className="text-sm text-ink-500">Loading billing…</p>;
  const current = state.subscription?.tier;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">Current: {state.plan.name}</Badge>
        <Badge tone={state.subscription?.status === "ACTIVE" ? "green" : "amber"}>
          {state.subscription?.status?.toLowerCase() ?? "—"}
        </Badge>
        <Badge tone={state.billingMode === "live" ? "green" : "slate"}>
          {state.billingMode === "live" ? "Stripe live" : "Mock billing (no charges)"}
        </Badge>
      </div>

      {/* Usage vs. limits */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <UsageBar label="Active Cases" used={state.usage.activeCases} limit={state.limits.caseLimit} />
        <UsageBar label="Seats" used={state.usage.seats} limit={state.limits.seatLimit} />
      </div>

      {/* Plans */}
      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {ORDER.map((tier) => {
          const c = CATALOG[tier];
          const isCurrent = tier === current;
          const featured = tier === "SMALL_FIRM";
          return (
            <div key={tier} className={"card flex flex-col p-6 " + (featured ? "ring-2 ring-brand-500" : "")}>
              <h3 className="text-lg font-bold text-ink-900 capitalize">{tier.toLowerCase().replace("_", " ")}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-extrabold text-ink-900">${c.price}</span>
                <span className="text-sm text-ink-500">/mo</span>
              </div>
              <ul className="mt-4 space-y-1.5 text-sm text-ink-700">
                <li>{c.seatLimit} seats</li>
                <li>{c.caseLimit === null ? "Unlimited cases" : `${c.caseLimit} active cases`}</li>
                {c.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                    {f}
                  </li>
                ))}
              </ul>
              <button
                disabled={isCurrent || busy === tier}
                onClick={() => change(tier)}
                className={"mt-6 " + (isCurrent ? "btn-outline cursor-default" : "btn-primary")}
              >
                {isCurrent ? "Current Plan" : busy === tier ? "Updating…" : "Switch to This Plan"}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-ink-500">
        In mock mode plan changes apply instantly with no charge. Add a Stripe secret key to enable real checkout.
      </p>
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : Math.min(100, (used / Math.max(limit, 1)) * 100);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-ink-600">{label}</span>
        <span className="font-medium text-ink-900">
          {used}
          {limit === null ? " / ∞" : ` / ${limit}`}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100">
        <div className={"h-full rounded-full " + (pct > 85 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
