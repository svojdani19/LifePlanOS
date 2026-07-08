import type { PlanTier } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Plan catalog. Limits live in code (not the DB) so they can evolve safely and
// be reasoned about in one place. Per-firm negotiated overrides are stored on
// Subscription.caseLimitOverride / seatLimitOverride (Enterprise deals).
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  blurb: string;
  /** USD per month, billed per firm. */
  monthlyPrice: number;
  /** Active seats included. */
  seatLimit: number;
  /** Active (non-archived) cases allowed at once. `null` = unlimited. */
  caseLimit: number | null;
  /** Included AI generations per month. `null` = unlimited. */
  aiGenerationLimit: number | null;
  /** Included record pages OCR'd per month. `null` = unlimited. */
  ocrPageLimit: number | null;
  features: string[];
  /** Placeholder Stripe price id, wired up when Stripe keys are present. */
  stripePriceId?: string;
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  SOLO: {
    tier: "SOLO",
    name: "Solo",
    blurb: "For the independent life care planner or nurse consultant.",
    monthlyPrice: 199,
    seatLimit: 2,
    caseLimit: 10,
    aiGenerationLimit: 200,
    ocrPageLimit: 5000,
    features: [
      "Case intake & chronology",
      "Future care recommendation engine",
      "Cost projection engine",
      "Defense vulnerability flags",
      "DOCX / PDF export",
    ],
    stripePriceId: process.env.STRIPE_PRICE_SOLO,
  },
  SMALL_FIRM: {
    tier: "SMALL_FIRM",
    name: "Small Firm",
    blurb: "For rehab & life care planning firms running many cases at once.",
    monthlyPrice: 749,
    seatLimit: 10,
    caseLimit: 75,
    aiGenerationLimit: 2000,
    ocrPageLimit: 50000,
    features: [
      "Everything in Solo",
      "Physician review workflow",
      "Firm-branded report templates",
      "Version comparison",
      "Recommendation library",
    ],
    stripePriceId: process.env.STRIPE_PRICE_SMALL_FIRM,
  },
  ENTERPRISE: {
    tier: "ENTERPRISE",
    name: "Enterprise",
    blurb: "For large firms & legal orgs with custom compliance needs.",
    monthlyPrice: 2499,
    seatLimit: 100,
    caseLimit: null,
    aiGenerationLimit: null,
    ocrPageLimit: null,
    features: [
      "Everything in Small Firm",
      "Unlimited cases",
      "SSO & advanced permissions",
      "Benchmarking across anonymized plans",
      "API access & integrations",
      "BAA & custom data retention",
    ],
    stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE,
  },
};

export const PLAN_ORDER: PlanTier[] = ["SOLO", "SMALL_FIRM", "ENTERPRISE"];

/** Effective limits for a firm, applying any negotiated overrides. */
export function effectiveLimits(
  tier: PlanTier,
  overrides?: { caseLimitOverride?: number | null; seatLimitOverride?: number | null; seats?: number | null },
): { caseLimit: number | null; seatLimit: number; aiGenerationLimit: number | null; ocrPageLimit: number | null } {
  const plan = PLANS[tier];
  return {
    caseLimit: overrides?.caseLimitOverride ?? plan.caseLimit,
    seatLimit: overrides?.seatLimitOverride ?? overrides?.seats ?? plan.seatLimit,
    aiGenerationLimit: plan.aiGenerationLimit,
    ocrPageLimit: plan.ocrPageLimit,
  };
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
