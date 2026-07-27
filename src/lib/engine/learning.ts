// ─────────────────────────────────────────────────────────────────────────────
// Cross-case learning engine. The program learns from every reviewed case —
// deterministically, auditable, and WITHOUT ever taking the physician out of
// the loop:
//
//   signal    — each recommendation lineage that a physician acted on is one
//               observation: what the engine proposed (the lineage's first
//               version) vs. what the physician made final (approve as-is,
//               modify frequency/duration, or reject — with the documented
//               reason)
//   profile   — the firm's observations aggregated per normalized service:
//               approval/modification/rejection rates, proposed→final
//               frequency and duration medians, direction consistency, and
//               recent documented reasons
//   suggest   — at plan generation, a candidate matching a service with
//               enough consistent history gets an ADVISORY insight ("in 4 of
//               5 prior cases the physician halved this frequency") persisted
//               alongside it — the proposed value itself is NEVER changed
//   calibrate — how the engine's probability classes fare under physician
//               review, so reviewers can see where it runs hot
//
// Guardrails, by design:
//   • firm-scoped only — one firm's review patterns never influence another's
//     cases (tenant isolation applies to knowledge, not just data)
//   • advisory only — a learned insight annotates; it never silently edits a
//     clinical value (the physician remains the arbiter, per §8)
//   • sample-gated — no suggestion below MIN_SAMPLES observations or below
//     CONSISTENCY agreement, so one loud case cannot steer the engine
//   • provenance on every insight — each states its sample size and basis, so
//     a suggestion is as examinable as any other conclusion in the system
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_SAMPLES = 3;
export const CONSISTENCY = 0.7;
/** relative change below this is treated as agreement, not a correction */
const MATERIAL_DELTA = 0.2;

export interface LearningItemInput {
  lineageId: string;
  version: number;
  service: string;
  category: string;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  physicianStatus: string;
  physicianNote?: string | null;
  supersededAt?: Date | string | null;
}

export interface ServiceObservation {
  lineageId: string;
  outcome: "APPROVED" | "MODIFIED" | "REJECTED";
  proposedFrequency: number;
  finalFrequency: number;
  proposedLifetime: boolean;
  finalLifetime: boolean;
  proposedDuration: number | null;
  finalDuration: number | null;
  note: string | null;
}

export interface ServiceHistory {
  serviceKey: string;
  service: string; // display name (most recent spelling)
  category: string;
  samples: number;
  approved: number;
  modified: number;
  rejected: number;
  /** medians over physician-final values of non-rejected observations */
  medianFinalFrequency: number | null;
  medianProposedFrequency: number | null;
  /** fraction of modified observations that moved frequency the same direction */
  frequencyDirection: "down" | "up" | null;
  frequencyConsistency: number;
  recentReasons: string[];
}

export interface LearningProfile {
  services: ServiceHistory[];
  calibration: { probability: string; samples: number; approvedOrModified: number }[];
  lineagesIncluded: number;
}

/** Normalization key: same service proposed with case-to-case spelling drift
 *  still aggregates ("Pain management office visits" ≈ "pain management office
 *  visit"). Category disambiguates identically named services. */
export function serviceKeyOf(service: string, category: string): string {
  return `${category}::${service.trim().toLowerCase().replace(/\s+/g, " ").replace(/s\b/g, "")}`;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const ACTED = new Set(["APPROVED", "MODIFIED", "REJECTED"]);

/** Group a firm's recommendation versions (INCLUDING superseded ones) into
 *  per-lineage observations: first version = what the engine proposed, latest
 *  version = what the physician made final. Lineages never acted on carry no
 *  signal and are skipped. */
export function extractObservations(items: LearningItemInput[]): Map<string, { service: string; category: string; obs: ServiceObservation[] }> {
  const byLineage = new Map<string, LearningItemInput[]>();
  for (const it of items) {
    const list = byLineage.get(it.lineageId) ?? [];
    list.push(it);
    byLineage.set(it.lineageId, list);
  }
  const byService = new Map<string, { service: string; category: string; obs: ServiceObservation[] }>();
  for (const versions of byLineage.values()) {
    versions.sort((a, b) => a.version - b.version);
    const first = versions[0];
    const current = versions[versions.length - 1];
    if (!ACTED.has(current.physicianStatus)) continue;
    const key = serviceKeyOf(current.service, current.category);
    const entry = byService.get(key) ?? { service: current.service, category: current.category, obs: [] };
    entry.service = current.service;
    entry.obs.push({
      lineageId: current.lineageId,
      outcome: current.physicianStatus as ServiceObservation["outcome"],
      proposedFrequency: first.frequencyPerYear,
      finalFrequency: current.frequencyPerYear,
      proposedLifetime: first.isLifetime,
      finalLifetime: current.isLifetime,
      proposedDuration: first.durationYears,
      finalDuration: current.durationYears,
      note: current.physicianNote?.trim() || null,
    });
    byService.set(key, entry);
  }
  return byService;
}

/** Aggregate a firm's observations into its learning profile. Pure. */
export function buildLearningProfile(items: LearningItemInput[], probabilityByLineage?: Map<string, string>): LearningProfile {
  const byService = extractObservations(items);
  const services: ServiceHistory[] = [];
  for (const [key, { service, category, obs }] of byService) {
    const approved = obs.filter((o) => o.outcome === "APPROVED").length;
    const modified = obs.filter((o) => o.outcome === "MODIFIED").length;
    const rejected = obs.filter((o) => o.outcome === "REJECTED").length;
    const kept = obs.filter((o) => o.outcome !== "REJECTED");
    const freqMoves = kept.filter((o) => Math.abs(o.finalFrequency - o.proposedFrequency) / Math.max(o.proposedFrequency, 1e-9) > MATERIAL_DELTA);
    const down = freqMoves.filter((o) => o.finalFrequency < o.proposedFrequency).length;
    const up = freqMoves.length - down;
    const direction = freqMoves.length === 0 ? null : down >= up ? "down" : "up";
    services.push({
      serviceKey: key,
      service,
      category,
      samples: obs.length,
      approved,
      modified,
      rejected,
      medianFinalFrequency: median(kept.map((o) => o.finalFrequency)),
      medianProposedFrequency: median(kept.map((o) => o.proposedFrequency)),
      frequencyDirection: direction,
      frequencyConsistency: freqMoves.length ? Math.max(down, up) / freqMoves.length : 0,
      recentReasons: obs.map((o) => o.note).filter((n): n is string => !!n).slice(-3),
    });
  }
  services.sort((a, b) => b.samples - a.samples);

  // Calibration: how each probability class fares under review.
  const calBuckets = new Map<string, { samples: number; ok: number }>();
  if (probabilityByLineage) {
    for (const { obs } of byService.values()) {
      for (const o of obs) {
        const prob = probabilityByLineage.get(o.lineageId);
        if (!prob) continue;
        const b = calBuckets.get(prob) ?? { samples: 0, ok: 0 };
        b.samples++;
        if (o.outcome !== "REJECTED") b.ok++;
        calBuckets.set(prob, b);
      }
    }
  }
  const calibration = [...calBuckets.entries()]
    .map(([probability, b]) => ({ probability, samples: b.samples, approvedOrModified: b.ok }))
    .sort((a, b) => b.samples - a.samples);

  return { services, calibration, lineagesIncluded: [...byService.values()].reduce((s, e) => s + e.obs.length, 0) };
}

// ── Generation-time advisory insights ────────────────────────────────────────

export type InsightKind = "FREQUENCY_HISTORY" | "HIGH_REJECTION" | "DURATION_HISTORY";

export interface LearnedInsight {
  kind: InsightKind;
  message: string; // human-readable, with provenance baked in
  sampleSize: number;
  /** advisory figure drawn from the firm's physician-final medians; never applied automatically */
  suggestedFrequencyPerYear?: number;
}

export interface CandidateItem {
  service: string;
  category: string;
  frequencyPerYear: number;
  durationYears?: number | null;
  isLifetime?: boolean;
}

/**
 * The advisory insight (if any) for a candidate recommendation, from the
 * firm's history with that service. Gated on sample size and consistency;
 * silent when the firm's physicians have historically agreed with the engine.
 */
export function insightFor(candidate: CandidateItem, profile: LearningProfile): LearnedInsight | null {
  const hist = profile.services.find((s) => s.serviceKey === serviceKeyOf(candidate.service, candidate.category));
  if (!hist || hist.samples < MIN_SAMPLES) return null;

  // Rejection pattern outranks parameter drift — "should this be proposed at
  // all" comes before "at what cadence".
  if (hist.rejected / hist.samples >= 0.5) {
    return {
      kind: "HIGH_REJECTION",
      message: `Firm history: physicians rejected this service in ${hist.rejected} of ${hist.samples} prior case${hist.samples === 1 ? "" : "s"}${hist.recentReasons.length ? ` (recent reason: “${hist.recentReasons[hist.recentReasons.length - 1]}”)` : ""}. Verify the necessity basis before physician review.`,
      sampleSize: hist.samples,
    };
  }

  if (
    hist.frequencyDirection &&
    hist.frequencyConsistency >= CONSISTENCY &&
    hist.medianFinalFrequency != null &&
    Math.abs(hist.medianFinalFrequency - candidate.frequencyPerYear) / Math.max(candidate.frequencyPerYear, 1e-9) > MATERIAL_DELTA
  ) {
    const corrected = hist.modified + hist.approved;
    return {
      kind: "FREQUENCY_HISTORY",
      message: `Firm history: across ${corrected} reviewed case${corrected === 1 ? "" : "s"}, physicians settled this service at a median ${hist.medianFinalFrequency}×/yr (proposed here at ${candidate.frequencyPerYear}×/yr). The proposal is unchanged — flagging for review.`,
      sampleSize: hist.samples,
      suggestedFrequencyPerYear: hist.medianFinalFrequency,
    };
  }

  return null;
}
