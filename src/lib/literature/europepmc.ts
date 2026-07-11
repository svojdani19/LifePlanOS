// Europe PMC — a superset of PubMed/MEDLINE plus PMC full text, patents and
// agricultural literature, with a clean JSON REST API that returns abstracts,
// publication types and citation counts. No API key required.
// Docs: https://europepmc.org/RestfulWebService

import { fetchJson, makeThrottle } from "./http";
import { fmtAuthors, normKey, stripTags, type Article } from "./types";

const throttle = makeThrottle(120);
const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

interface EpmcHit {
  id?: string;
  source?: string;
  pmid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  journalInfo?: { journal?: { title?: string } };
  pubYear?: string;
  firstPublicationDate?: string;
  abstractText?: string;
  pubType?: string;
  pubTypeList?: { pubType?: string[] };
  citedByCount?: number;
}

export async function search(query: string, limit = 15): Promise<Article[]> {
  // Restrict to items that actually have an abstract & are journal articles/
  // reviews so relevance can be judged on content; sorted by relevance (default).
  const q = `(${query}) AND (HAS_ABSTRACT:Y)`;
  const url = `${BASE}?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${limit}`;
  const j = await fetchJson<{ resultList?: { result?: EpmcHit[] } }>(url, { throttle });
  const hits = j?.resultList?.result ?? [];
  const out: Article[] = [];
  for (const h of hits) {
    if (!h.title) continue;
    const pmid = h.pmid;
    const doi = h.doi;
    const journal = h.journalInfo?.journal?.title ?? h.journalTitle ?? "";
    const year = (h.pubYear ?? h.firstPublicationDate ?? "").slice(0, 4);
    const pubtype = h.pubTypeList?.pubType ?? (h.pubType ? [h.pubType] : []);
    const url2 = pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : doi
        ? `https://doi.org/${doi}`
        : `https://europepmc.org/abstract/${h.source ?? "MED"}/${h.id ?? ""}`;
    const art: Article = {
      source: "europepmc",
      key: normKey({ doi, pmid, title: h.title }),
      pmid,
      doi,
      title: h.title.replace(/\.$/, ""),
      authors: shorten(h.authorString),
      journal,
      year,
      url: url2,
      abstract: h.abstractText ? stripTags(h.abstractText) : undefined,
      pubtype,
      citationCount: h.citedByCount,
    };
    out.push(art);
  }
  return out;
}

// Europe PMC's authorString is the full list; keep the first three + et al.
function shorten(authorString?: string): string {
  if (!authorString) return "";
  const names = authorString.replace(/\.$/, "").split(",").map((s) => s.trim());
  return fmtAuthors(names);
}
