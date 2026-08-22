/**
 * One case-wide statement about what could and could not be searched.
 *
 * The report queried only the latest standard-of-care attempt and handed it to
 * the per-item guideline paragraph. Every other producer — article citations,
 * the evidence graph — recorded its PARTIAL outcome as a persisted,
 * non-blocking ValidationFinding, and neither appendix printed it: Appendix F
 * renders the separately computed integrity findings, Appendix G only blocking
 * rows. So a final report could be produced where half the citation sources
 * were unreachable and the document said nothing at all about it.
 *
 * Deduplicated by producer and by source, and stated once for the case. A
 * partial outage is a fact about the search, not a defect in any particular
 * recommendation, and repeating it per item would manufacture obligations a
 * physician then has to work through row by row.
 */

export interface AttemptRow {
  producer: string;
  status: string;
  failure: string | null;
  failedSources: readonly string[];
  produced: number;
  considered: number;
}

export interface CoverageDisclosure {
  /** Null when every producer completed cleanly — nothing to say. */
  text: string | null;
  /** Producers with an unresolved gap, for tests and callers. */
  degraded: readonly string[];
}

const LABEL: Record<string, string> = {
  "standard-of-care": "guideline analysis",
  "article-citations": "supporting-article citations",
  "evidence-graph": "evidence graph",
};

const label = (p: string) => LABEL[p] ?? p.replace(/[-_]/g, " ");

/** "crossref:TIMEOUT" → "crossref (timeout)" */
const readableSource = (s: string): string => {
  const [name, cause] = s.split(":");
  return cause ? `${name} (${cause.toLowerCase().replace(/_/g, " ")})` : name;
};

export function coverageDisclosure(attempts: readonly AttemptRow[]): CoverageDisclosure {
  const partial = attempts.filter((a) => a.status === "PARTIAL");
  const failed = attempts.filter((a) => a.status === "FAILED" || a.status === "NOT_ATTEMPTED");
  if (!partial.length && !failed.length) return { text: null, degraded: [] };

  const parts: string[] = [];

  if (partial.length) {
    // Deduplicated across producers: one flaky source that broke two searches
    // is one unreachable source, not two.
    const sources = [...new Set(partial.flatMap((a) => a.failedSources))].map(readableSource);
    const which = [...new Set(partial.map((a) => label(a.producer)))].join(" and ");
    parts.push(
      `The ${which} for this plan completed against some sources and not others${sources.length ? ` — ${sources.join(", ")} did not answer` : ""}. ` +
        `What was retrieved is real and is relied upon where it appears. What those sources would have returned is unknown, so this plan's coverage is narrower than a complete search; that is not evidence that nothing further exists.`,
    );
  }

  if (failed.length) {
    const which = [...new Set(failed.map((a) => label(a.producer)))].join(" and ");
    parts.push(
      `The ${which} did not complete for this plan. No statement anywhere in this document about the absence of guidance or literature rests on a completed search.`,
    );
  }

  return {
    text: parts.join(" "),
    degraded: [...new Set([...partial, ...failed].map((a) => a.producer))],
  };
}
