// ─────────────────────────────────────────────────────────────────────────────
// PubMed (NCBI E-utilities) lookup. Returns REAL, verifiable articles — the app
// never invents citations. For a care recommendation we search the topic,
// preferring the highest levels of evidence (systematic reviews, meta-analyses,
// practice guidelines, RCTs), and return the single strongest match with a
// resolvable PubMed URL. Best-effort: returns null on any error/offline.
//
// Set PUBMED_API_KEY to raise the rate limit (3 → 10 req/s). No key required.
// ─────────────────────────────────────────────────────────────────────────────

export interface Article {
  pmid: string;
  title: string;
  authors: string;
  journal: string;
  year: string;
  url: string;
}

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const KEY = process.env.PUBMED_API_KEY ? `&api_key=${process.env.PUBMED_API_KEY}` : "";

// Global request throttle so ALL calls stay under PubMed's rate limit (3/s
// without a key, 10/s with one).
const MIN_GAP = process.env.PUBMED_API_KEY ? 120 : 360;
let lastCall = 0;
async function throttle() {
  const wait = MIN_GAP - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function esearchTop(term: string): Promise<string | null> {
  await throttle();
  const url = `${BASE}/esearch.fcgi?db=pubmed&retmode=json&retmax=1&sort=relevance&term=${encodeURIComponent(term)}${KEY}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { esearchresult?: { idlist?: string[] } };
  return j.esearchresult?.idlist?.[0] ?? null;
}

async function esummary(pmid: string): Promise<Article | null> {
  await throttle();
  const url = `${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}${KEY}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { result?: Record<string, { title?: string; source?: string; pubdate?: string; authors?: { name: string }[] }> };
  const a = j.result?.[pmid];
  if (!a || !a.title) return null;
  const names = (a.authors ?? []).map((x) => x.name).filter(Boolean);
  const authors = names.slice(0, 3).join(", ") + (names.length > 3 ? ", et al." : "");
  return {
    pmid,
    title: a.title.replace(/\.$/, ""),
    authors,
    journal: a.source ?? "",
    year: (a.pubdate ?? "").slice(0, 4),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

/**
 * The single strongest real supporting article for a clinical topic, or null.
 * Relevance-first (keeps results on-topic), restricted to review-type / trial
 * evidence so the match is both relevant AND high-quality; falls back to plain
 * relevance if that yields nothing.
 */
export async function findBestArticle(query: string): Promise<Article | null> {
  try {
    const filtered = `(${query}) AND (Review[pt] OR systematic[sb] OR "meta-analysis"[pt] OR "practice guideline"[pt] OR "randomized controlled trial"[pt])`;
    const pmid = (await esearchTop(filtered)) ?? (await esearchTop(query));
    return pmid ? await esummary(pmid) : null;
  } catch {
    return null;
  }
}

/** Quick connectivity probe so enrichment can fail fast when offline. */
export async function pubmedReachable(): Promise<boolean> {
  try {
    return !!(await esearchTop("medicine"));
  } catch {
    return false;
  }
}

/** A one-line human-readable citation from an Article. */
export function formatCitation(a: Article): string {
  return `${a.authors}. ${a.title}. ${a.journal}${a.year ? `. ${a.year}` : ""}. PMID ${a.pmid}.`;
}
