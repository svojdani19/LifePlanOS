// ─────────────────────────────────────────────────────────────────────────────
// Unified literature model shared by every source adapter (Europe PMC, Crossref,
// Semantic Scholar…). Every article is a REAL, resolvable record — the app never
// invents citations. Abstracts are carried so relevance can be judged on content,
// not just the title.
// ─────────────────────────────────────────────────────────────────────────────

export type Source = "europepmc" | "crossref" | "semanticscholar";

export interface Article {
  source: Source;
  /** dedup key: doi › pmid › normalized title */
  key: string;
  pmid?: string;
  doi?: string;
  title: string;
  authors: string; // "Smith J, Doe A, et al."
  journal: string;
  year: string;
  url: string;
  abstract?: string;
  /** publication types (e.g. "systematic-review", "Practice Guideline") */
  pubtype?: string[];
  /** times cited (when the source reports it) — a quality signal */
  citationCount?: number;
}

/** "Smith J, Doe A, Lee K, et al." from a list of author display names. */
export function fmtAuthors(names: (string | undefined | null)[]): string {
  const f = names.map((n) => (n ?? "").trim()).filter(Boolean);
  if (!f.length) return "";
  return f.slice(0, 3).join(", ") + (f.length > 3 ? ", et al." : "");
}

/** Strip JATS/HTML tags (Crossref abstracts arrive as markup). */
export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable identity so the same paper from two sources dedups to one. */
export function normKey(a: { doi?: string; pmid?: string; title: string }): string {
  if (a.doi) return "doi:" + a.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (a.pmid) return "pmid:" + a.pmid;
  return "t:" + a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
}

/** Merge a duplicate record into an existing one, filling gaps and keeping the
 *  richest metadata (abstract, ids, citation count). */
export function mergeArticle(into: Article, dup: Article): Article {
  return {
    ...into,
    pmid: into.pmid ?? dup.pmid,
    doi: into.doi ?? dup.doi,
    abstract: (into.abstract && into.abstract.length >= (dup.abstract?.length ?? 0)) ? into.abstract : dup.abstract ?? into.abstract,
    pubtype: (into.pubtype?.length ? into.pubtype : dup.pubtype) ?? into.pubtype,
    citationCount: Math.max(into.citationCount ?? 0, dup.citationCount ?? 0) || into.citationCount,
    // Prefer a PubMed-resolvable URL when available.
    url: into.pmid || !dup.pmid ? into.url : dup.url,
  };
}
