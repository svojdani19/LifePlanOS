// Crossref — DOI registration metadata across virtually every scholarly journal
// and many clinical practice guidelines, broader than PubMed's biomedical index.
// Free, no key; a mailto puts us in the faster "polite pool".
// Docs: https://api.crossref.org

import { fetchJson, makeThrottle } from "./http";
import { fmtAuthors, normKey, stripTags, type Article } from "./types";

const throttle = makeThrottle(150);
const BASE = "https://api.crossref.org/works";
const MAILTO = process.env.CROSSREF_MAILTO || "support@lifeplanos.app";

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  "container-title"?: string[];
  issued?: { "date-parts"?: number[][] };
  abstract?: string;
  type?: string;
  subtype?: string;
  "is-referenced-by-count"?: number;
}

export async function search(query: string, limit = 12): Promise<Article[]> {
  const url =
    `${BASE}?query=${encodeURIComponent(query)}&rows=${limit}` +
    `&filter=type:journal-article` +
    `&select=DOI,title,author,container-title,issued,abstract,type,subtype,is-referenced-by-count` +
    `&mailto=${encodeURIComponent(MAILTO)}`;
  const j = await fetchJson<{ message?: { items?: CrossrefItem[] } }>(url, { throttle });
  const items = j?.message?.items ?? [];
  const out: Article[] = [];
  for (const it of items) {
    const title = it.title?.[0];
    if (!title || !it.DOI) continue;
    const names = (it.author ?? []).map((a) => (a.family ? `${a.family}${a.given ? ` ${a.given[0]}` : ""}` : a.name ?? ""));
    const year = String(it.issued?.["date-parts"]?.[0]?.[0] ?? "");
    const pubtype = [it.type, it.subtype].filter(Boolean) as string[];
    out.push({
      source: "crossref",
      key: normKey({ doi: it.DOI, title }),
      doi: it.DOI,
      title: stripTags(title).replace(/\.$/, ""),
      authors: fmtAuthors(names),
      journal: it["container-title"]?.[0] ?? "",
      year,
      url: `https://doi.org/${it.DOI}`,
      abstract: it.abstract ? stripTags(it.abstract) : undefined,
      pubtype,
      citationCount: it["is-referenced-by-count"],
    });
  }
  return out;
}
