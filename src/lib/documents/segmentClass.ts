// ─────────────────────────────────────────────────────────────────────────────
// Per-SEGMENT analysis classification.
//
// A single uploaded PDF is routinely a consolidated packet: a clinic note, an
// operative report, an imaging read, a billing page and a deposition excerpt,
// all behind one filename and one document type. Classifying the UPLOAD is
// therefore not enough — the operative report inside a packet labelled
// "MEDICAL_RECORD" would still be read as a clinic visit, and the billing page
// inside it would still be mined for clinical facts.
//
// So the text is divided into ranges that each carry ONE analysis class, and
// extraction chunks are aligned to those ranges. Two rules keep this honest:
//
//   • A range is only given a content-derived class when the content
//     classifier is confident. Below its score floor the range is UNKNOWN —
//     an admitted unknown is safer than a confident wrong class, because a
//     wrong class decides what may be extracted AND whether the result reaches
//     the medical timeline.
//   • A deliberate document-type assignment is respected as the packet's
//     default, but it does not make the packet homogeneous: a segment whose
//     own content clearly identifies it wins for that segment.
// ─────────────────────────────────────────────────────────────────────────────

import { segmentDocument } from "@/lib/documents/segment";
import { classifyByContent } from "@/lib/documents/classify";
import {
  analysisClassFor,
  classFromContent,
  MEDICAL_TIMELINE_CLASSES,
  type AnalysisClass,
  type ClassificationMethod,
} from "@/lib/documents/analysisClass";

export interface ClassifiedRange {
  offsetStart: number;
  offsetEnd: number;
  klass: AnalysisClass;
  method: ClassificationMethod;
  /** Classifier score when content-derived; 0 for a document-type assignment. */
  confidence: number;
  /**
   * Stable identity of the sub-document this range came from, so every row
   * extracted from it can be traced back to the same segment.
   */
  segmentKey: string | null;
}

/**
 * A segment the segmenter judged non-clinical may still be NAMED by its
 * content — testimony, billing, a legal filing, an expert report. What it may
 * never do is become clinical care on the strength of a content score, so the
 * medical-timeline kinds are excluded here rather than trusted.
 */
const adminKindAllowed = (klass: AnalysisClass) => !MEDICAL_TIMELINE_CLASSES.has(klass);

/**
 * Kinds that may be promoted to clinical when the text carries a provider's
 * own analysis. Testimony and legal filings are NOT here: a deposition
 * discussing an examination is still testimony, not an examination.
 */
const PROMOTABLE_TO_CLINICAL = new Set<AnalysisClass>([
  "FINANCIAL",
  "INSURANCE_ADMINISTRATIVE",
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
  "SUPPORTING_FILE",
  "UNKNOWN",
]);

/**
 * Telling a bill from a clinical note when a segment contains both.
 *
 * Providers file the visit note and its charge together, so a segment can
 * carry charge columns AND a provider's own analysis. Two wrong answers are
 * available here. Calling it billing discards the history and examination
 * printed beside the charges. Calling it clinical on the strength of a couple
 * of clinical words turns a fee schedule into an encounter — and worse,
 * produces a clinical entry that DUPLICATES the note filed separately in the
 * same packet, so the same visit is counted twice.
 *
 * So a segment is decided as ONE thing, by which kind of content actually
 * dominates it. A bill is treated as a bill; a clinical note is treated as a
 * clinical note; and a page that is mostly charges with a diagnosis label
 * attached stays a bill, because that is what it is.
 */
const CLINICAL_SUBSTANCE_RE =
  /\b(?:chief complaint|history of present illness|\bhpi\b|physical (?:exam|examination)|on examination|review of systems|\bros\b|assessment and plan|\ba\/p\b|impression(?:\s*(?:and|&)\s*plan)?:|assessment:|plan:|operative (?:report|findings)|preoperative diagnosis|postoperative diagnosis|procedure performed|indications for (?:the )?procedure|range of motion|straight leg raise|neurologic(?:al)? exam|palpation reveal|tenderness (?:to|on) palpation|prescrib\w+|discharge instructions|follow[- ]up in)\b/i;

/** Charge columns, codes, amounts and remittance language: billing substance. */
const BILLING_SUBSTANCE_RE =
  /\b(?:cpt|hcpcs|icd-?10 code|revenue code|modifier|units billed|date of service|total charges?|amount (?:billed|paid|allowed)|balance due|patient responsibility|explanation of benefits|\beob\b|adjustment|write-?off|copay|coinsurance|deductible|claim (?:number|status|submitted)|statement of account|remittance|fee schedule|billed to|payer|insurer)\b/i;

/** Distinct markers of one kind of substance in a text. */
function markerCount(text: string, re: RegExp): number {
  const scan = new RegExp(re.source, "gi");
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text))) hits.add(m[0].toLowerCase());
  return hits.size;
}

/**
 * Documents whose IDENTITY is clinical, whatever else is printed on them.
 * An emergency-department record, a discharge summary, a history and physical
 * or a consultation is a clinical encounter — filing it as correspondence
 * because it also carries instructions and demographics loses a real visit
 * from the timeline.
 */
const CLINICAL_DOCUMENT_IDENTITY_RE =
  /\b(?:emergency (?:department|room) (?:record|visit|note|discharge|summary)|\bed\b visit|discharge summary|discharge instructions and diagnosis|history and physical|\bh&p\b|consultation (?:report|note)|progress note|office visit note|admission (?:note|summary)|operative report|hospital course)\b/i;

/** At least this many distinct clinical markers before a segment can be clinical. */
const CLINICAL_PROMOTION_MARKERS = 2;

/**
 * How decisively clinical content must outweigh billing content before a
 * billing-looking segment is read as a clinical note. A margin, not a tie —
 * a page with three charge markers and three clinical words is a bill with a
 * diagnosis on it.
 */
const CLINICAL_DOMINANCE_MARGIN = 2;

/**
 * Does this text carry a provider's own clinical analysis — history, exam,
 * assessment, plan, procedure — rather than only charges for it?
 */
export function carriesClinicalSubstance(text: string): boolean {
  return markerCount(text, CLINICAL_SUBSTANCE_RE) >= CLINICAL_PROMOTION_MARKERS;
}

/**
 * Is this segment a clinical note rather than a bill? True only when clinical
 * substance clearly dominates: enough of it to stand on its own, AND
 * decisively more of it than billing substance. Anything else stays what the
 * classifier called it.
 */
export function readsAsClinicalNote(text: string): boolean {
  // A document that names itself an ED record, a discharge summary or an H&P
  // does not have to argue its way past a marker count. Its identity settles
  // it, provided it carries any clinical substance at all.
  if (CLINICAL_DOCUMENT_IDENTITY_RE.test(text) && markerCount(text, CLINICAL_SUBSTANCE_RE) >= 1) return true;
  const clinical = markerCount(text, CLINICAL_SUBSTANCE_RE);
  if (clinical < CLINICAL_PROMOTION_MARKERS) return false;
  const billing = markerCount(text, BILLING_SUBSTANCE_RE);
  return clinical >= billing + CLINICAL_DOMINANCE_MARGIN;
}

/** Minimum content-classifier score to accept a segment's own class. */
const MIN_SEGMENT_SCORE = 4;

/** Below this length a segment is judged only on STRONG evidence. */
const MIN_SEGMENT_CHARS = 400;

/**
 * Score required to classify a SHORT segment. Real imaging reads, pathology
 * reports and charge pages are routinely a few hundred characters, so a flat
 * length floor would send exactly those back to the packet's default class —
 * which is how an imaging read inside a "MEDICAL_RECORD" packet stayed a
 * clinic visit. A short segment is still classified, but only on unmistakable
 * evidence.
 */
const MIN_SHORT_SEGMENT_SCORE = 6;

/**
 * Divide a document's text into ranges that each carry one analysis class.
 *
 * Always returns at least one range covering the whole text, so callers never
 * have to handle an empty result.
 */
export function classifyRanges(text: string, documentType: string | null | undefined): ClassifiedRange[] {
  const declared = analysisClassFor(documentType);
  const whole: ClassifiedRange = {
    offsetStart: 0,
    offsetEnd: text.length,
    klass: declared,
    method: documentType ? "DOCUMENT_TYPE" : "FALLBACK_UNKNOWN",
    confidence: 0,
    segmentKey: null,
  };

  // An upload with no deliberate type (the schema default is OTHER) resolves
  // to UNKNOWN, which can express almost nothing. Before accepting that, read
  // the document itself: identifying it from content is the difference between
  // "we could not tell" and "nobody picked a type from the dropdown".
  const identifyWhole = (): ClassifiedRange => {
    if (declared !== "UNKNOWN" || text.length < MIN_SEGMENT_CHARS) return whole;
    const content = classifyByContent(text);
    const derived = classFromContent(content.type, content.score, MIN_SEGMENT_SCORE);
    return derived.method === "SEGMENT_CONTENT"
      ? { ...whole, klass: derived.klass, method: derived.method, confidence: derived.confidence }
      : whole;
  };

  const segments = segmentDocument(text);
  if (!segments || segments.length < 2) return [identifyWhole()];

  const ranges: ClassifiedRange[] = [];
  for (const seg of segments) {
    const start = Math.max(0, Math.min(seg.offsetStart, text.length));
    const end = Math.max(start, Math.min(seg.offsetEnd, text.length));
    if (end <= start) continue;
    const body = text.slice(start, end);

    // An administrative sub-document is never clinical, whatever the packet
    // says it is. It stays visible; it does not become an encounter. But
    // "administrative" is not one thing: a charge ledger, an insurance
    // authorization and a wage statement each have their own vocabulary, and
    // collapsing them all into generic correspondence throws that away.
    if (seg.kind === "administrative") {
      const adminContent = classifyByContent(body);
      const admin = classFromContent(adminContent.type, adminContent.score, MIN_SEGMENT_SCORE);
      let klass: AnalysisClass = adminKindAllowed(admin.klass) && admin.method === "SEGMENT_CONTENT" ? admin.klass : "CORRESPONDENCE_OR_GENERIC_EVIDENCE";
      // A segment the segmenter called administrative is a clinical note only
      // when clinical content dominates it — a superbill whose visit note is
      // the bulk of the page, not a charge sheet mentioning a diagnosis.
      if (PROMOTABLE_TO_CLINICAL.has(klass) && readsAsClinicalNote(body)) klass = "CLINICAL_ENCOUNTER";
      ranges.push({
        offsetStart: start,
        offsetEnd: end,
        klass,
        method: "SEGMENT_CONTENT",
        confidence: admin.confidence,
        segmentKey: segmentKeyOf(seg.date, start, end),
      });
      continue;
    }

    const content = classifyByContent(body);
    // A short segment must clear a higher bar; a long one clears the ordinary
    // one. Either way an unconvincing score falls back rather than guessing.
    const floor = body.length < MIN_SEGMENT_CHARS ? MIN_SHORT_SEGMENT_SCORE : MIN_SEGMENT_SCORE;
    let derived = classFromContent(content.type, content.score, floor);
    // Decide what this segment IS. Clinical content must dominate, not merely
    // appear: otherwise a charge page with a diagnosis label becomes an
    // encounter, duplicating the note filed separately in the same packet.
    if (PROMOTABLE_TO_CLINICAL.has(derived.klass) && readsAsClinicalNote(body)) {
      derived = { klass: "CLINICAL_ENCOUNTER", method: derived.method, confidence: derived.confidence };
    }
    // A confident content class wins for its own segment. Otherwise the
    // packet's declared type applies — and when there is no declared type
    // either, the range stays UNKNOWN rather than becoming clinical.
    const resolved: ClassifiedRange =
      derived.method === "SEGMENT_CONTENT"
        ? { offsetStart: start, offsetEnd: end, klass: derived.klass, method: derived.method, confidence: derived.confidence, segmentKey: segmentKeyOf(seg.date, start, end) }
        : { ...whole, offsetStart: start, offsetEnd: end, segmentKey: segmentKeyOf(seg.date, start, end) };
    ranges.push(resolved);
  }

  if (!ranges.length) return [whole];

  // Cover EVERY character, including gaps between segments. A hole would leave
  // some offsets in no range at all, and a chunk overlapping one would be
  // tagged with a neighbour's class — silently analyzing a billing page as an
  // operative report.
  ranges.sort((a, b) => a.offsetStart - b.offsetStart);
  const covered: ClassifiedRange[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.offsetStart > cursor) covered.push({ ...whole, offsetStart: cursor, offsetEnd: r.offsetStart, segmentKey: null });
    covered.push(r);
    cursor = Math.max(cursor, r.offsetEnd);
  }
  if (cursor < text.length) covered.push({ ...whole, offsetStart: cursor, offsetEnd: text.length, segmentKey: null });

  return mergeAdjacent(covered);
}

/** A stable per-segment identity: its date and character span. */
function segmentKeyOf(date: string | null, start: number, end: number): string {
  return `${date ?? "undated"}@${start}-${end}`;
}

/**
 * Adjacent ranges of the same class become one, so a packet of thirty clinic
 * notes does not force thirty chunk boundaries where one class covers them.
 */
function mergeAdjacent(ranges: ClassifiedRange[]): ClassifiedRange[] {
  const out: ClassifiedRange[] = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (prev && prev.klass === r.klass && prev.offsetEnd === r.offsetStart) {
      prev.offsetEnd = r.offsetEnd;
      // The merged span no longer identifies a single segment.
      if (prev.segmentKey !== r.segmentKey) prev.segmentKey = null;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/** The range covering a character offset. */
export function rangeAt(ranges: ClassifiedRange[], offset: number): ClassifiedRange | null {
  for (const r of ranges) if (offset >= r.offsetStart && offset < r.offsetEnd) return r;
  return ranges[ranges.length - 1] ?? null;
}
