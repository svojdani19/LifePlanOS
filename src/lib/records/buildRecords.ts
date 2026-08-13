// ─────────────────────────────────────────────────────────────────────────────
// Turning a case's extracted claims into what a reviewer reads.
//
// This is the one place records and chronology are built. It exists because
// there were two, and they disagreed: the live upload path segmented a document
// with a regex over its raw text, while a maintenance script built entries from
// extracted claims, resolved their dates, and wrote them up. A case processed
// by upload and the same case rebuilt by hand produced visibly different
// Records pages, and every fix made to one silently missed the other.
//
// So the pipeline lives here and both callers use it:
//
//   rows -> notes -> dates -> substance -> prose -> segments + chronology
//
// Persistence is separate and deliberate. A rebuild composes the entire
// replacement first and writes only if all of it succeeded, because a partial
// write leaves a case half-described in a way nobody can see: the Records page
// looks finished either way. Human work is never overwritten.
// ─────────────────────────────────────────────────────────────────────────────

import { MEDICAL_TIMELINE_CLASSES, type AnalysisClass } from "@/lib/documents/analysisClass";
import { classifySegment } from "@/lib/engine/chronology";
import {
  claimIsSubstantive,
  clinicalSubstanceOf,
  explainInsubstantial,
  INSUFFICIENT_DETAIL,
  type InsubstantialReason,
} from "@/lib/records/clinicalSubstance";
import { resolveDate, isDocumented, type DateBasis, type ResolvedDate, type UnresolvedReason } from "@/lib/records/dateResolution";
import { ACTIVE_ENCOUNTER_WHERE } from "@/lib/records/encounterLifecycle";
import { authoritativeFacts, claimDiscrepancies, type ReviewableRow } from "@/lib/records/humanAuthority";
import { yearProfile, type YearProfile } from "@/lib/records/dateSanity";
import {
  chronologyMateriality,
  classesCompatible,
  consolidateIntoNotes,
  dedupeAcrossDocuments,
  entrySubstance,
  foldAdjudicatedPairs,
  identityFactsOfMergedEntry,
  isSameRecordAcrossDocuments,
  mergeRows,
  pageAttributionUsable,
  providerKey,
  sameNamedAuthor,
  type MergeableRow,
  type MergedEntry,
} from "@/lib/records/entryMerge";
import { adjudicateDuplicates, candidatePairs } from "@/lib/records/duplicateAdjudication";
import { renderEntry, writeEntry } from "@/lib/records/entryWriter";
import { findNotes, noteAt, type DocumentNote } from "@/lib/records/noteStructure";
import { prepareDocument } from "@/lib/records/rowSpans";
import { prepareDocumentText } from "@/lib/records/sectionLedger";

/** Which chronology column a written section belongs in. */
const FIELD_FOR: Record<string, string> = {
  subjective: "subjective",
  exam: "objectiveFindings",
  assessment: "diagnosis",
  plan: "treatment",
  procedure: "procedure",
  medications: "medications",
  functional: "functionalStatus",
  studies: "imagingFindings",
  findings: "imagingFindings",
  impression: "diagnosis",
  response: "treatment",
  technique: "imagingFindings",
  preopDx: "diagnosis",
  postopDx: "diagnosis",
  operativeFindings: "procedure",
};

/** Entries written at once. Each is an independent model call. */
const CONCURRENCY = 4;

/**
 * A record as the Records page shows it.
 *
 * Extends the shape the page already renders rather than replacing it, so the
 * existing Details dropdown keeps working while gaining the provenance a
 * reviewer needs to judge a date.
 */
export interface RecordSegment {
  date: string | null;
  label: string;
  pageStart: number | null;
  pageEnd: number | null;
  kind: "clinical" | "administrative";
  type: string;
  category: string | null;
  bearsOnCare: boolean;
  provider: string | null;
  facility: string | null;
  summary: string;
  full?: string;
  /** The kind of note the document says this is, where it says so. */
  noteTitle?: string | null;
  /** How the date was arrived at, and whether it was read or worked out. */
  dateBasis?: DateBasis;
  dateEvidence?: string | null;
  dateDocumented?: boolean;
  /** Why the record has no date, when it has none. */
  unresolvedReason?: UnresolvedReason;
  /** Why a record is not listed as a clinical encounter, when it is not. */
  insubstantialReason?: InsubstantialReason;
  /** Source rows, so a reviewer can trace an entry back. */
  rowIds?: string[];
  /** Credentials as a reviewer corrected them. */
  providerCredentials?: string | null;
  /** True when a human wrote or approved this entry's content. */
  humanAuthored?: boolean;
  /** The review states behind it, for the audit trail. */
  reviewStates?: string[];
  verifiedContentHash?: string | null;
}

export interface ChronologyDraft {
  caseId: string;
  eventDate: Date;
  eventType: string;
  specialty: string | null;
  recordType: string | null;
  provider: string | null;
  facility: string | null;
  summary: string;
  sourceDocumentId: string;
  sourcePage: number | null;
  reviewStatus: string;
  dateInferred: boolean;
  relevanceScore: number;
  [column: string]: unknown;
}

export interface BuildStats {
  documents: number;
  pages: number;
  rows: number;
  notes: number;
  afterDedupe: number;
  dateBasis: Record<string, number>;
  undatedClinical: number;
  insubstantial: Record<string, number>;
  chronologyEvents: number;
  heldOffTimeline: Record<string, number>;
  fallbacks: number;
  failures: number;
  /** Entries whose wording came from a human rather than the writer. */
  humanAuthored: number;
  /** Entries where the source states something the human summary omits. */
  claimDiscrepancies: number;
  /** Present only when adjudication ran. */
  adjudication?: { candidates: number; asked: number; merged: number; failed: number };
}

export interface BuiltRecords {
  segmentsByDocument: Map<string, RecordSegment[]>;
  chronology: ChronologyDraft[];
  stats: BuildStats;
  /** Notes that could not be written at all, with the error each raised. */
  failures: { rowIds: string[]; error: string }[];
}

/** The rows this build reads. Narrow on purpose, so callers may pass anything. */
export interface RecordSource {
  id: string;
  pageCount: number | null;
  extractedText: string | null;
  /**
   * Rows carry their review state and any human corrections, because a rebuild
   * that reads only the claims regenerates over the top of a physician's work.
   */
  rows: readonly (MergeableRow & ReviewableRow)[];
}

export interface BuildOptions {
  caseId: string;
  patientName?: string | null;
  documents: readonly RecordSource[];
  /** Compose prose. False builds structure only — used by tests and dry runs. */
  write?: boolean;
  /**
   * Ask an adjudicator about the pairs the rules leave undecided.
   *
   * On by default. It can only merge what the rules left apart, and every
   * failure mode keeps records separate, so the risk of leaving it on is a
   * duplicate on screen rather than a lost record. Pass false to skip it —
   * tests and structure-only builds do.
   */
  adjudicateDuplicates?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Build every record and chronology event for a case.
 *
 * Composes the whole result and reports what failed rather than throwing: a
 * caller deciding whether to publish needs to see the failures first.
 */
export async function buildRecords(options: BuildOptions): Promise<BuiltRecords> {
  const { caseId, documents, patientName = null, write = true } = options;
  // Adjudication follows composition: a build that is not writing prose is a
  // structural dry run, and asking a model about it spends tokens on an answer
  // nobody reads.
  const shouldAdjudicate = options.adjudicateDuplicates ?? write;

  const perDocument: MergedEntry[] = [];
  // A note absorbs several rows; the composer needs their review state to know
  // whether a human already wrote this record's summary.
  const rowsById = new Map<string, MergeableRow & ReviewableRow>();
  const citable = new Map<string, boolean>();
  const yearsOf = new Map<string, YearProfile>();
  const textOf = new Map<string, string>();
  const notesOf = new Map<string, DocumentNote[]>();
  let rowCount = 0;
  let pageCount = 0;

  for (const doc of documents) {
    pageCount += doc.pageCount ?? 0;
    if (!doc.rows.length) continue;
    rowCount += doc.rows.length;

    for (const row of doc.rows) rowsById.set(row.id, row);
    const text = doc.extractedText ?? "";
    const structure = findNotes(prepareDocumentText(text));
    yearsOf.set(doc.id, yearProfile(text));
    textOf.set(doc.id, text);
    notesOf.set(doc.id, structure);

    const entries = consolidateIntoNotes(mergeRows(doc.rows, prepareDocument(text)), {
      patientName,
      documentNotes: structure,
    });
    citable.set(doc.id, entries.some((e) => e.pageStart) || pageAttributionUsable(doc.rows, doc.pageCount));
    perDocument.push(...entries);
  }

  const deduped = dedupeAcrossDocuments(perDocument);

  // The rules have now made every call they can. What remains undecided — one
  // clinician, one day, two productions, partial agreement — is put to an
  // adjudicator, which may only join what the rules left apart.
  let notes = deduped;
  let adjudication: BuildStats["adjudication"];
  if (shouldAdjudicate) {
    const pairs = candidatePairs(deduped, {
      sameNamedAuthor,
      namesSomeone: (entry) => providerKey(entry.provider) !== null,
      settledByRules: isSameRecordAcrossDocuments,
      factsOf: identityFactsOfMergedEntry,
      compatibleClass: classesCompatible,
    });
    const result = await adjudicateDuplicates(pairs);
    notes = foldAdjudicatedPairs(deduped, result.merged);
    adjudication = {
      candidates: pairs.length,
      asked: result.asked,
      merged: result.merged.length,
      failed: result.failed,
    };
  }

  const dated = resolveDatesFor(notes, { yearsOf, textOf, notesOf });

  // ── Compose ───────────────────────────────────────────────────────────────
  const segmentsByDocument = new Map<string, RecordSegment[]>();
  const chronology: ChronologyDraft[] = [];
  const failures: { rowIds: string[]; error: string }[] = [];
  const heldOff = new Map<string, number>();
  const insubstantial = new Map<string, number>();
  const basisCount = new Map<string, number>();
  let fallbacks = 0;
  let undatedClinical = 0;
  let humanAuthored = 0;
  const discrepancies = new Map<string, number>();
  let done = 0;

  async function compose(note: MergedEntry) {
    const resolved = dated.get(note) ?? { iso: null, basis: "NONE" as DateBasis, inferred: false };
    const iso = resolved.iso;
    const label = iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "Undated";
    const cite = citable.get(note.sourceDocumentId) ?? false;
    const printed = note.span ? noteAt(notesOf.get(note.sourceDocumentId) ?? [], note.span.start) : null;

    basisCount.set(resolved.basis, (basisCount.get(resolved.basis) ?? 0) + 1);

    // What a human decided outranks what the program would decide again.
    const authored = authoritativeFacts(
      note.rowIds.map((id) => rowsById.get(id)).filter((r): r is MergeableRow & ReviewableRow => Boolean(r)),
    );

    // Does this record document care, or only the paperwork around it?
    const substance = clinicalSubstanceOf(note.claims);
    const structural = entrySubstance(note);
    const clinical = substance.meaningful && structural === "CLINICAL";
    if (!substance.meaningful) {
      insubstantial.set(substance.reason, (insubstantial.get(substance.reason) ?? 0) + 1);
    }

    let summary = substance.meaningful ? "" : explainInsubstantial(substance.reason);
    let full: string | undefined;
    let sections: { key: string; text: string }[] = [];

    if (authored?.summary) {
      // Reused verbatim. Asking the writer for fresh prose here is how a
      // physician's correction disappeared at the next document completion.
      summary = authored.summary;
      humanAuthored++;
      // The source may say something the correction omits. That is a question
      // for a reviewer, not grounds for the program to overrule them.
      const missed = claimDiscrepancies(authored.summary, note.claims);
      if (missed.length) discrepancies.set(note.rowIds[0] ?? "", missed.length);
    } else if (write && substance.meaningful) {
      // A claim in a clinical field that says nothing clinical — the chart
      // header, the ICD text read back as a sentence, the list of studies
      // ordered — is withheld from the writer. Given it, the writer dutifully
      // turns it into prose, and generic prose is what made these entries
      // unreadable. Everything else is kept, including provider and facility
      // claims the writer uses as ambient context.
      const worthWriting = note.claims.filter(
        (c) => claimIsSubstantive(c) || !isClinicalField(c.field),
      );
      const entry = await writeEntry({
        klass: note.klass,
        date: iso ? label : null,
        provider: note.provider,
        facility: note.facility,
        pageStart: cite ? note.pageStart : null,
        pageEnd: cite ? note.pageEnd : null,
        claims: worthWriting.length ? worthWriting : note.claims,
      });
      if (entry.fallback) fallbacks++;
      summary = entry.brief?.trim() || INSUFFICIENT_DETAIL;
      full = renderEntry(entry, { includeGaps: false });
      sections = entry.sections.flatMap((s) => (s.text ? [{ key: s.key, text: s.text }] : []));
    }

    const segment: RecordSegment = {
      date: iso,
      label,
      pageStart: cite ? note.pageStart ?? printed?.pageStart ?? null : printed?.pageStart ?? null,
      pageEnd: cite ? note.pageEnd ?? printed?.pageEnd ?? null : printed?.pageEnd ?? null,
      kind: clinical ? "clinical" : "administrative",
      type: note.klass,
      category: clinical ? null : substance.meaningful ? structural : "Insufficient clinical detail",
      bearsOnCare: clinical || structural === "ANCILLARY",
      provider: authored?.provider ?? note.provider,
      providerCredentials: authored?.providerCredentials ?? null,
      facility: authored?.facility ?? note.facility,
      summary,
      full,
      humanAuthored: Boolean(authored),
      reviewStates: authored?.states,
      verifiedContentHash: authored?.verifiedContentHash ?? null,
      noteTitle: printed?.title ?? null,
      dateBasis: resolved.basis,
      dateEvidence: resolved.evidence ?? null,
      dateDocumented: iso ? isDocumented(resolved.basis) : false,
      unresolvedReason: resolved.unresolvedReason,
      insubstantialReason: substance.meaningful ? undefined : substance.reason,
      rowIds: note.rowIds,
    };
    if (clinical && !iso) undatedClinical++;

    for (const id of [note.sourceDocumentId, ...(note.alsoInDocumentIds ?? [])]) {
      segmentsByDocument.set(id, [...(segmentsByDocument.get(id) ?? []), segment]);
    }

    // The timeline carries the course of care, and only where the date is
    // supported. An undated record stays in the list until a reviewer dates it.
    const material = chronologyMateriality(note);
    if (!material.material) heldOff.set(material.reason, (heldOff.get(material.reason) ?? 0) + 1);

    if (iso && clinical && MEDICAL_TIMELINE_CLASSES.has(note.klass) && material.material) {
      const kind = classifySegment(note.claims.map((c) => `${c.value} ${c.excerpt}`).join("\n"));
      const event: ChronologyDraft = {
        caseId,
        eventDate: new Date(`${iso}T00:00:00Z`),
        eventType: kind.eventType,
        specialty: kind.specialty,
        recordType: kind.recordType,
        provider: note.provider,
        facility: note.facility,
        summary,
        sourceDocumentId: note.sourceDocumentId,
        sourcePage: cite ? note.pageStart : null,
        reviewStatus: "AI_DRAFT",
        dateInferred: resolved.inferred,
        relevanceScore: 50,
      };
      for (const section of sections) {
        const column = FIELD_FOR[section.key];
        if (!column) continue;
        event[column] = event[column] ? `${event[column]} ${section.text}` : section.text;
      }
      chronology.push(event);
    }

    done++;
    options.onProgress?.(done, notes.length);
  }

  for (let i = 0; i < notes.length; i += CONCURRENCY) {
    await Promise.all(
      notes.slice(i, i + CONCURRENCY).map((note) =>
        compose(note).catch((error) => {
          // Collected rather than thrown: the caller decides whether a case with
          // failures may replace one without them.
          failures.push({ rowIds: note.rowIds, error: String(error).slice(0, 200) });
        }),
      ),
    );
  }

  // Source order within a document, then the page's own sort applies at render.
  for (const [id, segments] of segmentsByDocument) {
    segmentsByDocument.set(id, segments);
  }

  return {
    segmentsByDocument,
    chronology,
    failures,
    stats: {
      documents: documents.length,
      pages: pageCount,
      rows: rowCount,
      notes: perDocument.length,
      afterDedupe: notes.length,
      dateBasis: Object.fromEntries(basisCount),
      undatedClinical,
      insubstantial: Object.fromEntries(insubstantial),
      chronologyEvents: chronology.length,
      heldOffTimeline: Object.fromEntries(heldOff),
      fallbacks,
      failures: failures.length,
      humanAuthored,
      claimDiscrepancies: discrepancies.size,
      adjudication,
    },
  };
}

/**
 * Resolve every note's date, in two passes.
 *
 * The records either side of a note can only date it once they are dated
 * themselves, so the first pass uses evidence each note carries on its own and
 * the second offers the neighbours that pass established. An inference is never
 * built on another inference.
 */
export function resolveDatesFor(
  notes: readonly MergedEntry[],
  context: {
    yearsOf: Map<string, YearProfile>;
    textOf: Map<string, string>;
    notesOf: Map<string, DocumentNote[]>;
  },
): Map<MergedEntry, ResolvedDate> {
  const nearbyOf = (note: MergedEntry) => {
    const text = context.textOf.get(note.sourceDocumentId) ?? "";
    return note.span ? text.slice(Math.max(0, note.span.start - 2_000), note.span.end + 2_000) : "";
  };

  // A note's date reaches a fragment only when the fragment's span sits inside
  // that note. Proximity is not containment: an operative report filed after an
  // admission note must not inherit the admission's date.
  const containing = (note: MergedEntry) => {
    if (!note.span) return null;
    const found = noteAt(context.notesOf.get(note.sourceDocumentId) ?? [], note.span.start);
    if (!found) return null;
    if (note.span.end > found.end) return null;
    return { date: found.date, dateBasis: found.dateBasis, dateEvidence: found.dateEvidence };
  };

  const sourcesFor = (note: MergedEntry, before?: string | null, after?: string | null) => ({
    header: note.encounterDate,
    claims: note.claims,
    nearbyText: nearbyOf(note),
    profile: context.yearsOf.get(note.sourceDocumentId) ?? yearProfile(""),
    containingNote: containing(note),
    before,
    after,
  });

  const dated = new Map<MergedEntry, ResolvedDate>();
  for (const note of notes) dated.set(note, resolveDate(sourcesFor(note)));

  const byPosition = [...notes].sort((a, b) => {
    if (a.sourceDocumentId !== b.sourceDocumentId) return a.sourceDocumentId.localeCompare(b.sourceDocumentId);
    return (a.span?.start ?? Number.MAX_SAFE_INTEGER) - (b.span?.start ?? Number.MAX_SAFE_INTEGER);
  });

  for (let i = 0; i < byPosition.length; i++) {
    const note = byPosition[i];
    if (dated.get(note)?.iso || !note.span) continue;

    let before: string | null = null;
    let after: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (byPosition[j].sourceDocumentId !== note.sourceDocumentId) break;
      const iso = dated.get(byPosition[j])?.iso;
      if (iso) {
        before = iso;
        break;
      }
    }
    for (let j = i + 1; j < byPosition.length; j++) {
      if (byPosition[j].sourceDocumentId !== note.sourceDocumentId) break;
      const iso = dated.get(byPosition[j])?.iso;
      if (iso) {
        after = iso;
        break;
      }
    }
    dated.set(note, resolveDate(sourcesFor(note, before, after)));
  }

  return dated;
}

/** Does this field carry clinical assertions, as opposed to context? */
function isClinicalField(field: string): boolean {
  return claimIsSubstantive({ field, value: "a placeholder long enough to pass" });
}

/** Chronological, with same-day notes left in the order the source filed them. */
export function sortForDisplay(segments: readonly RecordSegment[]): RecordSegment[] {
  return [...segments]
    .map((segment, order) => ({ segment, order }))
    .sort((a, b) => {
      const dateA = a.segment.date;
      const dateB = b.segment.date;
      // Unresolved items collect at the bottom rather than interleaving with
      // dated care, which is how they came to look like part of the sequence.
      if (!dateA && !dateB) return a.order - b.order;
      if (!dateA) return 1;
      if (!dateB) return -1;
      if (dateA !== dateB) return dateA < dateB ? -1 : 1;
      return a.order - b.order;
    })
    .map((entry) => entry.segment);
}

export type { AnalysisClass };

// ── Publishing a rebuilt case ────────────────────────────────────────────────

export interface PersistResult {
  published: boolean;
  documentsUpdated: number;
  chronologyInserted: number;
  draftsRemoved: number;
  reviewedKept: number;
  reason?: string;
}

/** The database surface persistence needs. Narrow, so tests can supply a fake. */
export interface RecordStore {
  document: {
    update(args: { where: { id: string }; data: { segments: unknown } }): Promise<unknown>;
  };
  chronologyEvent: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    createMany(args: { data: unknown[] }): Promise<unknown>;
  };
  $transaction<T>(work: (tx: RecordStore) => Promise<T>): Promise<T>;
}

/**
 * Replace a case's records and chronology, or leave them exactly as they were.
 *
 * A partial rebuild is the dangerous outcome here, because a half-described
 * case looks identical to a finished one: the Records page renders whatever it
 * is given without complaint. So a build carrying failures does not publish at
 * all, and the previous result — which at least is whole — survives.
 *
 * Human work is never touched. Only events still marked AI_DRAFT are replaced;
 * anything a reviewer has edited, reviewed, verified or authored is counted and
 * left alone.
 */
export async function persistRecords(
  store: RecordStore,
  caseId: string,
  built: BuiltRecords,
  options: { allowPartial?: boolean } = {},
): Promise<PersistResult> {
  if (built.failures.length && !options.allowPartial) {
    return {
      published: false,
      documentsUpdated: 0,
      chronologyInserted: 0,
      draftsRemoved: 0,
      reviewedKept: 0,
      reason: `${built.failures.length} note(s) could not be composed; the previous result was kept`,
    };
  }

  return store.$transaction(async (tx) => {
    const reviewedKept = await tx.chronologyEvent.count({
      where: { caseId, reviewStatus: { not: "AI_DRAFT" } },
    });

    for (const [documentId, segments] of built.segmentsByDocument) {
      await tx.document.update({ where: { id: documentId }, data: { segments: sortForDisplay(segments) } });
    }

    const removed = await tx.chronologyEvent.deleteMany({ where: { caseId, reviewStatus: "AI_DRAFT" } });
    for (let i = 0; i < built.chronology.length; i += 200) {
      await tx.chronologyEvent.createMany({ data: built.chronology.slice(i, i + 200) });
    }

    return {
      published: true,
      documentsUpdated: built.segmentsByDocument.size,
      chronologyInserted: built.chronology.length,
      draftsRemoved: removed.count,
      reviewedKept,
    };
  });
}

// ── The live path ────────────────────────────────────────────────────────────

/** What loading a case's sources needs from the database. */
export interface RecordLoader {
  case: { findUnique(args: { where: { id: string }; select: { clientName: true } }): Promise<{ clientName: string | null } | null> };
  document: {
    findMany(args: {
      where: { caseId: string };
      select: { id: true; pageCount: true; extractedText: true };
    }): Promise<{ id: string; pageCount: number | null; extractedText: string | null }[]>;
  };
  extractedEncounter: {
    findMany(args: { where: { caseId: string; sourceDocumentId: string }; select: unknown }): Promise<unknown[]>;
  };
}

const ROW_SELECT = {
  id: true,
  sourceDocumentId: true,
  analysisClass: true,
  encounterDate: true,
  dateStatus: true,
  segmentKey: true,
  provider: true,
  facility: true,
  page: true,
  pageEnd: true,
  substanceClass: true,
  claims: true,
  // Review state and any human corrections. Without these a rebuild cannot
  // tell a physician's summary from one it wrote itself.
  status: true,
  factualSummary: true,
  encounterType: true,
  providerCredentials: true,
  verifiedContentHash: true,
} as const;

/**
 * Rebuild a case's records and chronology from what is currently extracted.
 *
 * Called after an extraction run completes and by the manual rebuild script, so
 * an uploaded case and a rebuilt one are described the same way. It publishes
 * only a complete result, and leaves reviewed work alone.
 */
export async function refreshCaseRecords(
  db: RecordLoader & RecordStore,
  caseId: string,
  options: { write?: boolean } = {},
): Promise<{ built: BuiltRecords; persisted: PersistResult }> {
  const theCase = await db.case.findUnique({ where: { id: caseId }, select: { clientName: true } });
  const documents = await db.document.findMany({
    where: { caseId },
    select: { id: true, pageCount: true, extractedText: true },
  });

  const sources: RecordSource[] = [];
  for (const doc of documents) {
    const rows = (await db.extractedEncounter.findMany({
      // Superseded, rejected and failed rows are history. They stay in the
      // database for audit and out of everything downstream.
      where: { caseId, sourceDocumentId: doc.id, ...ACTIVE_ENCOUNTER_WHERE },
      select: ROW_SELECT,
    })) as unknown as MergeableRow[];
    sources.push({ id: doc.id, pageCount: doc.pageCount, extractedText: doc.extractedText, rows });
  }

  const built = await buildRecords({
    caseId,
    patientName: theCase?.clientName ?? null,
    documents: sources,
    write: options.write ?? true,
  });
  const persisted = await persistRecords(db, caseId, built);
  return { built, persisted };
}
