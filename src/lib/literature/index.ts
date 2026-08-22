// Multi-source literature aggregator. A single query is reviewed against EVERY
// configured source in parallel (Europe PMC + Crossref, plus Semantic Scholar
// when a key is set); the results are merged and de-duplicated into one
// candidate pool so the caller can pick the most relevant article regardless of
// which API surfaced it. Every candidate is a real, resolvable record.

import * as europepmc from "./europepmc";
import * as crossref from "./crossref";
import * as semanticscholar from "./semanticscholar";
import { mergeArticle, type Article, type Source } from "./types";
import { classifyRetrievalFailure, retrievalDetail, type RetrievalFailure } from "@/lib/engine/retrievalStatus";

export type { Article, Source } from "./types";

const SOURCES: { name: Source; search: (q: string, n: number) => Promise<Article[]> }[] = [
  { name: "europepmc", search: europepmc.search },
  { name: "crossref", search: crossref.search },
  { name: "semanticscholar", search: semanticscholar.search },
];

/** Names of the sources actually queried this run (for logging/telemetry). */
export function activeSources(): Source[] {
  return SOURCES.filter((s) => s.name !== "semanticscholar" || semanticscholar.enabled()).map((s) => s.name);
}

/**
 * The outcome of ONE source answering ONE query.
 *
 * The merged article list could not distinguish "this source answered and had
 * nothing" from "this source never answered". Both contributed zero articles,
 * both were invisible afterwards, and a producer that saw an empty pool
 * reported NO_RESULTS — a claim about the literature that only the first one
 * supports.
 */
export interface SourceAttempt {
  source: Source;
  /** The case-specific query text. Clinical terms only — never patient facts. */
  query: string;
  status: "FULFILLED" | "REJECTED" | "SKIPPED";
  /** Null unless REJECTED. */
  failure: RetrievalFailure | null;
  /** Bounded, non-identifying reason. Null on success. */
  detail: string | null;
  /** Articles this source returned, before merge and before relevance gating. */
  results: number;
}

export interface CandidateSearch {
  articles: Article[];
  attempts: SourceAttempt[];
}

/**
 * Candidate articles for a clinical query, with the fate of every source.
 *
 * A source that errors still contributes no articles — the search stays
 * best-effort — but its failure is now reported rather than swallowed, so the
 * caller can tell an empty result set that means something from one that means
 * nothing.
 */
export async function searchCandidates(query: string, perSource = 12): Promise<CandidateSearch> {
  const active = SOURCES.filter((s) => s.name !== "semanticscholar" || semanticscholar.enabled());
  const skipped: SourceAttempt[] = SOURCES.filter((s) => !active.includes(s)).map((s) => ({
    source: s.name,
    query,
    // A source that is not configured was never asked. It is not a failure, and
    // it is not evidence that the literature is empty either.
    status: "SKIPPED" as const,
    failure: null,
    detail: "not configured",
    results: 0,
  }));

  const settled = await Promise.allSettled(active.map((s) => s.search(query, perSource)));
  const byKey = new Map<string, Article>();
  const attempts: SourceAttempt[] = [];

  settled.forEach((r, i) => {
    const source = active[i].name;
    if (r.status !== "fulfilled") {
      attempts.push({
        source,
        query,
        status: "REJECTED",
        failure: classifyRetrievalFailure(r.reason),
        detail: retrievalDetail(r.reason),
        results: 0,
      });
      return;
    }
    attempts.push({ source, query, status: "FULFILLED", failure: null, detail: null, results: r.value.length });
    for (const art of r.value) {
      if (!art.title) continue;
      const existing = byKey.get(art.key);
      byKey.set(art.key, existing ? mergeArticle(existing, art) : art);
    }
  });

  return { articles: [...byKey.values()], attempts: [...attempts, ...skipped] };
}

/**
 * Articles only, for callers that genuinely do not need the source outcomes.
 *
 * Prefer `searchCandidates`: a caller that will make a claim about ABSENCE
 * needs the attempts, because an empty array here is silent about why.
 */
export async function findCandidates(query: string, perSource = 12): Promise<Article[]> {
  return (await searchCandidates(query, perSource)).articles;
}

export interface Reachability {
  reachable: boolean;
  /** Null when reachable. Otherwise why the probe could not confirm a source. */
  failure: RetrievalFailure | null;
  detail: string;
}

/**
 * Connectivity probe that says WHY, not just no.
 *
 * The boolean version could not tell "both sources rejected the request" from
 * "both sources answered, with nothing for the word medicine". Callers turned
 * either one into a silent zero, and the report then printed "no guideline
 * located" — a claim about the literature that an unreachable network cannot
 * support. The category travels with the answer so the plan can disclose which
 * of the two it is.
 */
export async function literatureReachability(): Promise<Reachability> {
  const [a, b] = await Promise.allSettled([europepmc.search("medicine", 1), crossref.search("medicine", 1)]);
  if ((a.status === "fulfilled" && a.value.length > 0) || (b.status === "fulfilled" && b.value.length > 0)) {
    return { reachable: true, failure: null, detail: "At least one literature source answered the probe." };
  }
  // A FULFILLED response proves that source was reachable, empty or not. The
  // earlier version required EVERY source to answer, so one rejecting source
  // marked the whole producer offline and suppressed a search the other source
  // would have completed.
  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejections = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (fulfilled.length) {
    return {
      reachable: true,
      failure: null,
      detail: rejections.length
        ? `${fulfilled.length} source(s) answered the probe; ${rejections.length} rejected. Per-source outcomes are recorded on each query.`
        : "Sources answered the probe with no results; treating as reachable.",
    };
  }
  // Prefer the most specific category among the failures — an auth or rate-limit
  // answer is a real answer from a reachable host, and is more actionable than
  // a generic unreachable.
  const cats = rejections.map((r) => classifyRetrievalFailure(r.reason));
  const rank: RetrievalFailure[] = ["AUTH", "RATE_LIMITED", "TIMEOUT", "MALFORMED", "CANCELLED", "UNREACHABLE", "UNKNOWN"];
  const failure = rank.find((c) => cats.includes(c)) ?? "UNKNOWN";
  return { reachable: false, failure, detail: rejections.map((r) => retrievalDetail(r.reason)).join(" | ").slice(0, 300) };
}

/** Fast connectivity probe so enrichment fails fast when fully offline. */
export async function literatureReachable(): Promise<boolean> {
  return (await literatureReachability()).reachable;
}
