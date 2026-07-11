// Multi-source literature aggregator. A single query is reviewed against EVERY
// configured source in parallel (Europe PMC + Crossref, plus Semantic Scholar
// when a key is set); the results are merged and de-duplicated into one
// candidate pool so the caller can pick the most relevant article regardless of
// which API surfaced it. Every candidate is a real, resolvable record.

import * as europepmc from "./europepmc";
import * as crossref from "./crossref";
import * as semanticscholar from "./semanticscholar";
import { mergeArticle, type Article, type Source } from "./types";

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

/** Fast connectivity probe so enrichment fails fast when fully offline. */
export async function literatureReachable(): Promise<boolean> {
  try {
    const [a, b] = await Promise.allSettled([europepmc.search("medicine", 1), crossref.search("medicine", 1)]);
    return (a.status === "fulfilled" && a.value.length > 0) || (b.status === "fulfilled" && b.value.length > 0);
  } catch {
    return false;
  }
}
