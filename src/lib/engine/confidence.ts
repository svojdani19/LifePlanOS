// ─────────────────────────────────────────────────────────────────────────────
// Causation confidence — banding and a plain-language definition of what the
// percentage means and how it was determined for a given condition. Pure and
// deterministic so the UI and the report state the identical basis.
//
// The percentage expresses how directly the reviewed records tie the diagnosis
// to the incident: objective findings in the records, temporal proximity to the
// mechanism, and treating-source attribution. It is an evidentiary weight for
// physician review — not a statistical probability.
// ─────────────────────────────────────────────────────────────────────────────

export type ConfidenceBand = "High" | "Moderate" | "Limited" | "Low";

export function confidenceBand(pct: number): ConfidenceBand {
  if (pct >= 75) return "High";
  if (pct >= 60) return "Moderate";
  if (pct >= 45) return "Limited";
  return "Low";
}

const BAND_MEANING: Record<ConfidenceBand, string> = {
  High: "objective findings in the records directly document the diagnosis and attribute it to the incident",
  Moderate: "the records support the diagnosis and its relationship to the incident, with at least one element (objective confirmation or explicit attribution) resting on clinical inference",
  Limited: "the diagnosis is clinically consistent with the injury but the reviewed records document it incompletely",
  Low: "the present record does not establish the diagnosis or its relationship to the incident without further documentation",
};

export interface ConfidenceInput {
  confidence: number;
  physicianConfirmed?: boolean;
  missingInfo?: string | null;
  /** number of source records in which supporting evidence was located */
  evidenceCount?: number;
}

/** One plain-language sentence set defining the determined confidence level. */
export function confidenceDefinition(c: ConfidenceInput): string {
  const band = confidenceBand(c.confidence);
  const parts: string[] = [
    `${band} confidence (${c.confidence}%) — ${BAND_MEANING[band]}.`,
    "The level reflects how directly the reviewed records tie the diagnosis to the incident: objective findings, temporal proximity to the mechanism, and treating-source attribution.",
  ];
  if (c.evidenceCount) parts.push(`Supporting content was located in ${c.evidenceCount} record${c.evidenceCount === 1 ? "" : "s"} (cited below).`);
  parts.push(c.physicianConfirmed ? "Confirmed by the reviewing physician." : "Pending confirmation by the reviewing physician.");
  if (c.missingInfo) parts.push(`Outstanding: ${c.missingInfo}`);
  return parts.join(" ");
}
