// ─────────────────────────────────────────────────────────────────────────────
// Gold-standard case scoring (pure — no prisma). A GoldFixture is the
// physician-reviewed truth for a case (captured by scripts/gold-capture.ts);
// scoreAgainstGold measures what the generator currently produces against it:
// item precision/recall/F1 with tolerant service-name matching, per-field
// numeric deltas on matched items, exclusion violations (services the physician
// rejected that must NOT reappear), and a totals tolerance check.
// ─────────────────────────────────────────────────────────────────────────────

export interface GoldItem {
  service: string;
  category: string;
  probability?: number;
  frequencyPerYear?: number;
  durationYears?: number;
  isLifetime?: boolean;
}

export interface GoldFixture {
  expectedItems: GoldItem[];
  expectedExclusions: string[]; // services that must NOT appear
  totals?: { presentValue?: number; tolerancePct?: number };
}

export interface GoldScore {
  itemPrecision: number;
  itemRecall: number;
  f1: number;
  matched: { service: string; deltas: { field: string; expected: number; actual: number }[] }[];
  missing: string[]; // expected but not generated
  unexpected: string[]; // generated but not expected
  excludedButPresent: string[]; // exclusion violations
  totalsWithinTolerance: boolean | null; // null when either side has no PV total
  parameterAccuracy: number; // share of matched numeric params within 25%
}

// Shared ordinal mapping for the Probability enum so capture and harness encode
// probability identically (relative deltas are what matter, not the values).
export const PROBABILITY_NUMERIC: Record<string, number> = {
  PROBABLE: 0.85,
  POSSIBLE: 0.5,
  SPECULATIVE: 0.25,
  NOT_SUPPORTED: 0,
};

// ── Tolerant service-name matching ───────────────────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function significantWords(s: string): Set<string> {
  // Light singularization ("visits" ≈ "visit") so pluralization differences
  // between a captured fixture and regenerated output don't break matching.
  return new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w.length > 3)
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/** Case/punctuation-insensitive; containment or ≥70% significant-word overlap. */
export function servicesMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return na === nb;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = significantWords(a);
  const wb = significantWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.7;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
const NUMERIC_FIELDS = ["probability", "frequencyPerYear", "durationYears"] as const;

function within25(expected: number, actual: number): boolean {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) <= 0.25 * Math.abs(expected);
}

/**
 * Score generated items against a gold fixture. `actualTotals` carries the
 * generated plan's PV total (GoldItem intentionally has no cost fields);
 * totalsWithinTolerance is null unless both the fixture and the caller
 * provide one.
 */
export function scoreAgainstGold(
  generated: GoldItem[],
  gold: GoldFixture,
  actualTotals?: { presentValue?: number },
): GoldScore {
  // Greedy 1:1 matching: each expected item claims the first unclaimed
  // generated item whose service name matches tolerantly.
  const claimed = new Set<number>();
  const matched: GoldScore["matched"] = [];
  const missing: string[] = [];
  let paramsCompared = 0;
  let paramsWithin = 0;

  for (const exp of gold.expectedItems) {
    const idx = generated.findIndex((g, i) => !claimed.has(i) && servicesMatch(g.service, exp.service));
    if (idx === -1) {
      missing.push(exp.service);
      continue;
    }
    claimed.add(idx);
    const act = generated[idx];
    const deltas: { field: string; expected: number; actual: number }[] = [];
    for (const f of NUMERIC_FIELDS) {
      const e = exp[f];
      const a = act[f];
      if (typeof e !== "number" || typeof a !== "number") continue;
      paramsCompared++;
      if (within25(e, a)) paramsWithin++;
      else deltas.push({ field: f, expected: e, actual: a });
    }
    if (exp.isLifetime !== undefined && act.isLifetime !== undefined) {
      paramsCompared++;
      if (exp.isLifetime === act.isLifetime) paramsWithin++;
      else deltas.push({ field: "isLifetime", expected: exp.isLifetime ? 1 : 0, actual: act.isLifetime ? 1 : 0 });
    }
    matched.push({ service: exp.service, deltas });
  }

  const unexpected = generated.filter((_, i) => !claimed.has(i)).map((g) => g.service);
  const excludedButPresent = gold.expectedExclusions.filter((ex) => generated.some((g) => servicesMatch(g.service, ex)));

  const itemPrecision = generated.length ? matched.length / generated.length : 1;
  const itemRecall = gold.expectedItems.length ? matched.length / gold.expectedItems.length : 1;
  const f1 = itemPrecision + itemRecall > 0 ? (2 * itemPrecision * itemRecall) / (itemPrecision + itemRecall) : 0;

  let totalsWithinTolerance: boolean | null = null;
  const goldPV = gold.totals?.presentValue;
  const actualPV = actualTotals?.presentValue;
  if (typeof goldPV === "number" && typeof actualPV === "number") {
    const tolPct = gold.totals?.tolerancePct ?? 10;
    totalsWithinTolerance = goldPV === 0 ? actualPV === 0 : Math.abs(actualPV - goldPV) <= (tolPct / 100) * Math.abs(goldPV);
  }

  return {
    itemPrecision,
    itemRecall,
    f1,
    matched,
    missing,
    unexpected,
    excludedButPresent,
    totalsWithinTolerance,
    parameterAccuracy: paramsCompared ? paramsWithin / paramsCompared : 1,
  };
}
