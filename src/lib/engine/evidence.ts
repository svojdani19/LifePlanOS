// ─────────────────────────────────────────────────────────────────────────────
// Objective-evidence locator. For a diagnosis/condition, finds WHERE in the
// ingested records the supporting content actually appears: the document, the
// page number (from "Page N [of M]" markers in the extracted text), and a short
// verbatim quote. Uses the same distinctive-term matching as the chronology so a
// generic shared word ("fracture") can't attribute evidence to the wrong
// diagnosis. Deterministic — quotes only what is in the record.
// ─────────────────────────────────────────────────────────────────────────────

import { DX_GENERIC, EXCLUDED_TYPES, hasTerm, sigTerms } from "./chronology";
import { isCitableEvidence } from "@/lib/documents/assertion";
import { pageForOffset, pageMarks } from "@/lib/documents/meta";

export interface EvidenceSource {
  documentId: string;
  filename: string;
  /** 1-based page the quote appears on, when the record carries page markers */
  page: number | null;
  /** verbatim excerpt from the record containing the supporting content */
  quote: string;
  /** character span of the (untrimmed) quoted sentence within extractedText */
  startOffset?: number;
  endOffset?: number;
  /** term-overlap score the sentence won on (higher = stronger match) */
  matchScore?: number;
}

interface DocLike {
  id: string;
  filename: string;
  type: string;
  extractedText?: string | null;
  pageCount?: number | null;
}

const trimQuote = (s: string) => {
  const v = s.replace(/\s+/g, " ").trim();
  return v.length > 180 ? v.slice(0, 177).trimEnd() + "…" : v;
};

// Clinical abbreviations in a diagnosis name are expanded so the name's terms
// can match the records' wording (and vice versa for vertebral shorthand).
function expandName(name: string): string {
  return name
    .replace(/\btbi\b/gi, "traumatic brain injury")
    .replace(/\bsci\b/gi, "spinal cord injury")
    .replace(/\bcrps\b/gi, "complex regional pain syndrome");
}
// Records often use vertebral shorthand ("L1 burst fracture") where the
// diagnosis spells the region out ("first lumbar vertebra") — inject the region
// word into the sentence so the terms can meet.
function expandSentence(lower: string): string {
  return lower
    .replace(/\bl[1-5]\b/g, (m) => `${m} lumbar`)
    .replace(/\bc[2-7]\b/g, (m) => `${m} cervical`)
    .replace(/\bt(?:1[0-2]|[1-9])\b/g, (m) => `${m} thoracic`);
}

// Boilerplate lines are never evidence, even when they mention the anatomy
// ("TECHNIQUE: … imaging of the lumbar spine", "FACILITY: Cognitive Health…").
const BOILERPLATE = /^(technique|comparison|facility|location|appearances|date of|triage|dictated by|reviewed by|reported by|prepared by|electronically signed|signed by|examiner|surgeon|therapist|attending|provider|physician)\b/i;
// Sentences under a clinical label are the strongest evidence — prefer them.
const CLINICAL_LABEL = /^(findings|impression|(?:pre-?|post-?operative\s+|discharge\s+|admission\s+)?diagnos[ie]s|procedure performed|assessment|chief complaint|hospital course)\b/i;

/**
 * The strongest evidence locations for a condition across the case records —
 * best sentence per document, ranked by how many distinctive terms of the
 * condition it shares, capped at `max` sources. Administrative/legal records
 * are never cited as clinical evidence.
 */
export function locateConditionEvidence(docs: DocLike[], conditionName: string, max = 3): EvidenceSource[] {
  const name = expandName(conditionName);
  const terms = sigTerms(name);
  if (!terms.length) return [];
  const found: { src: EvidenceSource; score: number }[] = [];

  for (const doc of docs) {
    if (EXCLUDED_TYPES.has(doc.type)) continue;
    const text = String(doc.extractedText ?? "");
    if (text.trim().length < 30) continue;
    const marks = pageMarks(text);

    // Walk sentences with their offsets; keep the best-matching sentence.
    // Boilerplate lines are excluded; clinically labeled lines score higher.
    let best: { start: number; end: number; sentence: string; score: number } | null = null;
    const re = /[^.!?\n]+[.!?]?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const sentence = m[0].trim();
      if (sentence.length < 15 || /^[A-Z0-9 :/,\-]+$/.test(sentence)) continue; // headers
      if (BOILERPLATE.test(sentence)) continue;
      const lower = expandSentence(sentence.toLowerCase());
      // A matching term only makes the sentence a candidate when the sentence
      // actually ASSERTS it — a negated/hypothetical/family mention ("no cord
      // signal abnormality") must never be quoted as supporting evidence.
      // (Terms injected by expandSentence aren't in the raw sentence and pass
      // through as affirmed, which is intended.) The candidate rule mirrors
      // documentsDiagnosis: a distinctive shared term is required.
      const citable = terms.filter((t) => hasTerm(lower, t) && isCitableEvidence(sentence, t));
      const distinctive = citable.filter((t) => !DX_GENERIC.has(t));
      if (!distinctive.length || (!distinctive.some((t) => t.length >= 5) && citable.length < 2)) continue;
      const score = citable.length + (CLINICAL_LABEL.test(sentence) ? 2 : 0);
      // Exact character span of the trimmed sentence within extractedText.
      const start = m.index + (m[0].length - m[0].trimStart().length);
      if (!best || score > best.score) best = { start, end: start + sentence.length, sentence, score };
    }
    if (!best) continue;

    found.push({
      src: {
        documentId: doc.id,
        filename: doc.filename,
        // Single-page records are cited as p. 1 even without page markers.
        page: pageForOffset(best.start, marks) ?? (doc.pageCount === 1 ? 1 : null),
        quote: trimQuote(best.sentence),
        startOffset: best.start,
        endOffset: best.end,
        matchScore: best.score,
      },
      score: best.score,
    });
  }

  return found.sort((a, b) => b.score - a.score).slice(0, max).map((f) => f.src);
}
