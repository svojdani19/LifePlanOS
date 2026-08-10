// ─────────────────────────────────────────────────────────────────────────────
// One visit is one entry.
//
// A single chiropractic visit on 07/12/2023 produced FOURTEEN extracted rows.
// The published plan has one. The rows were not different records: they were
// the same note read by overlapping chunks, plus the billing line for the same
// visit, each written out as though it were its own encounter. Downstream, that
// is a chronology with fourteen entries for one appointment, fourteen citations
// to the same pages, and a records list longer than the pile of paper it came
// from — which is the state the reviewer described as "you cannot have more
// records than uploaded documents".
//
// Consolidation did not catch them because it matched on provider and page, and
// both were empty: provider lives in the document header rather than in the
// chunk, and every row in a 56-page packet recorded itself on "page 1". So this
// merges on what IS reliable — the source document and the encounter date —
// and then de-duplicates the claims, which is where the real redundancy lives.
//
// A merged entry keeps every distinct fact from every row it absorbs. Merging
// must never lose a claim; if two rows disagree, both statements survive and
// the disagreement is visible to a reviewer rather than silently resolved.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";
import type { SynthClaim } from "@/lib/llm/groundedSynthesis";
import { spanOf, type PreparedDocument, type RowSpan } from "@/lib/records/rowSpans";

export interface MergeableRow {
  id: string;
  sourceDocumentId: string;
  analysisClass: AnalysisClass | null;
  encounterDate: Date | null;
  provider: string | null;
  facility: string | null;
  page: number | null;
  pageEnd: number | null;
  substanceClass: string | null;
  /** DOCUMENTED | INFERRED | UNKNOWN | DISPUTED. Governs whether the date may merge rows. */
  dateStatus?: string | null;
  claims: readonly { field: string; value: string; excerpt: string; page?: number | null; claimType?: string | null }[];
}

export interface MergedEntry {
  /** Every row that was folded in, so a reviewer can trace back. */
  rowIds: string[];
  sourceDocumentId: string;
  klass: AnalysisClass;
  encounterDate: Date | null;
  provider: string | null;
  facility: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  claims: SynthClaim[];
  /** Classes seen among the merged rows, when they disagreed. */
  mergedClasses: AnalysisClass[];
  /** Other documents the same record was found in, after cross-document dedupe. */
  alsoInDocumentIds?: string[];
}

/**
 * Rows belonging to the same record.
 *
 * Deliberately NOT keyed on provider or page: both are unreliable today, and
 * keying on an empty field merges everything or nothing. A document plus a date
 * is the coarsest key that is actually trustworthy, and it is what the planner
 * uses too — their entries read "07/12/2023 - Michael Crone, DC /The Houston
 * Spine and Rehabilitation Centers", one per note per day.
 */
export function mergeKey(row: MergeableRow): string {
  if (!row.encounterDate) return `${row.sourceDocumentId}::undated:${row.id}`;
  return `${row.sourceDocumentId}::${row.encounterDate.toISOString().slice(0, 10)}`;
}

/**
 * How much one entry may hold before it stops being one record.
 *
 * Date inheritance assigns a document's dated section to the undated rows
 * around it, and on one real document that pooled ninety rows carrying 1,218
 * claims onto a single day — a whole packet collapsed into one "visit", from
 * which no entry could be composed.
 *
 * Refusing to merge inherited dates at all was the wrong correction: it turned
 * 720 entries into 1,376, which is the same "more records than documents"
 * complaint in the other direction. So groups merge as normal and only an
 * oversized one is split, in document order, into parts that are each a
 * plausible record.
 */
export const MAX_CLAIMS_PER_ENTRY = 80;

/**
 * Which class wins when merged rows disagree.
 *
 * A visit's clinical note and its billing line share a document and a date, and
 * they will merge. The clinical reading must win: an entry that documents an
 * operation and also carries its charge is an operation, and calling it
 * FINANCIAL is how a four-level laminectomy ended up on the timeline as
 * "Procedure 63047 billed, outstanding charge $11,733.30".
 */
const CLASS_PRECEDENCE: AnalysisClass[] = [
  "OPERATIVE",
  "ANESTHESIA",
  "PATHOLOGY_DIAGNOSTIC",
  "DEVICE_OR_IMPLANT",
  "DIAGNOSTIC_STUDY",
  "CLINICAL_ENCOUNTER",
  "THERAPY_COURSE",
  "INCIDENT",
  "TESTIMONY",
  "EXPERT_OPINION",
  "LEGAL",
  "EMPLOYMENT_ECONOMIC",
  "INSURANCE_ADMINISTRATIVE",
  "FINANCIAL",
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
  "SUPPORTING_FILE",
  "UNKNOWN",
];

export function dominantClass(classes: readonly (AnalysisClass | null)[]): AnalysisClass {
  const seen = new Set(classes.filter(Boolean) as AnalysisClass[]);
  for (const k of CLASS_PRECEDENCE) if (seen.has(k)) return k;
  return "UNKNOWN";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

/** Credentials that make a bare name identifiable as a clinician. */
const CREDENTIAL = /\b(?:M\.?D|D\.?O|D\.?C|D\.?P\.?M|D\.?D\.?S|Ph\.?D|R\.?N|L\.?V\.?N|N\.?P|P\.?A|A\.?P\.?R\.?N|P\.?T|D\.?P\.?T|O\.?T|L\.?P\.?N|C\.?R\.?N\.?A|P\.?T\.?A|C\.?N\.?A)\b\.?/i;

/**
 * A provider name we are willing to print.
 *
 * OCR turns a signature block into fragments, and a fragment printed as the
 * authoring clinician is worse than printing nothing: a real entry came back
 * attributed to "Osly", and another to "Andrew", where the record's actual
 * author was Michael Crone, DC. A name earns the byline when it carries a
 * credential or reads as a full name — anything else is discarded, and the
 * entry shows the facility alone rather than a confident wrong answer.
 */
export function cleanProvider(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim().replace(/[,;]+$/, "");
  if (s.length < 3 || s.length > 90) return null;
  if (CREDENTIAL.test(s)) return s;
  // Two or more capitalised words: "Michael Crone", "Mary Catharine Maxian".
  const words = s.split(" ").filter((w) => /^[A-Z][A-Za-z'’-]{1,}$/.test(w));
  return words.length >= 2 ? s : null;
}

/**
 * A facility name without the mail-room furniture.
 *
 * Facilities arrive as "EHS - Porter Hospital Systems, 24540 Fm 1314 Rd,
 * Porter, TX 77365". A chronology heading wants the institution, not the way
 * to drive there, and the street address crowds out the clinical content on
 * every row it appears in.
 */
export function cleanFacilityName(raw: string | null | undefined): string | null {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Drop from the first address-looking segment onward.
  s = s.split(/,\s*(?=\d)/)[0];
  s = s.replace(/,?\s*\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b.*$/, "");
  s = s.replace(/,?\s*\b\d{2,6}\s+[A-Za-z0-9. ]+\b(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Hwy|Highway|Pkwy|Suite|Ste|Fwy)\b\.?.*$/i, "");
  s = s.replace(/[,;\s-]+$/, "").trim();
  return s.length >= 3 && s.length <= 120 ? s : null;
}

/**
 * Can this document's page numbers be cited?
 *
 * A 56-page packet recorded every extracted row on "page 1". Printing "p. 1"
 * against an entry drawn from page 12 sends a reviewer to the wrong page and
 * looks authoritative doing it, which is worse than an entry with no citation
 * at all. So pages are cited only when they actually vary across the document.
 */
export function pageAttributionUsable(rows: readonly MergeableRow[], pageCount: number | null): boolean {
  const pages = new Set<number>();
  for (const r of rows) {
    if (typeof r.page === "number" && r.page > 0) pages.add(r.page);
    if (typeof r.pageEnd === "number" && r.pageEnd > 0) pages.add(r.pageEnd);
  }
  if (!pages.size) return false;
  // One distinct page across a document of many is attribution that never ran.
  if (pages.size === 1 && (pageCount ?? 1) > 2) return false;
  return true;
}

/**
 * Is this claim already recorded?
 *
 * The fourteen rows carried the same fact in slightly different words — "the
 * previous night" and "last night", "as prescribed per the doctor" and "as
 * prescribed by the doctor". Exact matching keeps all of them and the entry
 * reads as a stutter. So a claim is a duplicate when it shares a field with an
 * existing claim and one normalized value contains the other, which catches
 * both the reworded near-copies and the truncated ones.
 */
export function isDuplicateClaim(candidate: { field: string; value: string }, existing: readonly { field: string; value: string }[]): boolean {
  const c = norm(candidate.value);
  if (!c) return true;
  for (const e of existing) {
    if (e.field !== candidate.field) continue;
    const v = norm(e.value);
    if (v === c) return true;
    // Containment, but only when the shorter side is substantial: "traction"
    // inside "traction performed at 62 lbs" is a duplicate, while a two-word
    // fragment inside a long sentence is not enough to drop a distinct fact.
    const [short, long] = c.length <= v.length ? [c, v] : [v, c];
    if (short.length >= 20 && long.includes(short)) return true;
  }
  return false;
}

/** Keep the fuller statement of a fact when one row said it better. */
function preferLonger(a: SynthClaim, b: SynthClaim): SynthClaim {
  return b.value.length > a.value.length ? b : a;
}

/**
 * Fold entries that are the same record filed in more than one document.
 *
 * A case file is not a set of distinct records: the same operative report is
 * bound into the hospital packet, faxed to the surgeon's office, and attached
 * to a billing affidavit. A real chronology showed 10/10/2004 four times with
 * near-identical text, one per PDF the record happened to appear in, which is
 * the same "more records than documents" complaint one level up from chunking.
 *
 * Same date and substantially the same content is the test. Provider is NOT
 * required to match — the same record often carries a different byline in each
 * copy, sometimes an OCR variant of one name ("Girish Gidwani" and "Girlsh
 * Gidwani"). The surviving entry keeps the richest copy and records every
 * document it was found in, so a reviewer can still reach any of them.
 */
export function dedupeAcrossDocuments(entries: readonly MergedEntry[]): MergedEntry[] {
  const kept: MergedEntry[] = [];
  for (const entry of entries) {
    const date = entry.encounterDate?.getTime();
    const twin = date
      ? kept.find(
          (k) =>
            k.encounterDate?.getTime() === date &&
            k.sourceDocumentId !== entry.sourceDocumentId &&
            contentOverlap(k, entry) >= 0.6,
        )
      : undefined;
    if (!twin) {
      kept.push({ ...entry });
      continue;
    }
    // Keep whichever copy states more, and absorb the other's provenance.
    const richer = entry.claims.length > twin.claims.length ? entry : twin;
    const poorer = richer === twin ? entry : twin;
    Object.assign(twin, {
      ...richer,
      rowIds: [...twin.rowIds, ...entry.rowIds],
      provider: richer.provider ?? poorer.provider,
      facility: richer.facility ?? poorer.facility,
      alsoInDocumentIds: [...new Set([...(twin.alsoInDocumentIds ?? []), poorer.sourceDocumentId])],
    });
  }
  return kept;
}

/** Share of the smaller entry's claims that the larger one also states. */
function contentOverlap(a: MergedEntry, b: MergedEntry): number {
  const [small, large] = a.claims.length <= b.claims.length ? [a, b] : [b, a];
  if (!small.claims.length) return 0;
  let hits = 0;
  for (const c of small.claims) if (isDuplicateClaim(c, large.claims)) hits++;
  return hits / small.claims.length;
}

/** The page range a whole group covers, resolved from the document's markers. */
function spanOfGroup(doc: PreparedDocument, group: readonly MergeableRow[]): RowSpan | null {
  const spans = group.map((r) => spanOf(doc, r)).filter((s): s is RowSpan => !!s);
  if (!spans.length) return null;
  const pages = spans.flatMap((s) => [s.pageStart, s.pageEnd]).filter((n): n is number => typeof n === "number");
  return {
    start: Math.min(...spans.map((s) => s.start)),
    end: Math.max(...spans.map((s) => s.end)),
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
  };
}

/** Group by document and date. */
function dateGroups(rows: readonly MergeableRow[]): MergeableRow[][] {
  const groups = new Map<string, MergeableRow[]>();
  for (const row of rows) {
    const key = mergeKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

/** Break a group that carries more than one record's worth of claims. */
function splitOversized(group: readonly MergeableRow[]): MergeableRow[][] {
  const total = group.reduce((n, r) => n + r.claims.length, 0);
  if (total <= MAX_CLAIMS_PER_ENTRY || group.length < 2) return [[...group]];
  const parts: MergeableRow[][] = [];
  let current: MergeableRow[] = [];
  let count = 0;
  for (const row of group) {
    if (current.length && count + row.claims.length > MAX_CLAIMS_PER_ENTRY) {
      parts.push(current);
      current = [];
      count = 0;
    }
    current.push(row);
    count += row.claims.length;
  }
  if (current.length) parts.push(current);
  return parts;
}

/**
 * Merge a document's rows into records.
 *
 * Grouped by document and date. Grouping by where the rows SIT in the document
 * was tried and measured worse on both counts that matter: 1,181 entries at
 * 44% unwritable against 720 at 14%. About a fifth of rows cannot be located
 * in their own source at all — their excerpts do not match the OCR'd text —
 * and every one of those became a single-row record too thin to compose an
 * entry from. Position is the better idea and the wrong one to act on until
 * excerpt matching survives degraded scans.
 *
 * The document is still used, for the one thing offsets do reliably: telling
 * us which page a record is actually on, where the recorded page numbers put
 * every row of a 56-page packet on "page 1".
 */
export function mergeRows(rows: readonly MergeableRow[], doc?: PreparedDocument): MergedEntry[] {
  const groups: { rows: MergeableRow[]; span: RowSpan | null }[] = dateGroups(rows).map((g) => ({
    rows: g,
    span: doc ? spanOfGroup(doc, g) : null,
  }));

  const out: MergedEntry[] = [];
  for (const { rows: wholeGroup, span } of groups) {
   for (const group of splitOversized(wholeGroup)) {
    const claims: SynthClaim[] = [];
    let n = 0;
    for (const row of group) {
      for (const c of row.claims) {
        if (!c.value?.trim()) continue;
        const dupIndex = claims.findIndex(
          (e) => e.field === c.field && isDuplicateClaim(c, [e]),
        );
        if (dupIndex >= 0) {
          claims[dupIndex] = preferLonger(claims[dupIndex], {
            id: claims[dupIndex].id,
            field: c.field,
            claimType: c.claimType ?? undefined,
            value: c.value,
            excerpt: c.excerpt,
            page: c.page ?? null,
          });
          continue;
        }
        claims.push({
          id: `c${++n}`,
          field: c.field,
          claimType: c.claimType ?? undefined,
          value: c.value,
          excerpt: c.excerpt,
          page: c.page ?? null,
        });
      }
    }

    // Pages resolved from the text's own offsets beat the recorded ones, which
    // a 56-page packet reported as "page 1" on every row.
    const pages = span?.pageStart
      ? [span.pageStart, span.pageEnd ?? span.pageStart]
      : group.flatMap((r) => [r.page, r.pageEnd]).filter((p): p is number => typeof p === "number" && p > 0);
    const classes = group.map((r) => r.analysisClass);

    out.push({
      rowIds: group.map((r) => r.id),
      sourceDocumentId: group[0].sourceDocumentId,
      klass: dominantClass(classes),
      // A date the record states outranks one it inherited from a neighbour.
      encounterDate:
        group.find((r) => r.encounterDate && r.dateStatus === "DOCUMENTED")?.encounterDate ??
        group.find((r) => r.encounterDate)?.encounterDate ??
        null,
      // A provider named by ANY row governs the merged entry: the name usually
      // appears in one chunk and is absent from the rest of the same note.
      provider: group.map((r) => cleanProvider(r.provider)).find(Boolean) ?? null,
      facility: group.map((r) => cleanFacilityName(r.facility)).find(Boolean) ?? null,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      claims,
      mergedClasses: [...new Set(classes.filter(Boolean) as AnalysisClass[])],
    });
   }
  }

  return out.sort((a, b) => (a.encounterDate?.getTime() ?? 0) - (b.encounterDate?.getTime() ?? 0));
}
