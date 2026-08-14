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

import { createHash } from "node:crypto";
import { NON_CLINICAL_CLASSES, type AnalysisClass } from "@/lib/documents/analysisClass";
import type { SynthClaim } from "@/lib/llm/groundedSynthesis";
import { noteAt, type DocumentNote } from "@/lib/records/noteStructure";
import { spanOf, type PreparedDocument, type RowSpan } from "@/lib/records/rowSpans";
import { compareClass, decideIdentity, distinctiveOverlap, groupByIdentity, isDistinctive, timeFromText, type IdentityFacts } from "@/lib/records/encounterIdentity";

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
  /** Identity of the note this row came from, when segmentation knows it. */
  segmentKey?: string | null;
  claims: readonly { field: string; value: string; excerpt: string; page?: number | null; claimType?: string | null }[];
}

/**
 * One document's copy of a record that appears in several.
 *
 * Folding cross-document copies kept only the other document's ID. Its pages,
 * rows and provider evidence were discarded, so every duplicate copy's Details
 * dropdown showed the PRIMARY document's page numbers — a citation pointing at
 * pages of a different file, which reads as authoritative and is wrong.
 */
export interface RecordAppearance {
  documentId: string;
  pageStart: number | null;
  pageEnd: number | null;
  /** The rows this copy was extracted into, so a reviewer can open it. */
  rowIds: string[];
  /** The provider as THIS copy printed it. */
  provider: string | null;
  /** Identity of this copy's content, without another copy of the content. */
  contentHash: string;
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
  /** Per-document evidence for every copy, including the primary. */
  appearances?: RecordAppearance[];
  /** Where the entry sits in the document text, for note-level consolidation. */
  span?: RowSpan | null;
  /**
   * Rows that could not be proven the same as this entry, nor proven different.
   * Surfaced for review rather than silently merged or silently dropped.
   */
  possibleDuplicateOf?: string[];
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
 *
 * The bound is deliberately loose. It exists only to stop a pathological group
 * — date inheritance once pooled ninety rows and 1,218 claims onto one day —
 * from becoming a single unreadable entry. What the WRITER can compose in one
 * pass is a separate and much smaller number, handled by writing a large
 * record in passes rather than by splitting the record itself; splitting to
 * suit the prompt turned 1,111 entries into 1,684 and broke visits a reviewer
 * reads as one.
 */
export const MAX_CLAIMS_PER_ENTRY = 400;

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
  // Punctuation between them is the chart's, not part of the name — a surname
  // printed first, "Techy, Fernando", is still two words and still a person.
  const words = s.split(" ").filter((w) => /^[A-Z][A-Za-z'’-]{1,}[,.]?$/.test(w));
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
  // Deterministic and order-independent: candidates are considered in a fixed
  // order, so the same set of entries always consolidates the same way.
  const ordered = [...entries].sort(
    (a, b) =>
      (a.encounterDate?.getTime() ?? 0) - (b.encounterDate?.getTime() ?? 0) ||
      (a.sourceDocumentId < b.sourceDocumentId ? -1 : a.sourceDocumentId > b.sourceDocumentId ? 1 : 0) ||
      (a.rowIds[0] ?? "").localeCompare(b.rowIds[0] ?? ""),
  );

  const kept: MergedEntry[] = [];
  for (const entry of ordered) {
    const twin = kept.find((k) => k.sourceDocumentId !== entry.sourceDocumentId && isSameRecordAcrossDocuments(k, entry));
    if (!twin) {
      kept.push({ ...entry, claims: [...entry.claims], rowIds: [...entry.rowIds] });
      continue;
    }
    absorbCopy(twin, entry);
  }
  return kept;
}

/**
 * Is this the same record, filed in two documents?
 *
 * A higher bar than consolidating fragments inside one document, and
 * deliberately so: fragments of one note share a page, while two documents
 * merely sharing a date share nothing. The identity decision must say MERGE —
 * which means compatible classes, no conflicting provider, facility, time,
 * procedure or identifier, and either a matching record identifier or genuine
 * distinctive overlap.
 *
 * An earlier version merged on 60% of the smaller entry's claims overlapping,
 * counted over every claim including boilerplate. Two unrelated notes from one
 * chart share their medication list, their allergies and their standing
 * diagnoses; that is a template, not an identity.
 */
/** The identity facts an entry presents, for callers comparing two of them. */
export function identityFactsOfMergedEntry(entry: MergedEntry): IdentityFacts {
  return identityFactsOfEntry(entry);
}

/** Are two entries' record classes compatible enough to be one record? */
export function classesCompatible(a: MergedEntry, b: MergedEntry): boolean {
  return compareClass(a.klass, b.klass) !== "DIFFERENT";
}

/**
 * Fold pairs an adjudicator judged to be one record.
 *
 * Separate from dedupeAcrossDocuments so the deterministic result is complete
 * before anything else touches it: this only merges what the rules left apart,
 * and cannot separate what they joined.
 */
export function foldAdjudicatedPairs(
  entries: readonly MergedEntry[],
  pairs: readonly { a: MergedEntry; b: MergedEntry }[],
): MergedEntry[] {
  if (!pairs.length) return [...entries];

  // Union-find over the entries named in the pairs, so a record recognised in
  // three productions becomes one entry rather than a chain of two merges.
  const parent = new Map<MergedEntry, MergedEntry>();
  const find = (e: MergedEntry): MergedEntry => {
    const up = parent.get(e);
    if (!up || up === e) return e;
    const root = find(up);
    parent.set(e, root);
    return root;
  };
  for (const entry of entries) parent.set(entry, entry);
  for (const { a, b } of pairs) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  const groups = new Map<MergedEntry, MergedEntry[]>();
  for (const entry of entries) {
    const root = find(entry);
    const group = groups.get(root);
    if (group) group.push(entry);
    else groups.set(root, [entry]);
  }

  const out: MergedEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const folded = foldNote(group);
    // Provenance survives: the entry records every document it was found in,
    // and every copy's own pages and rows.
    folded.alsoInDocumentIds = [
      ...new Set(group.flatMap((g) => [g.sourceDocumentId, ...(g.alsoInDocumentIds ?? [])])),
    ].filter((id) => id !== folded.sourceDocumentId);
    folded.appearances = group.reduce<RecordAppearance[]>(
      (held, member) => mergeAppearances({ ...folded, appearances: held }, member),
      [appearanceOf(folded)],
    );
    out.push(folded);
  }
  return out.sort((a, b) => (a.encounterDate?.getTime() ?? 0) - (b.encounterDate?.getTime() ?? 0));
}

export function isSameRecordAcrossDocuments(a: MergedEntry, b: MergedEntry): boolean {
  // Two copies of one record carry the same date. Undated entries are never
  // folded across documents — there is nothing to anchor them to.
  if (!a.encounterDate || !b.encounterDate) return false;
  if (a.encounterDate.getTime() !== b.encounterDate.getTime()) return false;

  const fa = identityFactsOfEntry(a);
  const fb = identityFactsOfEntry(b);

  // Any conflict at all settles it — different provider, facility, time,
  // procedure or identifier means two records however alike they read.
  const decision = decideIdentity(fa, fb);
  if (decision.verdict === "KEEP_SEPARATE") return false;

  // The same words, claim for claim. Distinctive-fact overlap is a good measure
  // of two accounts that describe one event differently, and a blind one for
  // two copies of the SAME account: where the extractor yields no distinctive
  // facts, identical text scores zero agreement. Ten records survived as pairs
  // that way — one MRI report, one therapy visit, filed in two productions and
  // word-for-word the same in both. Within a document this was already the
  // test; there was no reason for it to stop at the document boundary.
  if (isSameContent(a, b, { requireDistinctive: true })) return true;

  const overlap = distinctiveOverlap(fa, fb);

  // Near-identical clinical content is DIRECT evidence that two entries are one
  // record; agreeing classes are only a proxy for it. Requiring the proxy left
  // one operative report on the timeline six times over — bound into several
  // PDFs and classified differently in each, so "Bilateral lumbar laminectomy
  // L2-S1, patient extubated to PACU" appeared as a lab, a complication and a
  // clinic visit. When the content itself carries the identity, it outranks the
  // label the classifier happened to assign.
  if (overlap.ratio >= CONTENT_IS_IDENTITY && overlap.shared >= 3) return true;

  // Short of that, the classes must positively agree. Inside one document a
  // bill may merge with the note it bills for; across documents the same
  // latitude would fold a charge into an unrelated encounter.
  if (compareClass(a.klass, b.klass) !== "SAME") return false;

  // A shared record identifier is proof on its own — an accession number names
  // one study wherever the report is filed.
  if (decision.verdict === "MERGE") return true;

  // One named clinician, one day, one kind of record, and nothing in either
  // contradicting the other. Two productions of the same emergency visit
  // reached the timeline twice — "ENGLISH, PAUL W" in the hospital's records
  // and "Paul English, MD" in the therapy practice's — because each described
  // the visit in its own words and word-overlap alone never reached the bar.
  // Authorship carries the identity that the wording does not.
  //
  // It is not sufficient on its own: one surgeon writes both the operative
  // report and the discharge summary on the day he operates, and the published
  // plan lists those separately. So the content must still agree substantially,
  // just not near-identically.
  if (sameNamedAuthor(a, b) && overlap.ratio >= SAME_AUTHOR_OVERLAP && overlap.shared >= 2) return true;

  // Otherwise the copies must agree on nearly all of their DISTINCTIVE content.
  return overlap.ratio >= CROSS_DOCUMENT_OVERLAP && overlap.shared >= 2;
}

/**
 * Overlap at which content alone establishes identity, whatever the classifier
 * called each copy. Higher than the ordinary cross-document bar, and requiring
 * more shared facts, because it is overruling a signal rather than joining it.
 */
export const CONTENT_IS_IDENTITY = 0.85;

/**
 * How much of a copy's distinctive content must match to call it the same
 * record filed twice.
 *
 * Deliberately near-total. An earlier version merged on 60% of the smaller
 * entry's claims overlapping, counted over EVERY claim including boilerplate —
 * and two unrelated notes from one chart share their medication list, their
 * allergies and their standing diagnoses before they share anything real.
 */
export const CROSS_DOCUMENT_OVERLAP = 0.8;

/**
 * How much two entries by the SAME named clinician must still share.
 *
 * Lower than the anonymous bar because the author is already strong evidence,
 * high enough that one clinician's operative report and discharge summary on
 * the day he operates stay the two records the published plan lists.
 */
export const SAME_AUTHOR_OVERLAP = 0.5;

/** Identity facts for a merged entry, for cross-document comparison. */
function identityFactsOfEntry(entry: MergedEntry): IdentityFacts {
  const text = entry.claims.map((c) => `${c.value} ${c.excerpt}`).join("\n");
  return {
    id: entry.rowIds[0] ?? entry.sourceDocumentId,
    sourceDocumentId: entry.sourceDocumentId,
    klass: entry.klass,
    dateIso: entry.encounterDate ? entry.encounterDate.toISOString().slice(0, 10) : null,
    dateDocumented: true,
    provider: entry.provider,
    facility: entry.facility,
    time: timeFromText(text),
    // Spans and segments are document-local, so they say nothing about a copy
    // in another document; withholding them is honest rather than unhelpful.
    segmentKey: null,
    span: null,
    claims: entry.claims.map((c) => ({ field: c.field, value: c.value })),
  };
}

/**
 * Fold one copy into another without losing anything.
 *
 * Claims are UNIONED, not replaced. An earlier version assigned the richer
 * copy's fields wholesale over the twin, which silently discarded every claim
 * the other copy stated alone — including any that disagreed. A disagreement
 * between two copies of a record is information a reviewer needs, not noise to
 * resolve by picking the longer list.
 */
function absorbCopy(twin: MergedEntry, other: MergedEntry): void {
  for (const claim of other.claims) {
    const at = twin.claims.findIndex((e) => e.field === claim.field && isDuplicateClaim(claim, [e]));
    if (at >= 0) {
      // Keep whichever states the fact more fully, with its own excerpt and
      // page — a claim never inherits another claim's citation.
      if (claim.value.length > twin.claims[at].value.length) {
        twin.claims[at] = { ...claim, id: twin.claims[at].id };
      }
      continue;
    }
    twin.claims.push({ ...claim, id: `x${twin.claims.length + 1}` });
  }
  twin.rowIds = [...new Set([...twin.rowIds, ...other.rowIds])];
  twin.provider = twin.provider ?? other.provider;
  twin.facility = twin.facility ?? other.facility;
  twin.pageStart = twin.pageStart ?? other.pageStart;
  twin.pageEnd = twin.pageEnd ?? other.pageEnd;
  twin.mergedClasses = [...new Set([...twin.mergedClasses, ...other.mergedClasses])];
  twin.alsoInDocumentIds = [
    ...new Set([...(twin.alsoInDocumentIds ?? []), ...(other.alsoInDocumentIds ?? []), other.sourceDocumentId]),
  ].sort();
  // Each copy keeps its own pages, rows and provider evidence — the reason a
  // duplicate's citation can point at its own document rather than the primary.
  twin.appearances = mergeAppearances(twin, other);
}


/** This entry as an appearance in its own document. */
export function appearanceOf(entry: MergedEntry): RecordAppearance {
  // Value-only ON PURPOSE: this hash decides whether two documents carry
  // copies of the same record, and copies legitimately differ in excerpt and
  // page. Anything asking "did what this entry STATES change?" wants
  // citationFingerprintOf instead.
  const text = entry.claims.map((c) => `${c.field}:${c.value}`).sort().join("\n");
  return {
    documentId: entry.sourceDocumentId,
    pageStart: entry.pageStart,
    pageEnd: entry.pageEnd,
    rowIds: entry.rowIds,
    provider: entry.provider,
    contentHash: createHash("sha256").update(text).digest("hex").slice(0, 32),
  };
}

/**
 * A fingerprint of everything an entry tells a reader — values AND citations.
 *
 * The staleness check on a reviewed chronology event asks a different question
 * than duplicate identity: not "is this the same record?" but "did anything
 * this event states change?" — and a corrected excerpt, page or source is a
 * change a reviewer signed off without seeing. Reusing the identity hash for
 * both quietly kept reviewed events current through citation corrections.
 */
export function citationFingerprintOf(entry: MergedEntry): string {
  const claims = entry.claims
    .map((c) => [c.field, c.value, c.excerpt ?? "", c.page ?? "", c.claimType ?? ""].join("\u0000"))
    .sort()
    .join("\n");
  const source = [entry.sourceDocumentId, entry.pageStart ?? "", entry.pageEnd ?? ""].join("|");
  return createHash("sha256").update(`${source}\n${claims}`).digest("hex").slice(0, 32);
}

/** Union of both sides' appearances, one per document, page ranges widened. */
export function mergeAppearances(a: MergedEntry, b: MergedEntry): RecordAppearance[] {
  const all = [...(a.appearances ?? [appearanceOf(a)]), ...(b.appearances ?? [appearanceOf(b)])];
  const byDocument = new Map<string, RecordAppearance>();
  for (const appearance of all) {
    const held = byDocument.get(appearance.documentId);
    if (!held) {
      byDocument.set(appearance.documentId, appearance);
      continue;
    }
    const pages = [held.pageStart, held.pageEnd, appearance.pageStart, appearance.pageEnd].filter(
      (n): n is number => typeof n === "number" && n > 0,
    );
    byDocument.set(appearance.documentId, {
      ...held,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      rowIds: [...new Set([...held.rowIds, ...appearance.rowIds])],
      provider: held.provider ?? appearance.provider,
    });
  }
  return [...byDocument.values()];
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

/**
 * What identity is decided from, for one extracted row.
 *
 * Time is read out of the row's own claims, because the extraction schema has
 * no time field: a note stating "seen at 2:15 pm" carries that in the text of a
 * claim, and it is exactly the signal that separates two visits to the same
 * clinician on one day.
 */
export function identityFactsOf(row: MergeableRow, span: RowSpan | null): IdentityFacts {
  const text = row.claims.map((c) => `${c.value} ${c.excerpt}`).join("\n");
  return {
    id: row.id,
    sourceDocumentId: row.sourceDocumentId,
    klass: row.analysisClass,
    dateIso: row.encounterDate ? row.encounterDate.toISOString().slice(0, 10) : null,
    dateDocumented: row.dateStatus === "DOCUMENTED",
    provider: cleanProvider(row.provider),
    facility: cleanFacilityName(row.facility),
    time: timeFromText(text),
    segmentKey: row.segmentKey ?? null,
    span: span ? { start: span.start, end: span.end } : null,
    claims: row.claims.map((c) => ({ field: c.field, value: c.value })),
  };
}

/** Group by document and date — retained for callers with no document text. */
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
  // Identity, not the calendar. Grouping on document plus date merged every
  // encounter a combined records production happened to record on one day —
  // the therapy session, the imaging study, the follow-up and the billing for
  // all of them — into a single entry.
  const spanByRow = new Map<string, RowSpan | null>();
  for (const row of rows) spanByRow.set(row.id, doc ? spanOf(doc, row) : null);

  const identified = groupByIdentity(rows, (row) => identityFactsOf(row, spanByRow.get(row.id) ?? null));
  const groups: { rows: MergeableRow[]; span: RowSpan | null; possibleDuplicateOf: string[] }[] = identified.map((g) => ({
    rows: g.members,
    span: doc ? spanOfGroup(doc, g.members) : null,
    possibleDuplicateOf: g.possibleDuplicateOf,
  }));

  const out: MergedEntry[] = [];
  for (const { rows: wholeGroup, span, possibleDuplicateOf } of groups) {
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
      possibleDuplicateOf,
      span,
    });
   }
  }

  return out.sort((a, b) => (a.encounterDate?.getTime() ?? 0) - (b.encounterDate?.getTime() ?? 0));
}

// ── The signed note as the unit of a record ──────────────────────────────────

/** Credentials and roles that are not part of a person's name. */
const CREDENTIAL_WORD =
  /^(?:m\.?d\.?|d\.?o\.?|r\.?n\.?|l\.?v\.?n\.?|l\.?p\.?n\.?|p\.?t\.?|o\.?t\.?|d\.?c\.?|n\.?p\.?|p\.?a\.?(?:-c)?|c\.?r\.?n\.?a\.?|d\.?p\.?m\.?|ph\.?d\.?|psy\.?d\.?|f\.?a\.?c\.?s\.?|jr|sr|ii|iii|iv)$/i;

const TITLE_WORD = /^(?:dr|doctor|mr|mrs|ms|miss|prof|professor)$/i;

/**
 * An organisation, not a person.
 *
 * "Chopra Imaging Centers, Inc" and "Dynamic Anesthesia Providers PLLC" arrive
 * in the provider field alongside real authors. Keyed as people they became
 * "INC" and "PLLC", which would file two unrelated companies under one author.
 * They still key — a facility's records do belong together — but in a namespace
 * of their own, so an organisation can never merge with a physician.
 */
const ORGANISATION =
  /\b(?:inc|llc|pllc|l\.?l\.?c|corp|corporation|company|co|ltd|group|associates|assoc|partners|providers|centers?|centres?|clinics?|hospitals?|health(?:care)?|imaging|radiology|laborator(?:y|ies)|labs?|pharmacy|services|systems?|institute|practice|pa|p\.?a\.?)\b/i;

/**
 * One person, however their name was printed.
 *
 * A hospital chart names the same surgeon as "FERNANDO TECHY, MD", "Fernando
 * Techy, MD", "DR F. TECHY" and "FERNANDO TECHY" on four consecutive pages. Each
 * spelling started its own record, so one operation appeared four times on the
 * timeline. The key is surname plus first initial: enough to tell two authors
 * apart on one admission, coarse enough to survive the way charts print names.
 *
 * Returns null when the string does not name a person — an empty key would make
 * every unattributed row match every other one.
 */
export function providerKey(raw: string | null | undefined): string | null {
  let s = cleanProvider(raw);
  if (!s) return null;

  // A role annotation carries its own punctuation — "(admitting/surgeon)" — so
  // it has to go before the string is split on the separators between people,
  // or the slash inside it cuts the name in half.
  s = s.replace(/\([^)]*\)/g, " ").replace(/\([^)]*$/, " ");

  // "Fernando Techy, MD; Esteban Berberian, MD" lists the team. The author is
  // named first, and taking the first consistently makes the key reproducible.
  s = s.split(/[;/]|\s+and\s+/i)[0].trim();

  if (ORGANISATION.test(s)) {
    const name = s.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
    return name.length >= 3 ? `ORG|${name}` : null;
  }

  // Whether a comma separates the surname is decided BEFORE credentials are
  // dropped, on the words as printed. Testing the stripped string meant a
  // credential the stripper did not know became the given name: "Michael Crone,
  // DC" read as surname Michael, and every "First Last, CRED" whose credential
  // was not in that one list came out reversed.
  const printed = s
    .split(/\s+/)
    .map((w) => ({ word: w.replace(/[.,;]+$/, "").trim(), comma: /[,;]$/.test(w.trim()) }))
    .filter((w) => w.word.length > 0);

  const kept = printed.filter((w) => !CREDENTIAL_WORD.test(w.word) && !TITLE_WORD.test(w.word));
  let parts = kept.map((w) => w.word);

  // "Techy, Fernando" and "ENGLISH, PAUL W" — the surname printed first, with
  // or without the middle initial an emergency department adds.
  const surnameFirst = kept.length >= 2 && kept[0].comma;
  // "English Paul W" — a trailing lone initial marks the same listing as surely
  // as a comma does.
  const trailingInitial = parts.length >= 3 && parts[parts.length - 1].length === 1;
  if ((surnameFirst || trailingInitial) && parts.length >= 2) parts = [...parts.slice(1), parts[0]];

  const named = parts.filter((w) => /[A-Za-z]{2,}/.test(w));
  if (!named.length) return null;

  const surname = named[named.length - 1].toUpperCase();
  if (surname.length < 2) return null;
  // "DR F. TECHY" gives its initial as a bare letter, which the name filter
  // drops. Reading it back is what lets that spelling meet "Fernando Techy"
  // instead of keying as an author whose given name is unknown.
  const first = named.length > 1 ? named[0] : parts.find((w) => /^[A-Za-z]$/.test(w));
  const initial = first && first !== surname ? first[0].toUpperCase() : "";
  return `${surname}|${initial}`;
}

/**
 * The same author, once OCR has had its way with the name.
 *
 * A scanned chart yielded "Techy. Femando" — the comma of a surname-first
 * listing read as a full stop, the given name misread — and "DR. FTECHY", with
 * the title run into the surname. Each became an author of its own, so one
 * operation appeared three times on the timeline under three surgeons who were
 * all the same man.
 *
 * Both rules are confined to a single document and date, which is what makes
 * them safe: within one admission the candidates are a handful of named people,
 * not the whole case.
 */
function sameAuthorAllowingOcr(a: string, b: string): boolean {
  if (sameAuthor(a, b)) return true;
  if (a.startsWith("ORG|") || b.startsWith("ORG|")) return false;

  // "Techy. Femando" keys as FEMANDO|T; read the other way round it is TECHY|F.
  const [surnameA, initialA] = a.split("|");
  const [surnameB, initialB] = b.split("|");
  if (initialA && surnameB.startsWith(initialA) && surnameA.startsWith(initialB || surnameA[0])) {
    if (sameAuthor(`${surnameB}|${surnameA[0]}`, b)) return true;
  }

  // "FTECHY" against "TECHY". Long surnames only: at four characters an edit
  // apart is as likely to be two people as one.
  if (surnameA.length >= 5 && surnameB.length >= 5 && withinOneEdit(surnameA, surnameB)) {
    return !initialA || !initialB || initialA === initialB;
  }
  return false;
}

/** Are these one insertion, deletion or substitution apart? */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (shorter.length === longer.length) i++;
    j++;
  }
  return true;
}

/** Do two author keys name the same person, treating an absent initial as unknown? */
function sameAuthor(a: string, b: string): boolean {
  // An organisation matches only itself; it never absorbs a person.
  if (a.startsWith("ORG|") || b.startsWith("ORG|")) return a === b;
  const [surnameA, initialA] = a.split("|");
  const [surnameB, initialB] = b.split("|");
  if (surnameA !== surnameB) return false;
  return !initialA || !initialB || initialA === initialB;
}

/** How far an unattributed fragment may sit from the note that names its author. */
export const NOTE_REACH = 12_000;

/**
 * Fold a document's entries into the notes that were actually signed.
 *
 * The published plan lists seven entries for a surgical admission — the H&P, the
 * anesthesia record, the operative report, two nursing notes, the therapy
 * evaluation and the discharge summary — each identified by its author and a
 * short page range. The program produced 156 for the same day, because
 * extraction chunks a 284-page chart into fragments and nothing put the
 * fragments back into the note they came from.
 *
 * Authorship is what does it. A chart names the author once, in the note
 * header, and the following pages do not repeat it, so a fragment with no
 * provider belongs to the nearest note that has one. Grouping is confined to a
 * single document and a single date: a date alone still merges nothing.
 */
export interface ConsolidateOptions {
  /**
   * The notes the document is made of, read from its own structure.
   *
   * Used to name the author of a fragment that carries none — a chart signs a
   * note once and the pages under it do not repeat the name. It deliberately
   * does NOT group: bucketing by detected note was measured and made things
   * worse, putting 69 entries on a surgery date that folding by author puts at
   * 14, because headers in a 1.3MB chart are far too sparse to bound a note
   * reliably and one author's work then lands in several of them, unable to
   * rejoin. Attribution is what the document's structure is good for.
   */
  documentNotes?: readonly DocumentNote[];
  /**
   * The person the records are about.
   *
   * A chart header prints the patient's name beside the author's, and the
   * extractor sometimes reads the wrong one — "MCMENRY, DERRICK" arrived as the
   * provider on an admission evaluation. A patient is never the author of their
   * own note, and letting them key as one collects unrelated records from every
   * clinician who saw them into a single fictitious author.
   */
  patientName?: string | null;
}

export function consolidateIntoNotes(
  entries: readonly MergedEntry[],
  options: ConsolidateOptions = {},
): MergedEntry[] {
  const patient = providerKey(options.patientName);
  const structure = options.documentNotes ?? [];
  const buckets = new Map<string, MergedEntry[]>();

  for (const raw of entries) {
    // The note this fragment sits inside names its author, where the fragment
    // itself does not.
    const printed = raw.span && structure.length ? noteAt(structure, raw.span.start) : null;
    const e =
      printed?.author && !providerKey(raw.provider) ? { ...raw, provider: printed.author } : raw;

    const key = `${e.sourceDocumentId}|${e.encounterDate?.toISOString().slice(0, 10) ?? "undated"}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }

  const out: MergedEntry[] = [];
  for (const bucket of buckets.values()) {
    // Each appearance keeps its own span. Merging them into one envelope let a
    // surgeon named on page 5 and again on page 200 claim a span covering
    // everything in between, and every loose fragment in that range attached to
    // him — one note reached 1,654 claims, which is a chart, not a note.
    const notes: { key: string; members: MergedEntry[]; spans: RowSpan[]; noteStart: string | null }[] = [];
    const orphans: MergedEntry[] = [];

    // The KIND of detected note a fragment sits strictly inside, where one
    // does. A surgeon writes an operative report and a discharge summary on the
    // day he operates, and the published plan lists them separately —
    // authorship alone must not fold them back into one.
    //
    // The scope is the note's title, not its offset. Scoping by offset was
    // measured first and re-fragmented the admission it was meant to organise:
    // a hospital chart prints dozens of generic headers, and one author's
    // fragments scattered across several "Progress Note" instances split back
    // into the per-page entries this module exists to fold — 14 entries on the
    // surgery date became 39. The published plan's own shape says the
    // distinction a planner draws is by KIND: the operative report and the
    // discharge summary are two entries; the same author's routine fragments
    // under repeated generic headers are one.
    //
    // Containment must be strict: a fragment that runs past the note's end is
    // not proven to belong to it, and scoping by a boundary it crosses would be
    // scoping by evidence it contradicts.
    const containedIn = (e: MergedEntry): string | null => {
      if (!e.span || !structure.length) return null;
      const at = noteAt(structure, e.span.start);
      return at && e.span.end <= at.end ? (at.title ?? null) : null;
    };

    for (const e of bucket) {
      const key = providerKey(e.provider);
      // An unattributed fragment is honest; one attributed to the patient is
      // not, so it is treated as carrying no author at all.
      if (!key || (patient && sameAuthorAllowingOcr(key, patient))) {
        orphans.push(e);
        continue;
      }
      const existing = notes.find((n) => sameAuthorAllowingOcr(n.key, key));
      if (existing) {
        existing.members.push(e);
        if (e.span) existing.spans.push(e.span);
        // A fuller name supersedes an initial-only one: "TECHY|" becomes
        // "TECHY|F" so a later "Techy, Fernando" still lands here.
        if (existing.key.endsWith("|") && !key.endsWith("|")) existing.key = key;
      } else {
        notes.push({ key, members: [e], spans: e.span ? [e.span] : [], noteStart: null });
      }
    }

    // One author, two KINDS of detected note: two records — but only when the
    // boundary evidence covers everything the author wrote in this bucket.
    // Splitting on partial containment was measured and severed whichever
    // fragments happened to sit inside a detected header from the rest of the
    // same work: one surgeon became five entries on the day he operated, split
    // not into his operative report and his discharge summary but into
    // arbitrary scraps. An author with unscoped fragments is an author whose
    // boundaries the detection did not capture, and evidence that incomplete
    // does not get to divide their record.
    for (let i = notes.length - 1; i >= 0; i--) {
      const group = notes[i];
      const scopes = group.members.map(containedIn);
      if (scopes.some((scope) => scope === null)) continue;
      const kinds = new Set(scopes);
      if (kinds.size < 2) continue;
      const replacements = [...kinds].map((kind) => {
        const members = group.members.filter((_, at) => scopes[at] === kind);
        return {
          key: group.key,
          members,
          spans: members.flatMap((m) => (m.span ? [m.span] : [])),
          noteStart: kind,
        };
      });
      notes.splice(i, 1, ...replacements);
    }

    // Nothing in this bucket names an author, so there is no note to attach to
    // and nothing is known that was not known before.
    if (!notes.length) {
      out.push(...foldIdenticalCopies(bucket));
      continue;
    }

    // Capping how much a note may absorb was measured and rejected: it left the
    // overflow standing as separate entries, which put the surgery date back to
    // 107 events without making any of them more accurate. Reach was measured
    // too — 2,500 characters and 12,000 give the same grouping, because the
    // fragments sit immediately beside the surgeon's signature rather than
    // merely near it. Neither is the binding constraint, so neither is tuned.
    const stranded: MergedEntry[] = [];
    for (const orphan of orphans) {
      const home = nearestNote(notes, orphan.span ?? null);
      if (home) home.note.members.push(orphan);
      else stranded.push(orphan);
    }

    // Folded across the bucket's WHOLE output, not just the strays. Four
    // duplicate pairs survived because each copy attached to a DIFFERENT named
    // note, so the two never met: notes were emitted straight out and only the
    // orphans were compared with one another. Two entries carrying the same
    // words on the same date in the same document are one record whichever
    // notes they happened to attach to.
    const composed = notes.map((note) => (note.members.length === 1 ? note.members[0] : foldNote(note.members)));
    out.push(...foldIdenticalCopies([...composed, ...stranded]));
  }

  return out.sort((a, b) => (a.encounterDate?.getTime() ?? 0) - (b.encounterDate?.getTime() ?? 0));
}

/**
 * Fold entries that are the same record said twice.
 *
 * One emergency visit produced four chronology events with byte-identical
 * summaries, no author, the same facility and the same document. Nothing folded
 * them: grouping is by author, and an entry naming nobody can only attach to a
 * note that names someone — so a bucket naming nobody passed straight through,
 * however many copies of one record it held.
 *
 * Identical content in one document on one date is not two records. The bar is
 * deliberately high — near-total claim overlap, not similarity — because two
 * therapy sessions in a week genuinely read alike, and merging those would lose
 * a visit rather than a duplicate.
 */
function foldIdenticalCopies(entries: MergedEntry[]): MergedEntry[] {
  const groups: MergedEntry[][] = [];
  for (const entry of entries) {
    const twin = groups.find((group) => isSameContent(group[0], entry, { requireDistinctive: false }));
    if (twin) twin.push(entry);
    else groups.push([entry]);
  }
  return groups.map((group) => (group.length === 1 ? group[0] : foldNote(group)));
}

/**
 * Do these two say the same thing, claim for claim?
 *
 * Across documents, boilerplate is excluded first: two unrelated records that
 * both note "no known drug allergies" and "vital signs stable" agree completely
 * on their furniture and on nothing else, and folding those loses a record.
 *
 * Within one document and one date the bar is the raw text, because the risk is
 * not the same. Those entries are already known to be fragments of one day of
 * one production, and requiring distinctiveness there cost seven legitimate
 * folds — records whose only claim was too short to qualify.
 */
function isSameContent(a: MergedEntry, b: MergedEntry, opts: { requireDistinctive: boolean }): boolean {
  if (!a.claims.length || !b.claims.length) return false;
  // Different days are different records even when the words match.
  if ((a.encounterDate?.getTime() ?? null) !== (b.encounterDate?.getTime() ?? null)) return false;

  const values = (entry: MergedEntry) =>
    new Set(
      entry.claims
        .filter((c) => !opts.requireDistinctive || isDistinctive(c))
        .map((c) => norm(c.value))
        .filter(Boolean),
    );
  const va = values(a);
  const vb = values(b);
  // Nothing distinctive on either side means the two agree only on their
  // furniture, which is no evidence at all.
  if (!va.size || !vb.size) return false;

  let shared = 0;
  for (const value of va) if (vb.has(value)) shared++;
  return shared / Math.max(va.size, vb.size) >= CONTENT_IS_IDENTITY;
}

/** Do both entries name the same clinician — not merely fail to disagree? */
export function sameNamedAuthor(a: MergedEntry, b: MergedEntry): boolean {
  const ka = providerKey(a.provider);
  const kb = providerKey(b.provider);
  // An organisation is a filing cabinet, not an author; two of its records are
  // not one record because the cabinet matches.
  if (!ka || !kb || ka.startsWith("ORG|") || kb.startsWith("ORG|")) return false;
  return sameAuthorAllowingOcr(ka, kb);
}

function widen(a: RowSpan | null, b: RowSpan | null): RowSpan | null {
  if (!a) return b;
  if (!b) return a;
  return {
    ...a,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    pageStart: minDefined(a.pageStart, b.pageStart),
    pageEnd: maxDefined(a.pageEnd, b.pageEnd),
  };
}

function minDefined(a: number | null | undefined, b: number | null | undefined): number | null {
  const vals = [a, b].filter((v): v is number => typeof v === "number" && v > 0);
  return vals.length ? Math.min(...vals) : null;
}

function maxDefined(a: number | null | undefined, b: number | null | undefined): number | null {
  const vals = [a, b].filter((v): v is number => typeof v === "number" && v > 0);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * The note a fragment sits inside.
 *
 * A fragment with no span cannot be placed, and guessing would attach a
 * radiology report to whichever surgeon happened to be in the bucket.
 */
function nearestNote(
  notes: { key: string; members: MergedEntry[]; spans: RowSpan[] }[],
  span: RowSpan | null,
): { note: { members: MergedEntry[] }; distance: number } | null {
  if (!span) return null;
  let best: { note: (typeof notes)[number]; distance: number } | null = null;
  for (const note of notes) {
    for (const at of note.spans) {
      // Distance to where the author actually signed, not to the range their
      // appearances happen to bracket.
      const distance =
        span.start <= at.end && at.start <= span.end
          ? 0
          : Math.max(span.start, at.start) - Math.min(span.end, at.end);
      if (distance <= NOTE_REACH && (!best || distance < best.distance)) best = { note, distance };
    }
  }
  return best;
}

/** One note out of the fragments it was chunked into. */
function foldNote(members: MergedEntry[]): MergedEntry {
  const claims: SynthClaim[] = [];
  let n = 0;
  for (const m of members) {
    for (const c of m.claims) {
      if (!c.value?.trim()) continue;
      const at = claims.findIndex((e) => e.field === c.field && isDuplicateClaim(c, [e]));
      if (at >= 0) {
        claims[at] = preferLonger(claims[at], { ...c, id: claims[at].id });
        continue;
      }
      claims.push({ ...c, id: `c${++n}` });
    }
  }

  const pages = members.flatMap((m) => [m.pageStart, m.pageEnd]).filter((p): p is number => typeof p === "number" && p > 0);
  const classes = members.flatMap((m) => (m.mergedClasses.length ? m.mergedClasses : [m.klass]));

  return {
    rowIds: members.flatMap((m) => m.rowIds),
    sourceDocumentId: members[0].sourceDocumentId,
    klass: dominantClass(classes),
    encounterDate: members.find((m) => m.encounterDate)?.encounterDate ?? null,
    provider: members.map((m) => m.provider).find(Boolean) ?? null,
    facility: members.map((m) => m.facility).find(Boolean) ?? null,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
    claims,
    mergedClasses: [...new Set(classes.filter(Boolean))],
    alsoInDocumentIds: [...new Set(members.flatMap((m) => m.alsoInDocumentIds ?? []))].length
      ? [...new Set(members.flatMap((m) => m.alsoInDocumentIds ?? []))]
      : undefined,
    possibleDuplicateOf: [...new Set(members.flatMap((m) => m.possibleDuplicateOf ?? []))],
    span: members.reduce<RowSpan | null>((acc, m) => widen(acc, m.span ?? null), null),
  };
}

// ── What kind of thing an entry is, for display ──────────────────────────────

/**
 * Record furniture: text that documents the paperwork rather than the care.
 *
 * These reached the clinical records list as entries in their own right —
 * "Administrative page footer indicating this is page 3 of 3, revised December
 * 1, 2022" appeared twice — sitting alongside a four-level laminectomy with
 * equal billing. A reviewer opening Details wants the course of care, not the
 * signature blocks that came stapled to it.
 */
const FURNITURE_RE =
  /\b(?:page footer|page header|footer indicating|header indicating|this is page \d+|revision (?:date|history)|form (?:number|revised)|blank page|intentionally left blank|cover (?:sheet|page)|fax (?:cover|transmittal)|records? (?:request|custodian|disclosure|release)|authorization (?:to|for) (?:disclose|release)|notice of privacy|patient rights|assignment of benefits|financial (?:policy|responsibility) (?:form|agreement)|consent (?:form|for treatment|to treat)|signature (?:page|block|on file))\b/i;

export type EntrySubstance = "CLINICAL" | "ANCILLARY" | "ADMINISTRATIVE";

/**
 * Whether this entry documents care, supports it, or is paperwork.
 *
 * Decided from what the rows actually resolved to rather than asserted by the
 * caller: a rebuild that stamped every entry "clinical" put page footers in
 * the clinical list. ANCILLARY covers material that bears on the course of
 * care without documenting it — the bill for a visit, an imaging order —
 * which a reviewer wants reachable but not interleaved with the encounters.
 */
export function entrySubstance(entry: MergedEntry): EntrySubstance {
  const text = entry.claims.map((c) => c.value).join(" ");
  if (entry.claims.length && entry.claims.every((c) => FURNITURE_RE.test(c.value))) return "ADMINISTRATIVE";
  if (FURNITURE_RE.test(text) && entry.claims.length <= 2) return "ADMINISTRATIVE";
  if (NON_CLINICAL_CLASSES.has(entry.klass)) {
    // A billing or correspondence record that nonetheless documents care —
    // a charge for a visit, a letter reporting a finding — is ancillary
    // rather than paperwork, and stays reachable.
    return entry.klass === "UNKNOWN" || entry.klass === "SUPPORTING_FILE" ? "ADMINISTRATIVE" : "ANCILLARY";
  }
  return "CLINICAL";
}

// ── Materiality ──────────────────────────────────────────────────────────────

/**
 * Records that document the paperwork of care rather than the care.
 *
 * A billing statement, an affidavit of reasonableness, a registration page and
 * a consent form are all real records that belong in the file — and none of
 * them is an event in the course of care. On one surgical admission these put
 * "Anesthesia services billing statement showing $20,900.00 owed" and
 * "Documentation confirming medical necessity and reasonableness of charges"
 * on the medical timeline beside the laminectomy.
 */
const NON_EVENT_CONTENT =
  /\b(?:billing statement|statement of account|amount (?:owed|billed|paid)|outstanding (?:charge|balance)|balance due|affidavit|reasonableness of charges|medical necessity and reasonabl|custodian of (?:medical )?(?:billing )?records|business records|charges? (?:for|were) (?:services|necessary)|total (?:billed|charges)|itemized (?:statement|bill)|registration (?:form|page)|face ?sheet|assignment of benefits|notice of privacy|authorization (?:to|for) (?:disclose|release))\b/i;

/**
 * A record that asserts nothing clinical: no finding, no procedure, no
 * assessment, no treatment, no symptom. A visit that yielded only demographics
 * — "Advanced Diagnostics visit for 47-year-old male patient" — documents that
 * paper exists, not that anything happened.
 */
const CLINICAL_ASSERTION_FIELDS = new Set([
  "subjective", "objectiveFindings", "assessment", "treatment", "procedure", "medications",
  "diagnosticStudies", "impression", "operativeFindings", "preOperativeDiagnosis",
  "postOperativeDiagnosis", "responseToTreatment", "functionalStatus", "restrictions",
  "disposition", "complications", "anesthesia", "pathologicDiagnosis", "mechanism",
]);

/**
 * Routine documentation generated *inside* an episode of care.
 *
 * An inpatient stay produces a nursing note every shift, a vitals row every few
 * hours, a medication administration record for every dose and a monitoring
 * entry for every hour in recovery. Each is a genuine record. None is an event
 * in the course of care: a planner writes the admission, the operation and the
 * discharge, not the 3 a.m. blood pressure.
 *
 * On one surgical admission this was the difference between 132 timeline events
 * and the handful a reviewer needs. The records stay in the file and stay
 * openable; they are simply not events.
 */
const INTRA_EPISODE_ROUTINE =
  /\b(?:vital signs?|vitals\b|blood pressure|temperature|pulse ox|oxygen saturation|intake and output|i ?& ?o\b|flow ?sheet|medication administration|administration record|\bmar\b|dose administered|scheduled medications?|prn medications?|nursing (?:note|observation|assessment|documentation|round)|shift (?:note|assessment|change)|hourly rounding|braden|morse fall|fall risk (?:score|assessment)|pain (?:score|scale) (?:of|documented)|post ?-?anesthesia care|pacu (?:monitoring|observation)|recovery room monitoring|telemetry|continuous monitoring|daily progress note|routine (?:observation|monitoring))\b/i;

/**
 * Content that marks a record as pivotal whatever else it contains — the events
 * a chronology exists to carry. A discharge summary mentioning vital signs is
 * still a discharge.
 */
const PIVOTAL_CONTENT =
  /\b(?:operative report|procedure performed|laminectomy|discectomy|foraminotomy|arthroplasty|fusion performed|injection performed|surgery performed|admitted|admission (?:diagnosis|for)|discharge(?:d)? (?:home|to|summary|instructions)|consultation|consult(?:ed)? (?:by|with)|impression|final diagnosis|mri|ct scan|radiograph|x-?ray|emergency department|initial evaluation|new (?:diagnosis|finding)|complication|readmission)\b/i;

export interface MaterialityVerdict {
  material: boolean;
  reason: string;
}

/**
 * Does this entry belong on the medical chronology?
 *
 * The chronology is what a reviewer reads to reconstruct the course of care,
 * and the application already promises "pivotal events — those bearing on the
 * diagnoses and future care". Nothing was enforcing that: a surgical admission
 * produced 141 timeline events, most of them the paperwork the admission
 * generated rather than the care it delivered.
 *
 * Immaterial records are NOT discarded — they stay in the records list, where a
 * reviewer can open them. They are kept off the timeline.
 */
/**
 * A lone measurement, standing as an entire record.
 *
 * "Height documented at 5'4"." reached the timeline as an event in its own
 * right, dated to the morning of a four-level laminectomy. A biometric is
 * something a record contains, not something that happened to the patient, and
 * on its own it says nothing about the course of care.
 */
const MEASUREMENT_ONLY =
  /^(?:\W*(?:patient|pt)\b\W*)?(?:height|weight|body mass index|bmi|body surface area|bsa)\b[^.]*\.?$/i;

export function chronologyMateriality(entry: MergedEntry): MaterialityVerdict {
  const text = entry.claims.map((c) => c.value).join(" ");
  if (!entry.claims.length) return { material: false, reason: "NO_CONTENT" };

  // One claim, and that claim a biometric: there is no event here to place.
  if (entry.claims.length === 1 && MEASUREMENT_ONLY.test(entry.claims[0].value.trim())) {
    return { material: false, reason: "MEASUREMENT_ONLY" };
  }

  const clinical = entry.claims.filter((c) => CLINICAL_ASSERTION_FIELDS.has(c.field));
  if (!clinical.length) return { material: false, reason: "NO_CLINICAL_ASSERTION" };

  // A pivotal record is pivotal whatever routine detail it also carries.
  if (PIVOTAL_CONTENT.test(text)) return { material: true, reason: "PIVOTAL_EVENT" };

  // Routine documentation generated inside an episode of care is record-keeping
  // rather than an event: the planner writes the admission, the operation and
  // the discharge, not the 3 a.m. blood pressure.
  const routine = entry.claims.filter((c) => INTRA_EPISODE_ROUTINE.test(c.value)).length;
  if (routine / entry.claims.length >= 0.5) return { material: false, reason: "INTRA_EPISODE_ROUTINE" };

  // Paperwork wins only when the record is MOSTLY paperwork: an operative note
  // that happens to carry its charge is still an operative note.
  const paperwork = entry.claims.filter((c) => NON_EVENT_CONTENT.test(c.value)).length;
  if (paperwork / entry.claims.length >= 0.5) return { material: false, reason: "DOCUMENTS_THE_PAPERWORK" };
  if (NON_EVENT_CONTENT.test(text) && clinical.length <= 1) {
    return { material: false, reason: "PAPERWORK_WITH_INCIDENTAL_CLINICAL_TEXT" };
  }

  return { material: true, reason: "DOCUMENTS_CARE" };
}
