// ─────────────────────────────────────────────────────────────────────────────
// One assertion, gated and displayed as the same string.
//
// The defect, reproduced exactly on the reference case: a 1,046-character
// `imagingFindings` field that is entirely a LEFT KNEE MRI report classified as
// "spine", because `bodyRegion` returns the first pattern that matches anywhere
// in the text and spine precedes knee in the table. It passed the anatomy gate
// for a lumbar discectomy, and the panel then rendered `cleanClause(raw, 180)`
// — the knee sentence. The physician saw:
//
//   "…lumbar burst fracture rests on a concrete finding — multiplanar magnetic
//    resonance images of the left knee were obtained."
//
// Two faults compounding: a region test on a multi-topic blob, and a gate
// applied to a different string than the one displayed.
//
// The order of operations is therefore fixed:
//
//   atomize → validate the exact assertion → classify → persist → hash → render
//
// A field is split into single clinical assertions FIRST. Every gate runs on
// the assertion. The assertion that passed is the assertion stored, and it
// renders verbatim. `textHash` makes that testable: for any rendered string,
// sha256(displayed) must equal the hash of what was validated.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { bodyRegion, spineSubRegions, sideOf, type BodyRegion, type SpineSubRegion, type Side } from "@/lib/engine/integrity";

export interface AtomicAssertion {
  /** EXACTLY what is gated, stored, displayed and printed. */
  text: string;
  /** sha256 of `text`. The display must be able to reproduce this. */
  textHash: string;
  /** Anatomy parsed from THIS assertion, not from its parent field. */
  region: BodyRegion;
  spinalLevels: SpineSubRegion[];
  laterality: Side;
  /** Position within the parent field, for audit. */
  index: number;
  /** sha256 of the field it came from, so the split is reviewable. */
  parentHash: string;
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Sentence-ish boundaries that survive clinical abbreviations. */
const SPLIT = /(?<=[.!?;])\s+(?=[A-Z(“"']|\d)/g;

/**
 * A fragment too short or too structural to be an assertion.
 *
 * The label patterns require a COLON or a page number. Matching the bare words
 * killed every clinical sentence beginning "Patient reports…", which is how a
 * great many functional findings are written — an over-broad filter silently
 * deleting the evidence it was meant to tidy.
 */
const isNoise = (s: string): boolean =>
  s.length < 12 ||
  /^[A-Z0-9 :/,\-.]+$/.test(s) ||
  /^\s*page\s+\d+(?:\s+of\s+\d+)?\.?\s*$/i.test(s) ||
  /^\s*(?:exam|date|dob|mrn|patient|name|provider|facility|account)\s*[:#]/i.test(s);

/**
 * Split one extraction field into atomic clinical assertions.
 *
 * Deliberately conservative: a sentence is the unit. Splitting further (by
 * clause) would fragment findings that only make sense together — "no acute
 * fracture; mild degenerative change" is two assertions, but "the medial and
 * lateral menisci were unremarkable" is one and must not become two.
 */
export function atomize(field: string | null | undefined): AtomicAssertion[] {
  const raw = String(field ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parentHash = sha256(raw);
  const out: AtomicAssertion[] = [];
  for (const piece of raw.split(SPLIT)) {
    const text = piece.replace(/[;,]\s*$/, "").trim();
    if (isNoise(text)) continue;
    out.push({
      text,
      textHash: sha256(text),
      region: bodyRegion(text),
      spinalLevels: spineSubRegions(text),
      laterality: sideOf(text),
      index: out.length,
      parentHash,
    });
  }
  // A field with no sentence punctuation is one assertion, not zero.
  if (!out.length && !isNoise(raw)) {
    out.push({ text: raw, textHash: sha256(raw), region: bodyRegion(raw), spinalLevels: spineSubRegions(raw), laterality: sideOf(raw), index: 0, parentHash });
  }
  return out;
}

/**
 * The DOMINANT region of a passage, rather than the first pattern to hit.
 *
 * `bodyRegion` is first-match-wins over an ordered table, which is correct for
 * a sentence and wrong for a multi-topic report: a knee MRI mentioning the
 * spine once classifies as spine, because spine is listed first. Used for
 * disclosure and routing, never as a substitute for gating the assertion.
 */
export function dominantRegion(field: string | null | undefined): BodyRegion {
  const parts = atomize(field);
  if (!parts.length) return "general";
  const tally = new Map<BodyRegion, number>();
  for (const p of parts) if (p.region !== "general") tally.set(p.region, (tally.get(p.region) ?? 0) + 1);
  if (!tally.size) return "general";
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * The guarantee, as a callable check: is this rendered string the assertion
 * that was validated?
 */
export const rendersValidatedAssertion = (displayed: string, assertion: { textHash: string }): boolean =>
  sha256(String(displayed).replace(/\s+/g, " ").trim()) === assertion.textHash;
