import type { CareCategory } from "@/generated/prisma";
import { UNIT_COSTS } from "@/lib/engine/cost";
import { pricingSourceFor, source } from "@/lib/references/sources";

// ─────────────────────────────────────────────────────────────────────────────
// Pricing-provider seam. By default LifePlanOS prices a coded service from its
// static per-category reference (illustrative national figure) and labels it
// with the professional source that WOULD supply the real number (FAIR Health,
// GoodRx, Genworth, …).
//
// The FAIR Health adapter is implemented: with PRICING_PROVIDER=fairhealth,
// FAIRHEALTH_API_URL, and FAIRHEALTH_API_KEY set (a licensed data feed), every
// coded service is priced from a live benchmark lookup — venue-specific by
// geozip, at the 80th percentile per CLCP convention — and each figure carries
// its retrieval date and a persisted source snapshot. Uncoded (bundled)
// categories stay on the labeled static reference even in live mode: a
// benchmark feed prices codes, not bundles.
//
// Live pricing runs only when PRICING_PROVIDER is set AND the provider's
// credentials are present. Otherwise it refuses with a clear setup error
// rather than inventing a number or silently falling back, so a missing feed
// is loud, not a quiet unsourced figure. Pure/default path does no network.
// ─────────────────────────────────────────────────────────────────────────────

export interface PricedUnit {
  unit: number; // expected unit cost (USD)
  source: string; // human-readable pricing basis actually used
  cpt?: string;
  live: boolean; // true only when a real, sourced lookup produced the figure
  /** ISO date of the live lookup; absent for static figures. */
  retrievedAt?: string;
  /** Venue the live figure applies to (FAIR Health geozip = first 3 ZIP digits). */
  geozip?: string;
  percentile?: number;
  /** Raw provider snapshot persisted alongside the item so the figure can be
   *  re-derived and defended later (provider, endpoint fields, amounts). */
  detail?: Record<string, unknown>;
}

export interface PricingQuery {
  category: CareCategory;
  cpt?: string | null;
  zip?: string | null;
  percentile?: 50 | 80; // FAIR Health percentile (default 80 per CLCP convention)
}

export type PricingProviderName = "static" | "fairhealth" | "goodrx" | "genworth";

const CREDS: Record<Exclude<PricingProviderName, "static">, string[]> = {
  fairhealth: ["FAIRHEALTH_API_URL", "FAIRHEALTH_API_KEY"],
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

/** First three ZIP digits — FAIR Health's geographic pricing unit. */
export function geozipOf(zip: string | null | undefined): string | null {
  const m = /^\s*(\d{3})\d{0,2}/.exec(zip ?? "");
  return m ? m[1] : null;
}

// ── FAIR Health adapter ──────────────────────────────────────────────────────
// Licensed FH® Benchmarks feeds expose per-code charge benchmarks by geozip and
// percentile. Tenant endpoints differ, so the base URL is configuration; the
// adapter requests
//   GET {FAIRHEALTH_API_URL}?code=<cpt>&geozip=<geo>&percentile=<p>
// with a bearer key, and accepts either { amount } or
// { benchmarks: [{ percentile, amount }] }. The response mapper is pure and
// tested; anything it cannot read is a loud error, never a guessed figure.

export interface FairHealthMapped {
  amount: number;
  percentile: number;
}

export function mapFairHealthResponse(json: unknown, wantPercentile: number): FairHealthMapped {
  if (json && typeof json === "object") {
    const o = json as { amount?: unknown; benchmarks?: unknown };
    if (typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount > 0) {
      return { amount: o.amount, percentile: wantPercentile };
    }
    if (Array.isArray(o.benchmarks)) {
      const rows = o.benchmarks.filter(
        (b): b is { percentile: number; amount: number } =>
          !!b && typeof b === "object" && typeof (b as { percentile?: unknown }).percentile === "number" && typeof (b as { amount?: unknown }).amount === "number" && (b as { amount: number }).amount > 0,
      );
      const exact = rows.find((b) => b.percentile === wantPercentile);
      if (exact) return { amount: exact.amount, percentile: exact.percentile };
      // Closest available percentile, disclosed via the returned percentile.
      const closest = rows.sort((x, y) => Math.abs(x.percentile - wantPercentile) - Math.abs(y.percentile - wantPercentile))[0];
      if (closest) return { amount: closest.amount, percentile: closest.percentile };
    }
  }
  throw new Error("FAIR Health response did not contain a usable benchmark amount (expected { amount } or { benchmarks: [{ percentile, amount }] }).");
}

async function fairHealthLookup(q: PricingQuery): Promise<PricedUnit> {
  const base = process.env.FAIRHEALTH_API_URL!;
  const key = process.env.FAIRHEALTH_API_KEY!;
  const ref = UNIT_COSTS[q.category];
  const cpt = q.cpt ?? ref.cpt;
  // A benchmark feed prices codes. Bundled/uncoded categories keep the labeled
  // static reference — an honest bundle, not a fake code lookup.
  if (!cpt) return staticPrice(q);
  const geozip = geozipOf(q.zip);
  const percentile = q.percentile ?? 80;
  const url = new URL(base);
  url.searchParams.set("code", cpt);
  if (geozip) url.searchParams.set("geozip", geozip);
  url.searchParams.set("percentile", String(percentile));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`FAIR Health lookup failed for CPT ${cpt} (HTTP ${res.status}). No figure was invented.`);
  const mapped = mapFairHealthResponse(await res.json(), percentile);
  const retrievedAt = new Date().toISOString();
  const srcLabel = source("fairhealth")?.label ?? "FAIR Health";
  return {
    unit: mapped.amount,
    source: `${srcLabel} — ${mapped.percentile}th percentile${geozip ? `, geozip ${geozip}` : ", national"}, retrieved ${retrievedAt.slice(0, 10)}`,
    cpt,
    live: true,
    retrievedAt,
    geozip: geozip ?? undefined,
    percentile: mapped.percentile,
    detail: { provider: "fairhealth", code: cpt, geozip, percentile: mapped.percentile, amount: mapped.amount, retrievedAt },
  };
}

/**
 * Resolve a sourced unit cost. Uses the live provider when configured; otherwise
 * returns the static reference. GoodRx / Genworth remain guarded stubs until
 * their licenses and adapters are in place.
 */
export async function resolveUnitCost(q: PricingQuery): Promise<PricedUnit> {
  const provider = (process.env.PRICING_PROVIDER ?? "static").toLowerCase() as PricingProviderName;
  if (provider === "static" || !(provider in CREDS)) return staticPrice(q);
  const missing = CREDS[provider as Exclude<PricingProviderName, "static">].filter((k) => !process.env[k]);
  if (missing.length) throw setupError(provider, `missing credentials: ${missing.join(", ")}`);
  if (provider === "fairhealth") return fairHealthLookup(q);
  const srcLabel = source(provider === "goodrx" ? "goodrx" : "genworth")?.label ?? provider;
  throw setupError(provider, `its adapter is not implemented — wire the ${srcLabel} lookup in resolveUnitCost()`);
}
