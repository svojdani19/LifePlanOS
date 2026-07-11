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
  /** PubMed publication types (e.g. "Systematic Review") — used for ranking. */
  pubtype?: string[];
}

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const KEY = process.env.PUBMED_API_KEY ? `&api_key=${process.env.PUBMED_API_KEY}` : "";

// Global request throttle so ALL calls stay under PubMed's rate limit (3/s
// without a key, 10/s with one).
const MIN_GAP = process.env.PUBMED_API_KEY ? 120 : 400;
let lastCall = 0;
async function throttle() {
  const wait = MIN_GAP - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

// Throttled fetch with retry/backoff on rate-limit or transient server errors —
// a sustained enrichment run must not silently turn 429s into "no article".
async function eFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) }).catch(() => null);
    if (r?.ok) return r;
    if (r && r.status !== 429 && r.status < 500) return null; // real error — don't retry
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return null;
}

async function esearchIds(term: string, retmax = 1): Promise<string[]> {
  const url = `${BASE}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&sort=relevance&term=${encodeURIComponent(term)}${KEY}`;
  const r = await eFetch(url);
  if (!r) return [];
  const j = (await r.json()) as { esearchresult?: { idlist?: string[] } };
  return j.esearchresult?.idlist ?? [];
}

async function esearchTop(term: string): Promise<string | null> {
  return (await esearchIds(term, 1))[0] ?? null;
}

type Summary = { title?: string; source?: string; pubdate?: string; sortpubdate?: string; authors?: { name: string }[]; pubtype?: string[] };

function toArticle(pmid: string, a: Summary): Article | null {
  if (!a || !a.title) return null;
  const names = (a.authors ?? []).map((x) => x.name).filter(Boolean);
  const authors = names.slice(0, 3).join(", ") + (names.length > 3 ? ", et al." : "");
  return {
    pmid,
    title: a.title.replace(/\.$/, ""),
    authors,
    journal: a.source ?? "",
    year: (a.sortpubdate ?? a.pubdate ?? "").slice(0, 4),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    pubtype: a.pubtype ?? [],
  };
}

// One batched esummary call for many PMIDs (preserving PubMed's relevance order).
async function esummaryMany(pmids: string[]): Promise<Article[]> {
  if (!pmids.length) return [];
  const url = `${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${pmids.join(",")}${KEY}`;
  const r = await eFetch(url);
  if (!r) return [];
  const j = (await r.json()) as { result?: Record<string, Summary> };
  const out: Article[] = [];
  for (const pmid of pmids) {
    const art = j.result?.[pmid] ? toArticle(pmid, j.result[pmid]!) : null;
    if (art) out.push(art);
  }
  return out;
}

async function esummary(pmid: string): Promise<Article | null> {
  return (await esummaryMany([pmid]))[0] ?? null;
}

/**
 * A pool of candidate articles for a clinical topic (PubMed relevance order),
 * so a caller can re-rank for service-specificity. Requests the high-evidence
 * pool first (reviews / meta-analyses / guidelines / RCTs), then tops up with a
 * plain-relevance pool so specific primary studies are also considered. Returns
 * de-duplicated Articles carrying their publication types. Best-effort → [].
 */
export async function findArticles(query: string, limit = 12): Promise<Article[]> {
  try {
    const filtered = `(${query}) AND (Review[pt] OR systematic[sb] OR "meta-analysis"[pt] OR "practice guideline"[pt] OR "randomized controlled trial"[pt])`;
    const ids = new Set<string>();
    for (const id of await esearchIds(filtered, limit)) ids.add(id);
    if (ids.size < limit) for (const id of await esearchIds(query, limit)) ids.add(id);
    return await esummaryMany([...ids].slice(0, limit * 2));
  } catch {
    return [];
  }
}

/** The single strongest real supporting article for a clinical topic, or null. */
export async function findBestArticle(query: string): Promise<Article | null> {
  return (await findArticles(query, 1))[0] ?? null;
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
