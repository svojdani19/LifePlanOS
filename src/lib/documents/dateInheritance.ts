// ─────────────────────────────────────────────────────────────────────────────
// Placing an undated entry within its OWN document.
//
// A consolidated packet carries its dates unevenly: a service-date header sits
// at the top of a note and the four pages that follow it carry none. Reading
// each page in isolation produces entries the pipeline calls "undated" even
// though the document says plainly when they happened — and then lists them
// apart from the document they came from, as if they were loose material.
//
// They are not loose. They belong to a dated section of a document already in
// evidence, and the honest thing is to say which one. So an undated entry is
// resolved against the DATED CONTENT OF ITS OWN DOCUMENT, in this order:
//
//   1. A dated entry from the same document whose page span CONTAINS it.
//      Pages 3–7 are one dated note; an undated fragment on page 5 is part of
//      it, not a separate record.
//   2. The dated section (segment) of the same document covering its page.
//   3. Nothing. It stays UNKNOWN and visible.
//
// Two rules keep this from becoming invention:
//   • An inherited date is INFERRED, never DOCUMENTED. It was not cited on
//     that page; it was carried from a neighbour, and the row says so.
//   • Inheritance never crosses a document. A date from one upload can never
//     explain a page in another.
// ─────────────────────────────────────────────────────────────────────────────

export interface DatableEntry {
  dateStatus: "DOCUMENTED" | "INFERRED" | "UNKNOWN";
  encounterDate: Date | null;
  encounterDateEnd: Date | null;
  page: number | null;
  pageEnd: number | null;
  sourceDocumentId: string;
  warnings: string[];
}

/** A dated section of the document, as the deterministic segmenter found it. */
export interface DatedSection {
  date: string | null; // ISO
  pageStart: number | null;
  pageEnd: number | null;
}

export interface InheritanceResult<T> {
  entries: T[];
  /** How many entries were placed, for the run's disclosure. */
  placed: number;
  /** How many remain genuinely undated. */
  unresolved: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Resolve undated entries against the dated content of the same document.
 * Pure: takes the document's entries and its dated sections, returns entries
 * with dates inherited where the document itself supports it.
 */
export function inheritDatesWithinDocument<T extends DatableEntry>(entries: T[], sections: DatedSection[] = []): InheritanceResult<T> {
  const dated = entries.filter((e) => e.encounterDate && e.page != null);
  const usableSections = sections.filter((s) => s.date && s.pageStart != null);

  let placed = 0;
  let unresolved = 0;

  const out = entries.map((e) => {
    if (e.dateStatus !== "UNKNOWN" || e.encounterDate) return e;
    if (e.page == null) {
      // No page means no position in the document, so nothing can place it.
      unresolved++;
      return e;
    }

    // 1. A dated sibling whose span contains this page. The tightest span wins:
    //    a four-page note explains its own page 5 better than a forty-page
    //    admission that also covers it.
    const containing = dated
      .filter((d) => e.page! >= d.page! && e.page! <= (d.pageEnd ?? d.page!))
      .sort((a, b) => ((a.pageEnd ?? a.page!) - a.page!) - ((b.pageEnd ?? b.page!) - b.page!))[0];
    if (containing?.encounterDate) {
      placed++;
      return {
        ...e,
        dateStatus: "INFERRED" as const,
        encounterDate: containing.encounterDate,
        warnings: [
          ...e.warnings,
          `Date inherited from the dated entry covering pages ${containing.page}–${containing.pageEnd ?? containing.page} of this same document (${iso(containing.encounterDate)}); this page cites no date of its own and requires confirmation.`,
        ],
      };
    }

    // 2. A dated section of this document covering the page.
    const section = usableSections
      .filter((s) => e.page! >= s.pageStart! && e.page! <= (s.pageEnd ?? s.pageStart!))
      .sort((a, b) => ((a.pageEnd ?? a.pageStart!) - a.pageStart!) - ((b.pageEnd ?? b.pageStart!) - b.pageStart!))[0];
    if (section?.date) {
      placed++;
      return {
        ...e,
        dateStatus: "INFERRED" as const,
        encounterDate: new Date(`${section.date}T00:00:00Z`),
        warnings: [
          ...e.warnings,
          `Date inherited from the dated section of this same document covering pages ${section.pageStart}–${section.pageEnd ?? section.pageStart} (${section.date}); this page cites no date of its own and requires confirmation.`,
        ],
      };
    }

    unresolved++;
    return e;
  });

  return { entries: out, placed, unresolved };
}
