// ─────────────────────────────────────────────────────────────────────────────
// Projection-input provenance: WHERE each number in a projection came from.
//
// A future-care line multiplies three quantities — how often, for how long, at
// what price — and a citation next to that line reads as if the record
// supplied all of them. It almost never does. The records may establish that a
// patient needs physical therapy; "twice weekly for two years at $205" is
// planning convention. Presenting convention with a record citation attached
// misrepresents the source of the number, which is the single easiest thing
// for opposing counsel to take apart — and the single easiest way for a plan
// to be wrong without anyone noticing.
//
// So every input is labelled at generation time:
//   RECORD_STATED       the records state this quantity, and the citation
//                       supports it
//   PLANNING_ASSUMPTION a planning convention, carrying no record citation
//
// A citation may be attached ONLY to the inputs marked RECORD_STATED. The
// report then says which is which, in the plan's own voice.
// ─────────────────────────────────────────────────────────────────────────────

export type InputSource = "RECORD_STATED" | "PLANNING_ASSUMPTION";

export interface ProjectionInputs {
  /** Is the NEED for this service stated in the records? */
  service: InputSource;
  frequency: InputSource;
  duration: InputSource;
  unitCost: InputSource;
  /**
   * Supports the RECORD_STATED inputs above and nothing else. Null on a purely
   * conventional item — an assumption never carries a citation.
   */
  citation: { filename: string; page: number | null; date: string | null; provider: string | null } | null;
}

/** Everything conventional: a template line the records did not ask for. */
export const ALL_ASSUMED: ProjectionInputs = {
  service: "PLANNING_ASSUMPTION",
  frequency: "PLANNING_ASSUMPTION",
  duration: "PLANNING_ASSUMPTION",
  unitCost: "PLANNING_ASSUMPTION",
  citation: null,
};

// ── Quantities the records actually state ───────────────────────────────────

const PER_YEAR: [RegExp, number][] = [
  [/\b(?:three|3)\s*(?:times|x)\s*(?:a|per)?\s*week(?:ly)?\b/i, 156],
  [/\b(?:twice|two times|2\s*x)\s*(?:a|per)?\s*week(?:ly)?\b/i, 104],
  [/\b(?:once|1\s*x)?\s*(?:a|per)?\s*week(?:ly)?\b/i, 52],
  [/\b(?:twice|two times|2\s*x)\s*(?:a|per)?\s*month(?:ly)?\b/i, 24],
  [/\bmonthly\b|\b(?:once|1\s*x)\s*(?:a|per)\s*month\b/i, 12],
  [/\bquarterly\b/i, 4],
  [/\b(?:annually|yearly|once (?:a|per) year)\b/i, 1],
];

const norm = (s: string) => s.replace(/\s+/g, " ");

/**
 * Frequency and duration the recommendation itself states. Returns only what
 * the text actually says — an unstated quantity comes back undefined and is
 * supplied, and labelled, as a planning assumption.
 */
export function statedQuantities(text: string): { frequencyPerYear?: number; durationYears?: number } {
  const t = norm(text);
  const out: { frequencyPerYear?: number; durationYears?: number } = {};

  const everyN = t.match(/\bevery\s+(\d{1,2})\s*(week|month|year)s?\b/i);
  if (everyN) {
    const n = parseInt(everyN[1], 10);
    const unit = everyN[2].toLowerCase();
    if (n > 0) out.frequencyPerYear = unit === "week" ? 52 / n : unit === "month" ? 12 / n : 1 / n;
  } else {
    for (const [re, per] of PER_YEAR) {
      if (re.test(t)) {
        out.frequencyPerYear = per;
        break;
      }
    }
  }

  const forN = t.match(/\bfor\s+(\d{1,3})\s*(week|month|year)s?\b/i);
  if (forN) {
    const n = parseInt(forN[1], 10);
    const unit = forN[2].toLowerCase();
    if (n > 0) out.durationYears = unit === "week" ? n / 52 : unit === "month" ? n / 12 : n;
  }

  // "×12 visits" fixes the total, so duration follows from the frequency.
  const visits = t.match(/\b(?:x|×)\s*(\d{1,3})\s*(?:visits?|sessions?|treatments?)\b/i) ?? t.match(/\b(\d{1,3})\s*(?:visits?|sessions?|treatments?)\b/i);
  if (visits && out.durationYears === undefined && out.frequencyPerYear) {
    const n = parseInt(visits[1], 10);
    if (n > 0) out.durationYears = n / out.frequencyPerYear;
  }
  return out;
}

// ── Report language ─────────────────────────────────────────────────────────

const LABEL: Record<keyof Omit<ProjectionInputs, "citation">, string> = {
  service: "the need for this service",
  frequency: "frequency",
  duration: "duration",
  unitCost: "unit cost",
};

/**
 * One sentence stating, for this line, which inputs the records supply and
 * which are planning assumptions. Written so a citation is never left looking
 * as though it supports a number it does not.
 */
export function projectionNote(p: ProjectionInputs): string {
  const keys = ["service", "frequency", "duration", "unitCost"] as const;
  const stated = keys.filter((k) => p[k] === "RECORD_STATED");
  const assumed = keys.filter((k) => p[k] === "PLANNING_ASSUMPTION");

  if (!stated.length) {
    return "Projection inputs: the need for this service, its frequency, duration, and unit cost are planning assumptions applied by the life care planner, pending physician confirmation. No record citation supports these quantities.";
  }
  if (!assumed.length) {
    return "Projection inputs: the need for this service and all projected quantities are stated in the treating records and carry their citation.";
  }
  const list = (ks: readonly (keyof typeof LABEL)[]) => {
    const parts = ks.map((k) => LABEL[k]);
    return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  };
  return (
    `Projection inputs: ${list(stated)} ${stated.length === 1 ? "is" : "are"} stated in the treating records (see citation). ` +
    `${list(assumed).replace(/^./, (ch) => ch.toUpperCase())} ${assumed.length === 1 ? "is a planning assumption" : "are planning assumptions"} ` +
    `applied by the life care planner, pending physician confirmation — the citation does not support ${assumed.length === 1 ? "it" : "them"}.`
  );
}

/**
 * Enforce the rule structurally rather than trusting callers: an item with no
 * RECORD_STATED input cannot carry a citation.
 */
export function sealProvenance(p: ProjectionInputs): ProjectionInputs {
  const anyStated = p.service === "RECORD_STATED" || p.frequency === "RECORD_STATED" || p.duration === "RECORD_STATED" || p.unitCost === "RECORD_STATED";
  return anyStated ? p : { ...p, citation: null };
}
