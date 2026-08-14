// ─────────────────────────────────────────────────────────────────────────────
// Rendering a treatment series' membership as a citation.
//
// collapseTreatmentSeries persists every member visit — date, document, page —
// on the series row precisely so the underlying encounters stay citable. The
// renderers then showed only the FIRST document and no page: a series row
// asserting "12 documented visits" cited none of them, which in a medico-legal
// document reads as an unsupported assertion. This is the one formatter every
// surface uses, so the report, the export and the workspace cite a series the
// same way.
// ─────────────────────────────────────────────────────────────────────────────

export interface SeriesMember {
  date?: string | null;
  documentId?: string | null;
  page?: number | null;
}

/** The persisted seriesMembers JSON, defensively narrowed. */
export function seriesMembersOf(value: unknown): SeriesMember[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is SeriesMember => !!m && typeof m === "object");
}

/**
 * One citation sentence covering every member visit, grouped by document with
 * page numbers. Null when the row carries no membership (an ordinary event).
 */
export function seriesCitation(
  members: readonly SeriesMember[],
  nameOf: (documentId: string | null | undefined) => string,
): string | null {
  if (!members.length) return null;
  // Members arrive date-ordered; grouping preserves first-seen document order.
  const byDocument = new Map<string, number[]>();
  for (const m of members) {
    const file = nameOf(m.documentId);
    const pages = byDocument.get(file) ?? [];
    if (typeof m.page === "number") pages.push(m.page);
    byDocument.set(file, pages);
  }
  const parts = [...byDocument.entries()].map(([file, pages]) => {
    const unique = [...new Set(pages)].sort((a, b) => a - b);
    return unique.length ? `${file}, ${unique.length === 1 ? "p." : "pp."} ${unique.join(", ")}` : file;
  });
  return `Sources (${members.length} documented visits): ${parts.join("; ")}.`;
}
