import type { CareCategory } from "@/generated/prisma";
import { UNIT_COSTS } from "@/lib/engine/cost";
import { pricingSourceFor, source } from "@/lib/references/sources";

// ─────────────────────────────────────────────────────────────────────────────
// Pricing-provider seam. By default LifePlanOS prices a coded service from its
// static per-category reference (illustrative national figure) and labels it
// with the professional source that WOULD supply the real number (FAIR Health,
// GoodRx, Genworth, …). A LIVE provider — a FAIR Health CPT/ZIP lookup, a GoodRx
// generic-median query, a Genworth cost-of-care figure — is pluggable here and
// returns a sourced, venue-specific amount.
//
// Live pricing runs only when PRICING_PROVIDER is set AND the provider's
// credentials are present (most are LICENSED — FAIR Health requires a data
// license). Otherwise it refuses with a clear setup error rather than inventing
// a number or silently falling back, so a missing feed is loud, not a quiet
// unsourced figure. Pure/default path does no network.
// ─────────────────────────────────────────────────────────────────────────────

export interface PricedUnit {
  unit: number; // expected unit cost (USD)
  source: string; // human-readable pricing basis actually used
  cpt?: string;
  live: boolean; // true only when a real, sourced lookup produced the figure
}

export interface PricingQuery {
  category: CareCategory;
  cpt?: string | null;
  zip?: string | null;
  percentile?: 50 | 80; // FAIR Health percentile (default 80 per CLCP convention)
}

export type PricingProviderName = "static" | "fairhealth" | "goodrx" | "genworth";

const CREDS: Record<Exclude<PricingProviderName, "static">, string[]> = {
  fairhealth: ["FAIRHEALTH_API_KEY"],
  goodrx: ["GOODRX_API_KEY"],
  genworth: ["GENWORTH_DATA_KEY"],
};

/** Static, no-network pricing: the reference figure, labeled with the source that
 *  would supply the real amount. `live:false` marks it as an override-required
 *  benchmark, not a sourced lookup. */
export function staticPrice(q: PricingQuery): PricedUnit {
  const ref = UNIT_COSTS[q.category];
  return { unit: ref.unit, source: pricingSourceFor(q.category).label, cpt: ref.cpt ?? undefined, live: false };
}

function setupError(name: PricingProviderName, detail: string): Error {
  return new Error(`Pricing provider "${name}" is selected but ${detail}. It is a licensed data feed; add credentials and the adapter (see docs/12_DEPLOYMENT.md). No figure was invented.`);
}

/**
 * Resolve a sourced unit cost. Uses the live provider when configured; otherwise
 * returns the static reference. The live adapters are intentionally guarded stubs
 * — implement the API call here once the data license and key are in place and
 * every figure downstream becomes venue-specific and sourced automatically.
 */
export async function resolveUnitCost(q: PricingQuery): Promise<PricedUnit> {
  const provider = (process.env.PRICING_PROVIDER ?? "static").toLowerCase() as PricingProviderName;
  if (provider === "static" || !(provider in CREDS)) return staticPrice(q);
  const missing = CREDS[provider as Exclude<PricingProviderName, "static">].filter((k) => !process.env[k]);
  if (missing.length) throw setupError(provider, `missing credentials: ${missing.join(", ")}`);
  // Credentials present but the adapter is not implemented yet.
  const srcLabel = source(provider === "goodrx" ? "goodrx" : provider === "genworth" ? "genworth" : "fairhealth")?.label ?? provider;
  throw setupError(provider, `its adapter is not implemented — wire the ${srcLabel} lookup in resolveUnitCost()`);
}
