// Semantic Scholar — an AI-built corpus with strong relevance ranking, abstracts
// and TL;DR summaries. Its keyless tier is aggressively rate-limited (shared,
// frequent 429s), so it is treated as an OPPORTUNISTIC extra source: enabled
// only when SEMANTIC_SCHOLAR_API_KEY is set, and any failure is swallowed so it
// never slows or breaks a run. Setting the key makes it a reliable third source.
// Docs: https://api.semanticscholar.org/api-docs

import { fetchJson, makeThrottle } from "./http";
import { fmtAuthors, normKey, type Article } from "./types";

const KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || "";
const throttle = makeThrottle(KEY ? 120 : 1200);
const BASE = "https://api.semanticscholar.org/graph/v1/paper/search";

interface S2Paper {
  title?: string;
  abstract?: string;
  year?: number;
  venue?: string;
  authors?: { name?: string }[];
  externalIds?: { DOI?: string; PubMed?: string };
  citationCount?: number;
  publicationTypes?: string[];
  tldr?: { text?: string };
}

export function enabled(): boolean {
  return !!KEY;
}

export async function search(query: string, limit = 10): Promise<Article[]> {
  if (!KEY) return []; // keyless tier too flaky to rely on; opt in via env
  const fields = "title,abstract,year,venue,authors,externalIds,citationCount,publicationTypes,tldr";
  const url = `${BASE}?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;
  const j = await fetchJson<{ data?: S2Paper[] }>(url, { throttle, retries: 1, headers: { "x-api-key": KEY } });
  const papers = j?.data ?? [];
  const out: Article[] = [];
  for (const p of papers) {
    if (!p.title) continue;
    const doi = p.externalIds?.DOI;
    const pmid = p.externalIds?.PubMed;
    out.push({
      source: "semanticscholar",
      key: normKey({ doi, pmid, title: p.title }),
      pmid,
      doi,
      title: p.title.replace(/\.$/, ""),
      authors: fmtAuthors((p.authors ?? []).map((a) => a.name)),
      journal: p.venue ?? "",
      year: p.year ? String(p.year) : "",
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : doi ? `https://doi.org/${doi}` : "https://www.semanticscholar.org/",
      abstract: p.abstract || p.tldr?.text || undefined,
      pubtype: p.publicationTypes ?? [],
      citationCount: p.citationCount,
    });
  }
  return out;
}
