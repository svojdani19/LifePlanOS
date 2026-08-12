// ─────────────────────────────────────────────────────────────────────────────
// The notes a document is actually made of.
//
// A records production is not a stream of pages. It is a stack of signed notes:
// an H&P, an operative report, a therapy evaluation, a discharge summary, each
// with a header that opens it and a signature that closes it. The published
// plan lists exactly those, which is why its surgical admission runs to seven
// entries where the program produced 156.
//
// Nothing was reading that structure. Extraction chunks a 1.3MB chart on size,
// so a note is split across chunks and a chunk spans two notes, and the author
// — named once in the header and never repeated — survives on whichever
// fragment happened to contain it. 81% of rows came out with no provider at
// all, and four copies of one emergency visit reached the timeline reading
// "Treating provider" because there was nothing to fold them by.
//
// The markers are there to be read. This chart prints 22 History and Physicals,
// 21 progress notes, 18 nursing notes, 4 anaesthesia records, 2 operative
// reports and 35 clinical signatures.
//
// The trap is that it also prints 168 other "signed by" lines, and they are
// notary blocks from the records-custodian affidavit — "KAITLYNN SUE GONZALEZ
// Signed by: Notary ID", "Martha Carrillo AFFIANT". Segmenting on those would
// manufacture notes out of the paperwork that proves the records are genuine,
// and attribute clinical findings to a notary. So an attestation is recognised
// and excluded explicitly rather than filtered by luck.
// ─────────────────────────────────────────────────────────────────────────────

/** Why a note's date is trustworthy. */
export type NoteDateBasis =
  /** A field the note labels as the date of the service it documents. */
  | "SERVICE_LABEL"
  /** An unambiguous date printed in the note's own header. */
  | "NOTE_HEADER";

/** A note as the document presents it. */
export interface DocumentNote {
  start: number;
  end: number;
  /** The kind of note, as its header names it. */
  title: string | null;
  /** Who signed it, in the document's own words. */
  author: string | null;
  /** The marker text the author was read from, for review. */
  evidence: string;
  /** The day this note documents, normalised, where it says so. */
  date: string | null;
  /** How that date was identified. */
  dateBasis: NoteDateBasis | null;
  /** The exact text the date was read from. */
  dateEvidence: string | null;
  /** Pages the note covers, where the document prints them. */
  pageStart: number | null;
  pageEnd: number | null;
}

/**
 * Fields that state the date of the service a note documents.
 *
 * Each of these labels the clinical event itself. A date carrying one of these
 * labels is DOCUMENTED — read off the page, not worked out — which is the
 * distinction the whole review process depends on.
 */
const SERVICE_LABEL =
  /\b(?:date\s+of\s+service|service\s+date|d\.?o\.?s\.?|encounter\s+date|date\s+of\s+encounter|visit\s+date|date\s+of\s+visit|admission\s+date|date\s+of\s+admission|admit(?:ted)?\s+date|procedure\s+date|date\s+of\s+procedure|surgery\s+date|date\s+of\s+surgery|operation\s+date|exam(?:ination)?\s+date|date\s+of\s+exam(?:ination)?|evaluation\s+date|date\s+of\s+evaluation|collect(?:ion|ed)\s+date|date\s+collected|specimen\s+collected|stud(?:y|ies)\s+date|date\s+performed|performed\s+(?:on|date)|exam\s+performed)\b/i;

/**
 * Labels that must never supply a service date.
 *
 * Every one of these is a real date about a real thing — when the chart was
 * printed, when the clinician signed it, when the patient was born — and none
 * of them is when the care happened. Dating a record by one puts an encounter
 * on a day nothing clinical occurred.
 */
const UNSAFE_LABEL =
  /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s?date|age|print(?:ed)?(?:\s+date)?|date\s+printed|scan(?:ned)?|upload(?:ed)?|fax(?:ed)?|received|signed|signature|authenticat\w*|report\s+(?:generated|run)|date\s+report\s+(?:generated|run|printed)|generated\s+(?:on|date)|statement\s+date|billing\s+date|invoice|policy(?:\s+date)?|effective\s+date|expir\w*|due|follow[\s-]?up|f\/u|next\s+(?:visit|appointment)|appointment|scheduled|return|recheck|proposed|planned|as\s+of|transcri(?:bed|ption))\b/i;

const ANY_DATE =
  /\b(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)?\d{2})\b|\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g;

/** How far after a label its date may sit and still belong to it. */
const LABEL_REACH = 40;

/** "Page 12 of 284", so a note can carry the pages it covers. */
const PAGE_MARK = /\bpage\s+(\d{1,4})\s+of\s+\d{1,4}\b/gi;

/**
 * Headers that open a note.
 *
 * "Encounter Summary - Progress Note" is how this EHR prints one; the rest are
 * the standard chart divisions. Matched case-insensitively because a scan
 * renders them in every combination of case it feels like.
 */
const NOTE_HEADER =
  /(?:encounter\s+summary\s*[-–—]?\s*)?\b(progress\s+note|history\s+and\s+physical|operative\s+(?:report|note)|discharge\s+(?:summary|instructions)|consultation(?:\s+report)?|(?:pre-?)?anesthes(?:ia|iology)\s+(?:record|evaluation|assessment)|physical\s+therapy\s+(?:evaluation|eval|assessment|note)|occupational\s+therapy\s+(?:evaluation|note)|nursing\s+(?:note|assessment)|radiology\s+report|pathology\s+report|emergency\s+department\s+(?:record|note|report)|admission\s+(?:note|assessment)|preoperative\s+(?:note|assessment))\b/gi;

// Both capture generously and let personName decide where the name ends. The
// text these run over has had its runs of spaces collapsed, so bounding a name
// by whitespace finds nothing.

/** A clinician putting their name to a note. */
const CLINICAL_SIGNATURE = /\belectronically\s+signed\s+by\s*:?\s*([^\n]{0,60})/gi;

/** A note naming its clinician in a labelled field. */
const ATTRIBUTION =
  /\b(?:attending|operating|admitting|referring|dictating|rendering)?\s*(?:provider|physician|surgeon|clinician|author)\s*:\s*([^\n]{0,60})/gi;

/**
 * The records-custodian affidavit.
 *
 * Business-records attestations are signed and notarised, so they carry every
 * marker a clinical note does and none of the meaning. A window around one of
 * these is not a note.
 */
const ATTESTATION =
  /\b(?:docu-?signed?|notary|affiant|commission\s+expires|sworn\s+to\s+and\s+subscribed|business\s+records?\s+affidavit|custodian\s+of\s+records|exact\s+duplicates?\s+of\s+the\s+original)\b/i;

/** How far either side of a marker an attestation disqualifies it. */
const ATTESTATION_WINDOW = 400;

/** A note shorter than this is a header with nothing under it. */
const MIN_NOTE = 200;

interface Marker {
  at: number;
  end: number;
  kind: "HEADER" | "AUTHOR";
  title: string | null;
  author: string | null;
  evidence: string;
}

/**
 * The notes in a document, in the order they appear.
 *
 * Returns an empty list for a document with no readable structure — a
 * scanned-image packet, a billing ledger — which is the honest answer and
 * leaves the caller's existing behaviour untouched.
 */
export function findNotes(text: string): DocumentNote[] {
  const markers: Marker[] = [];

  for (const m of text.matchAll(NOTE_HEADER)) {
    const at = m.index ?? 0;
    if (nearAttestation(text, at)) continue;
    markers.push({
      at,
      end: at + m[0].length,
      kind: "HEADER",
      title: tidy(m[1]),
      author: null,
      evidence: snippet(text, at, m[0].length),
    });
  }

  for (const [pattern, kind] of [
    [CLINICAL_SIGNATURE, "AUTHOR"],
    [ATTRIBUTION, "AUTHOR"],
  ] as const) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (nearAttestation(text, at)) continue;
      const author = personName(m[1]);
      if (!author) continue;
      markers.push({
        at,
        end: at + m[0].length,
        kind,
        title: null,
        author,
        evidence: snippet(text, at, m[0].length),
      });
    }
  }

  if (!markers.length) return [];
  markers.sort((a, b) => a.at - b.at);

  // A note runs from its header to the next one. Authors found inside it name
  // it; a signature sitting before the first header belongs to nothing, because
  // a note is closed by its signature rather than opened by it.
  const headers = markers.filter((m) => m.kind === "HEADER");
  if (!headers.length) return [];

  const notes: DocumentNote[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].at;
    const end = i + 1 < headers.length ? headers[i + 1].at : text.length;
    if (end - start < MIN_NOTE) continue;

    const inside = markers.filter((m) => m.kind === "AUTHOR" && m.at >= start && m.at < end);
    const body = text.slice(start, end);
    const dated = noteDate(body);
    notes.push({
      start,
      end,
      title: headers[i].title,
      author: inside[0]?.author ?? null,
      evidence: inside[0]?.evidence ?? headers[i].evidence,
      date: dated?.iso ?? null,
      dateBasis: dated?.basis ?? null,
      dateEvidence: dated?.evidence ?? null,
      ...pagesIn(body),
    });
  }
  return notes;
}

/**
 * The day a note says it documents.
 *
 * Read only from a field the note labels as the date of its own service, or
 * from an unambiguous date in its header. A date sitting loose in the body is
 * ignored: a progress note quotes the surgery it follows and schedules the
 * visit it precedes, and neither is the day it was written.
 *
 * Conflicting service labels return nothing. Two labelled dates disagreeing is
 * a question for a reviewer, not something to resolve by picking the first.
 */
export function noteDate(body: string): { iso: string; basis: NoteDateBasis; evidence: string } | null {
  const labelled = new Map<string, string>();
  for (const m of body.matchAll(ANY_DATE)) {
    const at = m.index ?? 0;
    const before = body.slice(Math.max(0, at - LABEL_REACH), at);
    // The nearest label wins, and an unsafe one disqualifies the date outright
    // even when a service label also appears in the window.
    if (UNSAFE_LABEL.test(before)) continue;
    if (!SERVICE_LABEL.test(before)) continue;
    const iso = toIso(m);
    if (iso && !labelled.has(iso)) labelled.set(iso, snippet(body, at, m[0].length));
  }
  if (labelled.size === 1) {
    const [iso, evidence] = [...labelled.entries()][0];
    return { iso, basis: "SERVICE_LABEL", evidence };
  }
  if (labelled.size > 1) return null;

  // Nothing labelled. A single unambiguous date in the note's own header — the
  // first line or so, before any clinical narrative — is the note dating
  // itself. Anything further in is body text and is not read.
  const header = body.slice(0, 300);
  const inHeader = new Map<string, string>();
  for (const m of header.matchAll(ANY_DATE)) {
    const at = m.index ?? 0;
    if (UNSAFE_LABEL.test(header.slice(Math.max(0, at - LABEL_REACH), at))) continue;
    const iso = toIso(m);
    if (iso && !inHeader.has(iso)) inHeader.set(iso, snippet(header, at, m[0].length));
  }
  if (inHeader.size !== 1) return null;
  const [iso, evidence] = [...inHeader.entries()][0];
  return { iso, basis: "NOTE_HEADER", evidence };
}

function toIso(m: RegExpMatchArray): string | null {
  let year: number;
  let month: number;
  let day: number;
  if (m[4]) {
    year = Number(m[4]);
    month = Number(m[5]);
    day = Number(m[6]);
  } else {
    month = Number(m[1]);
    day = Number(m[2]);
    year = Number(m[3]);
    if (year < 100) year += 2000;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.toISOString().slice(0, 10);
}

function pagesIn(body: string): { pageStart: number | null; pageEnd: number | null } {
  const pages: number[] = [];
  for (const m of body.matchAll(PAGE_MARK)) {
    const n = Number(m[1]);
    if (n > 0) pages.push(n);
  }
  return pages.length
    ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) }
    : { pageStart: null, pageEnd: null };
}

/** The note containing an offset, if the document has one there. */
export function noteAt(notes: readonly DocumentNote[], offset: number): DocumentNote | null {
  // Binary search: a long chart carries hundreds of notes and this is asked
  // once per extracted row.
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < notes[mid].start) hi = mid - 1;
    else if (offset >= notes[mid].end) lo = mid + 1;
    else return notes[mid];
  }
  return null;
}

/**
 * A person's name out of the form an EHR exported it in.
 *
 * "TECHY_FERNANDO_MD" is one field of an export, not a name anyone wrote.
 * Returns null for anything that does not name a person, so a fax number or a
 * department never becomes an author.
 */
export function personName(raw: string | null | undefined): string | null {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // An underscored field is this EHR's export of surname, given name and
  // credential: TECHY_FERNANDO_MD.
  const exported = s.includes("_");
  if (exported) s = s.replace(/_+/g, " ").trim();
  const surnameFirst = exported || /^[A-Za-z][A-Za-z'’.-]*\s*,/.test(s);

  // Take the leading run of name-shaped words and stop at the first thing that
  // is not one — a fax number, an address, a column of underscores.
  const words: string[] = [];
  for (const word of s.split(/[\s,]+/)) {
    const bare = word.replace(/[.]+$/, "");
    if (!/^[A-Za-z][A-Za-z'’-]*$/.test(bare)) break;
    if (FIELD_LABEL.test(bare)) break;
    words.push(bare);
    // Given name, middle name or initial, surname, credential. More than that
    // is the scan having run on into whatever the line says next.
    if (words.length >= 4) break;
  }
  if (words.length < 2) return null;

  const credentials = [...words];
  const names: string[] = [];
  while (credentials.length && !CREDENTIAL.test(credentials[0])) names.push(credentials.shift()!);
  if (names.length < 2) return null;

  // "English Paul W" — a trailing lone initial marks a surname-first listing
  // as surely as a comma does.
  const trailingInitial = names.length >= 3 && names[names.length - 1].length === 1;

  const ordered =
    surnameFirst || trailingInitial ? [...names.slice(1), names[0]] : names;

  return titleCase([...ordered, ...credentials]);
}

const CREDENTIAL = /^(?:md|do|rn|lvn|lpn|pt|ot|dc|np|pa|crna|dpm|phd|psyd|facs|jr|sr|ii|iii)$/i;

/**
 * Words that end a name because they begin the next field.
 *
 * A chart line runs fields together — "Provider: GIDWANI, GIRISH M Check in
 * Date: 10/10/2024" — and the colons that separate them do not survive being
 * split on. Without this the scan reads straight on and produces "Girish M
 * Check In Gidwani".
 */
const FIELD_LABEL =
  /^(?:check|date|dates?|fax|phone|tel|telephone|npi|dob|mrn|room|bed|patient|information|admission|discharge|encounter|visit|account|id|sex|age|time|signed|electronically|attending|operating|admitting|referring|status|type|location|unit|facility|address|city|state|zip)$/i;

function titleCase(words: string[]): string {
  return words
    .map((w) => {
      const bare = w.replace(/[.]/g, "");
      // Credentials stay upright: MD, DO, RN, PT, NP, CRNA.
      if (CREDENTIAL.test(bare)) return bare.toUpperCase();
      return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
    })
    .join(" ");
}

function nearAttestation(text: string, at: number): boolean {
  return ATTESTATION.test(text.slice(Math.max(0, at - ATTESTATION_WINDOW), at + ATTESTATION_WINDOW));
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function snippet(text: string, at: number, length: number): string {
  return text
    .slice(Math.max(0, at - 20), at + length + 60)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
