// ─────────────────────────────────────────────────────────────────────────────
// Geographic cost factors. The Case carries a single editable geographicFactor
// (default 1.0) that the cost engine applies to national reference figures.
// This module derives a DEFENSIBLE starting value from the case's venue instead
// of leaving 1.0 silently in place for a Bay Area or Manhattan case: a
// state-level relative cost index (illustrative reference points around the
// 1.00 national baseline, in the same spirit as UNIT_COSTS — every value
// remains editable on the case and every change is ledgered). When live
// venue-specific pricing (FAIR Health by geozip) is active, per-item figures
// are already venue-priced and the factor is NOT applied on top of them.
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoFactor {
  factor: number;
  /** Where the number comes from — rendered in the assumption ledger. */
  label: string;
}

// Relative medical-cost index by state (national = 1.00). Illustrative
// reference points; the case-level factor stays editable and ledgered.
const STATE_FACTORS: Record<string, number> = {
  AL: 0.9, AK: 1.25, AZ: 0.98, AR: 0.88, CA: 1.18, CO: 1.02, CT: 1.1, DE: 1.02,
  DC: 1.12, FL: 1.0, GA: 0.95, HI: 1.12, ID: 0.95, IL: 1.02, IN: 0.94, IA: 0.92,
  KS: 0.92, KY: 0.92, LA: 0.94, ME: 1.0, MD: 1.05, MA: 1.12, MI: 0.96, MN: 1.0,
  MS: 0.86, MO: 0.93, MT: 0.98, NE: 0.93, NV: 1.02, NH: 1.05, NJ: 1.1, NM: 0.94,
  NY: 1.15, NC: 0.95, ND: 0.95, OH: 0.95, OK: 0.9, OR: 1.04, PA: 1.0, RI: 1.05,
  SC: 0.94, SD: 0.92, TN: 0.92, TX: 0.98, UT: 0.97, VT: 1.02, VA: 1.0, WA: 1.08,
  WV: 0.9, WI: 0.98, WY: 0.98,
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

/** Extract a US state from free-text venue/jurisdiction ("Los Angeles County,
 *  California", "NY Supreme Court", "TX"). Null when none is recognizable. */
export function stateFromJurisdiction(jurisdiction: string | null | undefined): string | null {
  const text = (jurisdiction ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  // Full state names first (longest match wins so "west virginia" beats "virginia").
  const names = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length);
  for (const name of names) if (lower.includes(name)) return STATE_NAMES[name];
  // Two-letter abbreviations as standalone tokens ("NY", "Austin, TX").
  for (const m of text.toUpperCase().matchAll(/\b([A-Z]{2})\b/g)) {
    if (m[1] in STATE_FACTORS) return m[1];
  }
  return null;
}

/** Suggested geographic factor for a venue. Returns the neutral 1.00 with an
 *  honest label when the venue is unknown — never a guessed adjustment. */
export function geographicFactorFor(jurisdiction: string | null | undefined): GeoFactor {
  const state = stateFromJurisdiction(jurisdiction);
  if (!state) return { factor: 1.0, label: "National baseline (venue not recognized from jurisdiction)" };
  return { factor: STATE_FACTORS[state], label: `State-level relative medical-cost index — ${state} (national = 1.00)` };
}
