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
 * Candidate articles for a clinical query, merged & de-duplicated across all
 * sources. A source that errors or times out contributes nothing (best-effort);
 * duplicates found in more than one source are merged into the richest record.
 */
export async function findCandidates(query: string, perSource = 12): Promise<Article[]> {
  const settled = await Promise.allSettled(SOURCES.map((s) => s.search(query, perSource)));
  const byKey = new Map<string, Article>();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const art of r.value) {
      if (!art.title) continue;
      const existing = byKey.get(art.key);
      byKey.set(art.key, existing ? mergeArticle(existing, art) : art);
    }
  }
  return [...byKey.values()];
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
  const rejections = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (!rejections.length) {
    // Both answered and both were empty. The network is fine; treat the run as
    // attemptable, and let the producers report NO_RESULTS honestly.
    return { reachable: true, failure: null, detail: "Sources answered the probe with no results; treating as reachable." };
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
