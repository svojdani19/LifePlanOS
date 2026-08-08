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
 * Clinical substance inside a document that otherwise looks like billing.
 *
 * A charge line is not clinical. But providers routinely file the visit note
 * and the charge for it in one place, and a superbill or an operative billing
 * packet can carry the real history, examination, assessment or operative
 * detail. Classifying the whole segment FINANCIAL on the strength of its
 * charge columns would discard that clinical content, so a segment that
 * carries a provider's own analysis is treated as the clinical document it
 * partly is. Losing a clinical fact is far worse than over-including a page.
 */
const CLINICAL_SUBSTANCE_RE =
  /\b(?:chief complaint|history of present illness|\bhpi\b|physical (?:exam|examination)|on examination|review of systems|\bros\b|assessment and plan|\ba\/p\b|impression(?:\s*(?:and|&)\s*plan)?:|assessment:|plan:|operative (?:report|findings)|preoperative diagnosis|postoperative diagnosis|procedure performed|indications for (?:the )?procedure|range of motion|straight leg raise|neurologic(?:al)? exam|palpation reveal|tenderness (?:to|on) palpation|prescrib\w+|discharge instructions|follow[- ]up in)\b/i;

/** At least this many distinct clinical markers before promoting a segment. */
const CLINICAL_PROMOTION_MARKERS = 2;

/**
 * Does this text carry a provider's own clinical analysis — history, exam,
 * assessment, plan, procedure — rather than only charges for it?
 */
export function carriesClinicalSubstance(text: string): boolean {
  const re = new RegExp(CLINICAL_SUBSTANCE_RE.source, "gi");
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) hits.add(m[0].toLowerCase());
  return hits.size >= CLINICAL_PROMOTION_MARKERS;
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
      // Even a segment the segmenter called administrative is clinical when it
      // carries a provider's own analysis — a superbill with the visit note
      // attached is still the visit note.
      if (PROMOTABLE_TO_CLINICAL.has(klass) && carriesClinicalSubstance(body)) klass = "CLINICAL_ENCOUNTER";
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
    // A billing segment that also carries the provider's own analysis is a
    // clinical document with charges attached, not a ledger. Read it as
    // clinical so the history, exam, assessment or procedure is not thrown
    // away with the charge columns.
    if (PROMOTABLE_TO_CLINICAL.has(derived.klass) && carriesClinicalSubstance(body)) {
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
