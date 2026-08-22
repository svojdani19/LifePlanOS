/**
 * Durable retrieval status for the best-effort enrichment producers.
 *
 * Generation calls out to external literature sources for guideline analysis
 * and article citations. Those calls were wrapped in `.catch(() => {})`, and
 * each producer returned 0 both when it searched and found nothing and when it
 * never searched at all. Three different facts arrived at the same silence:
 *
 *   - we never looked (offline, probe failed)
 *   - we looked and the literature has nothing for this pairing
 *   - we looked and the attempt broke
 *
 * Only the middle one is a statement about the case. The report renders the
 * other two as though they were: "no guideline located" reads as a finding
 * about the medicine when it may be a finding about the network. This module
 * keeps the three apart, records which one happened, and lets the plan say so.
 *
 * The pure functions here decide status and findings; persistence is a thin
 * shell around them so the rules are testable without a database.
 */

/** Bumped when a producer's retrieval logic changes what a result means. */
export const RETRIEVAL_VERSION = "retrieval-1";

/** What happened on one producer's pass over one case. */
export type RetrievalStatus =
  /** The producer never ran, or ran and returned before querying anything. */
  | "NOT_ATTEMPTED"
  /** Queried, and at least one result survived the producer's own gates. */
  | "SUCCEEDED"
  /**
   * Some sources answered and produced usable rows; others failed.
   *
   * SUCCEEDED covered this, and retrievalFinding says nothing about a
   * SUCCEEDED run — so a case where half the literature was unreachable
   * reported clean, and the only trace was a detail string on a row nothing
   * displayed. The results are real and are kept; the gap is now visible.
   */
  | "PARTIAL"
  /** Queried successfully; nothing came back, or nothing cleared the gates. */
  | "NO_RESULTS"
  /** Queried, and the attempt itself broke. Says nothing about the medicine. */
  | "FAILED";

/**
 * Why a FAILED / NOT_ATTEMPTED attempt did not produce an answer. These are
 * distinguished because they call for different actions: a rate limit is worth
 * retrying in a minute, a malformed response is worth a bug report, and being
 * offline is worth knowing before anyone reads "no guideline located".
 */
export type RetrievalFailure =
  | "UNREACHABLE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH"
  | "MALFORMED"
  | "CANCELLED"
  | "UNKNOWN";

export interface RetrievalOutcome {
  status: RetrievalStatus;
  /** Null exactly when the status is SUCCEEDED or NO_RESULTS. */
  failure: RetrievalFailure | null;
  /** One line a human can act on. Never contains PHI. */
  detail: string;
  /** Rows the producer wrote (guidelines, citations, edges). */
  produced: number;
  /** Units it considered (conditions, items). Distinguishes "nothing to do". */
  considered: number;
  /** External sources actually queried, for the audit trail. */
  sources: readonly string[];
  /**
   * Sources that did not answer, with why. Structured rather than buried in
   * prose so the report and the review surface can name them exactly.
   */
  failedSources: readonly { source: string; failure: RetrievalFailure }[];
}

export const notAttempted = (
  failure: RetrievalFailure,
  detail: string,
  considered = 0,
): RetrievalOutcome => ({ status: "NOT_ATTEMPTED", failure, detail, produced: 0, considered, sources: [], failedSources: [] });

export const nothingToDo = (detail: string): RetrievalOutcome => ({
  status: "NOT_ATTEMPTED",
  failure: null,
  detail,
  produced: 0,
  considered: 0,
  sources: [],
  failedSources: [],
});

export const retrieved = (
  produced: number,
  considered: number,
  sources: readonly string[],
  detail: string,
): RetrievalOutcome => ({
  status: produced > 0 ? "SUCCEEDED" : "NO_RESULTS",
  failure: null,
  detail,
  produced,
  considered,
  sources,
  failedSources: [],
});

/**
 * Map a thrown value onto a failure category.
 *
 * Deliberately conservative: anything not recognised is UNKNOWN rather than
 * being forced into the nearest-looking bucket. A wrong category sends someone
 * to debug the wrong system, which is worse than no category.
 */
export function classifyRetrievalFailure(err: unknown): RetrievalFailure {
  const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : NaN;
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "TIMEOUT";

  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError") return "CANCELLED";
  if (name === "TimeoutError") return "TIMEOUT";
  if (name === "SyntaxError") return "MALFORMED";

  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (/\b(429|rate.?limit|too many requests)\b/.test(msg)) return "RATE_LIMITED";
  if (/\b(401|403|unauthor|forbidden|api key|apikey)\b/.test(msg)) return "AUTH";
  if (/\b(timed? ?out|timeout|etimedout|deadline)\b/.test(msg)) return "TIMEOUT";
  if (/\b(enotfound|econnrefused|econnreset|eai_again|dns|network|fetch failed|socket hang up|unreachable|offline)\b/.test(msg)) return "UNREACHABLE";
  if (/\b(unexpected token|invalid json|malformed|parse)\b/.test(msg)) return "MALFORMED";
  if (/\b(abort|cancell?ed)\b/.test(msg)) return "CANCELLED";
  return "UNKNOWN";
}

/** Short, non-identifying summary of a thrown value for the audit trail. */
export function retrievalDetail(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "unknown error");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Run a best-effort producer without letting it throw, and say what happened.
 *
 * The producer may return an outcome itself (it knows whether it queried); a
 * bare number is read as "queried, produced N" for callers not yet converted.
 */
export async function runRetrieval(
  producer: string,
  producerVersion: string,
  fn: () => Promise<RetrievalOutcome | number>,
): Promise<RetrievalOutcome & { producer: string; producerVersion: string }> {
  const stamp = (o: RetrievalOutcome) => ({ ...o, producer, producerVersion });
  try {
    const r = await fn();
    if (typeof r === "number") return stamp(retrieved(r, r, [], `${producer} produced ${r} row(s).`));
    return stamp(r);
  } catch (err) {
    const failure = classifyRetrievalFailure(err);
    return stamp({
      status: "FAILED",
      failure,
      detail: retrievalDetail(err),
      produced: 0,
      considered: 0,
      sources: [],
      failedSources: [],
    });
  }
}

// ── Deciding an outcome from the actual query attempts ──────────────────────

/**
 * One source's fate on one case-specific query. Structurally identical to the
 * literature layer's SourceAttempt; declared here so this module stays free of
 * any dependency on the literature layer (which imports FROM here).
 */
export interface QueryAttempt {
  source: string;
  query: string;
  status: "FULFILLED" | "REJECTED" | "SKIPPED";
  failure: RetrievalFailure | null;
  detail: string | null;
  results: number;
}

/** The most actionable failure among several — an auth answer beats an outage. */
const FAILURE_RANK: RetrievalFailure[] = ["AUTH", "RATE_LIMITED", "TIMEOUT", "MALFORMED", "CANCELLED", "UNREACHABLE", "UNKNOWN"];
export const dominantFailure = (cats: readonly RetrievalFailure[]): RetrievalFailure =>
  FAILURE_RANK.find((c) => cats.includes(c)) ?? "UNKNOWN";

/**
 * Decide a producer's outcome from the CASE-SPECIFIC queries it actually ran.
 *
 * The generic reachability probe searches the word "medicine". It answers "is
 * the internet up", never "did we look for THIS patient's care". A producer
 * that passed the probe and then had every real query rejected still reported
 * NO_RESULTS, which reads as "the literature has nothing for this item" — a
 * claim nobody established.
 *
 * The rules, in the order they are checked:
 *
 *   nothing attempted            → NOT_ATTEMPTED. No claim of any kind.
 *   every attempt failed         → FAILED. The emptiness is ours, not the
 *                                  literature's.
 *   something was produced       → SUCCEEDED, disclosing any failed source.
 *                                  Partial retrieval is still retrieval, and
 *                                  the results deserve to be evaluated.
 *   produced nothing, all
 *     relevant queries answered  → NO_RESULTS. The one case where absence is a
 *                                  finding about the medicine.
 *   produced nothing, some
 *     queries never answered     → FAILED. Sources that never replied cannot
 *                                  support a claim that nothing exists.
 *
 * SKIPPED attempts (a source that is not configured) never count as evidence of
 * absence and never count as failure — they were not asked.
 */
export function outcomeFromAttempts(
  attempts: readonly QueryAttempt[],
  produced: number,
  considered: number,
  summary: string,
): RetrievalOutcome {
  const asked = attempts.filter((a) => a.status !== "SKIPPED");
  if (!asked.length) {
    const skipped = attempts.length ? " Every configured source was skipped." : "";
    return notAttempted("UNREACHABLE", `No case-specific query was completed.${skipped}`, considered);
  }

  const fulfilled = asked.filter((a) => a.status === "FULFILLED");
  const rejected = asked.filter((a) => a.status === "REJECTED");
  const sources = [...new Set(fulfilled.map((a) => a.source))];
  const failedNote = rejected.length
    ? ` ${rejected.length} of ${asked.length} source-queries failed (${[...new Set(rejected.map((r) => `${r.source}:${r.failure ?? "UNKNOWN"}`))].join(", ")}).`
    : "";

  // Deduplicated by source: one flaky source across eight queries is one gap,
  // not eight. Inflating the count would turn a single outage into an apparent
  // pile of obligations.
  const failedSources = [...new Map(rejected.map((r) => [r.source, { source: r.source, failure: r.failure ?? ("UNKNOWN" as RetrievalFailure) }])).values()];

  if (!fulfilled.length) {
    return {
      status: "FAILED",
      failure: dominantFailure(rejected.map((r) => r.failure ?? "UNKNOWN")),
      detail: `Every case-specific query failed.${failedNote}`.slice(0, 300),
      produced: 0,
      considered,
      sources: [],
      failedSources,
    };
  }

  if (produced > 0) {
    // Results were retrieved AND something was unreachable. This reported
    // SUCCEEDED, and a SUCCEEDED run produces no finding at all — so a case
    // where half the literature could not be searched read as clean, with the
    // only trace a detail string nothing displayed. The rows are kept, because
    // they are real; the gap is now a state of its own.
    if (failedSources.length) {
      return {
        status: "PARTIAL",
        failure: dominantFailure(failedSources.map((f) => f.failure)),
        detail: `${summary}${failedNote}`.slice(0, 300),
        produced,
        considered,
        sources,
        failedSources,
      };
    }
    return { status: "SUCCEEDED", failure: null, detail: summary.slice(0, 300), produced, considered, sources, failedSources: [] };
  }

  if (rejected.length) {
    return {
      status: "FAILED",
      failure: dominantFailure(rejected.map((r) => r.failure ?? "UNKNOWN")),
      detail: `Nothing was retrieved, and not every source answered, so absence cannot be asserted.${failedNote}`.slice(0, 300),
      produced: 0,
      considered,
      sources,
      failedSources,
    };
  }

  return { status: "NO_RESULTS", failure: null, detail: `${summary} Every case-specific query completed.`.slice(0, 300), produced: 0, considered, sources, failedSources: [] };
}

// ── What the plan is allowed to claim, given what actually happened ─────────

/**
 * What each producer is, and what a reader may WRONGLY conclude if it silently
 * produced nothing. The consequence is the part that matters: a finding that
 * says only "citations failed" leaves the reader to guess whether the plan is
 * still safe to read, and the answer differs by producer.
 */
export const PRODUCERS: Record<string, { label: string; consequence: string; emptyIsAnswer: boolean; emptyMeans: string }> = {
  "standard-of-care": {
    label: "Guideline (standard-of-care) analysis",
    consequence: "Any statement in this plan that no clinical guideline was located for a condition is unfounded — nothing was successfully searched.",
    emptyIsAnswer: true,
    emptyMeans: "No condition on this case has located guidance. The search ran, so this is a statement about the available literature.",
  },
  "article-citations": {
    label: "Supporting-article citations",
    consequence: "Items will read as having no supporting literature when in fact none was searched for.",
    emptyIsAnswer: true,
    emptyMeans: "No item received a supporting article. The search ran and nothing cleared the relevance and compatibility gates.",
  },
  "evidence-graph": {
    label: "Evidence graph",
    consequence: "The evidence graph is missing or stale, so views built from it may show fewer links between sources and claims than the case actually supports.",
    emptyIsAnswer: true,
    emptyMeans: "The graph was rebuilt and holds no edges, which is the correct result for a case with nothing yet to link.",
  },
  "disclosure:unsupported-template": {
    label: "Suppressed-template disclosure",
    consequence: "The engine suppressed template care for lack of record support and then failed to say so. The plan is short by those items with no visible reason.",
    emptyIsAnswer: false,
    emptyMeans: "Nothing was suppressed, so there was nothing to disclose.",
  },
  "disclosure:temporally-excluded": {
    label: "Temporal-exclusion disclosure",
    consequence: "The engine excluded documented care as already delivered, refused, or undated and then failed to say so. A reviewer sees no line and no explanation.",
    emptyIsAnswer: false,
    emptyMeans: "Nothing was temporally excluded, so there was nothing to disclose.",
  },
};

const describe = (producer: string) =>
  PRODUCERS[producer] ?? {
    label: producer,
    consequence: "The plan may present an absence that was never established.",
    emptyIsAnswer: false,
    emptyMeans: "The step ran and produced nothing.",
  };

/** Human label for each producer, used in findings the reader sees. */
export const PRODUCER_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(PRODUCERS).map(([k, v]) => [k, v.label]),
);

export interface RetrievalFindingRow {
  service: string;
  result: string;
  issue: string;
  severity: string;
  suggestion: string;
  exportBlocking: boolean;
}

/** Findings carry this prefix so a re-run can supersede exactly its own rows. */
export const RETRIEVAL_FINDING_PREFIX = "RETRIEVAL_";

/**
 * Turn an attempt into a finding, or null when the attempt needs no disclosure.
 *
 * Proportionality is the whole design here:
 *
 *   SUCCEEDED     — nothing to say.
 *   NO_RESULTS    — a real answer about the literature. Disclosed so the reader
 *                   knows the search ran, never blocking: "we looked and found
 *                   nothing" is a legitimate state for a plan to be in.
 *   FAILED /      — the plan's absence statements are unfounded. Blocking on a
 *   NOT_ATTEMPTED   FINAL export, because a final plan that says "no guideline
 *                   located" when nothing was queried asserts something nobody
 *                   established. Drafts are unaffected, and the finding can be
 *                   resolved as-is by an author who accepts issuing without it
 *                   — the gate asks for a human decision, not a working network.
 *
 * A producer with nothing to consider (no conditions, no items) is silent: it
 * did not fail, there was simply no work.
 */
export function retrievalFinding(
  a: Pick<RetrievalOutcome, "status" | "failure" | "detail" | "produced" | "considered"> & {
    producer: string;
    failedSources?: readonly { source: string; failure: RetrievalFailure }[];
  },
): RetrievalFindingRow | null {
  const { label, consequence, emptyIsAnswer, emptyMeans } = describe(a.producer);
  if (a.status === "SUCCEEDED") return null;

  if (a.status === "PARTIAL") {
    const named = (a.failedSources ?? []).map((f) => `${f.source} (${f.failure.toLowerCase().replace(/_/g, " ")})`).join(", ");
    return {
      service: "Case-wide",
      result: `${RETRIEVAL_FINDING_PREFIX}PARTIAL:${a.producer}`,
      issue:
        `${label} completed against some sources and not others: ${named || "one or more sources did not answer"}. ` +
        `What was retrieved is usable and is shown. What those sources would have returned is unknown, so this plan's coverage is narrower than a clean run's — it is not evidence that nothing further exists.`,
      // Disclosed, not blocking. Real results were obtained, and a partial
      // outage is a fact about the search rather than a defect in the plan.
      severity: "Moderate",
      suggestion:
        "No per-recommendation action is required. Re-run generation once the source is reachable if broader coverage matters for this plan.",
      exportBlocking: false,
    };
  }
  if (a.status === "NOT_ATTEMPTED" && a.failure === null) return null; // no work to do

  if (a.status === "NO_RESULTS") {
    // For a producer whose emptiness is a real answer about the world, this is
    // disclosed and not blocking. For one that should always produce something,
    // an empty run is treated as a failure below.
    if (!emptyIsAnswer) return failureFinding(a, label, consequence, "produced nothing when it should have");
    return {
      service: "Case-wide",
      result: `${RETRIEVAL_FINDING_PREFIX}NO_RESULTS:${a.producer}`,
      issue: `${label} ran and returned nothing for this case. ${emptyMeans}`,
      severity: "Low",
      suggestion: "No action required. If the plan relies on published support for these items, add a source manually or record a physician attestation.",
      exportBlocking: false,
    };
  }

  const verb = a.status === "FAILED" ? "failed" : "was never attempted";
  return failureFinding(a, label, consequence, verb);
}

function failureFinding(
  a: Pick<RetrievalOutcome, "status" | "failure" | "detail"> & { producer: string },
  label: string,
  consequence: string,
  verb: string,
): RetrievalFindingRow {
  const why: Record<RetrievalFailure, string> = {
    UNREACHABLE: "the external sources could not be reached",
    TIMEOUT: "the request timed out",
    RATE_LIMITED: "the source rate-limited the request",
    AUTH: "the source rejected the credentials",
    MALFORMED: "the source returned a response that could not be read",
    CANCELLED: "the attempt was cancelled before it completed",
    UNKNOWN: "the attempt failed for an unrecognised reason",
  };
  const cause = a.failure ? ` because ${why[a.failure]}` : "";
  return {
    service: "Case-wide",
    result: `${RETRIEVAL_FINDING_PREFIX}${a.status}:${a.producer}:${a.failure ?? "UNKNOWN"}`,
    issue: `${label} ${verb}${cause}. ${consequence} (${a.detail})`,
    severity: "High",
    suggestion:
      "Re-run generation once the underlying step can complete. To issue without it, resolve this finding, which records that the plan is being released with the gap acknowledged.",
    exportBlocking: true,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** The minimum of the Prisma client this module needs, so tests can fake it. */
export interface RetrievalStore {
  retrievalAttempt: {
    upsert(args: unknown): Promise<unknown>;
  };
  validationFinding: {
    deleteMany(args: unknown): Promise<{ count: number }>;
    createMany(args: unknown): Promise<{ count: number }>;
    findMany(args: unknown): Promise<{ service: string; result: string; status: string }[]>;
  };
}

export interface RecordedAttempt extends RetrievalOutcome {
  producer: string;
  producerVersion: string;
  durationMs?: number;
}

/**
 * Persist a set of attempts and republish the findings they imply.
 *
 * Findings are replaced wholesale for the producers in this batch, so a run
 * that succeeds after a failure clears the old finding instead of leaving a
 * stale "retrieval failed" standing over a plan that now has its guidelines.
 * A disposition the author already recorded is carried forward by (service,
 * result) so resolving a finding is not undone by the next generation.
 */
export async function recordRetrievalAttempts(
  db: RetrievalStore,
  caseId: string,
  firmId: string,
  attempts: readonly RecordedAttempt[],
): Promise<void> {
  if (!attempts.length) return;

  for (const a of attempts) {
    await db.retrievalAttempt.upsert({
      where: { caseId_producer: { caseId, producer: a.producer } },
      create: {
        caseId,
        firmId,
        producer: a.producer,
        producerVersion: a.producerVersion,
        status: a.status,
        failure: a.failure,
        detail: a.detail,
        produced: a.produced,
        considered: a.considered,
        sources: [...a.sources],
        failedSources: (a.failedSources ?? []).map((f) => `${f.source}:${f.failure}`),
        durationMs: a.durationMs ?? null,
      },
      update: {
        producerVersion: a.producerVersion,
        status: a.status,
        failure: a.failure,
        detail: a.detail,
        produced: a.produced,
        considered: a.considered,
        sources: [...a.sources],
        failedSources: (a.failedSources ?? []).map((f) => `${f.source}:${f.failure}`),
        durationMs: a.durationMs ?? null,
        attemptedAt: new Date(),
      },
    });
  }

  const rows = attempts.map((a) => retrievalFinding(a)).filter((r): r is RetrievalFindingRow => r !== null);

  // Preserve author dispositions across the republish. Matching on
  // (service, result) means a finding whose CAUSE changed — a different
  // failure category, say — reopens, which is correct: that is a new fact.
  const prior = await db.validationFinding.findMany({
    where: { caseId, result: { startsWith: RETRIEVAL_FINDING_PREFIX } },
    select: { service: true, result: true, status: true },
  });
  const disposition = new Map(prior.map((p) => [`${p.service}|${p.result}`, p.status]));

  // Replaced wholesale, like every other deterministic finding set: a producer
  // that had nothing to do this run leaves no finding, and last run's failure
  // must not outlive the run that fixed it.
  await db.validationFinding.deleteMany({ where: { caseId, result: { startsWith: RETRIEVAL_FINDING_PREFIX } } });
  if (!rows.length) return;
  await db.validationFinding.createMany({
    data: rows.map((r) => ({
      caseId,
      firmId,
      ...r,
      status: disposition.get(`${r.service}|${r.result}`) ?? "OPEN",
    })),
  });
}
