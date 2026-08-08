// ─────────────────────────────────────────────────────────────────────────────
// Reading a professionally published Life Care Plan.
//
// A published plan is the only ground truth this program has for what a
// qualified life-care planner actually does with a case file: which encounters
// they chronicle, what they say about each, and in what order. Everything the
// program learns from a corpus flows through this parser.
//
// It reads TEXT that a caller supplies. It never reads a file, names a case, or
// holds any patient content of its own — the plans are real patient records and
// live outside the repository. What comes back is structure: dates, headings,
// and the planner's own labelled clauses.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";

export interface PublishedClause {
  /** The planner's own label, normalized ("Impressions:" → "impression"). */
  label: string;
  /** The clause body, as published. */
  text: string;
}

export interface PublishedEntry {
  /** The entry's date, as published (MM/DD/YYYY). */
  date: string;
  /** ISO date, or null when the published date does not parse. */
  isoDate: string | null;
  /** Provider, facility and — where the plan states it — the document kind. */
  heading: string;
  /** The planner's labelled clauses, in the order they were written. */
  clauses: PublishedClause[];
  /** What kind of record this entry chronicles. */
  kind: AnalysisClass;
}

// Page furniture the PDF text extraction leaves behind on every page.
const FURNITURE = [/^Life Care Plan.*\(DOB:.*$/i, /^Page \d+\s*$/i, /^\s*$/];

// An entry header: a date, then the provider/facility. Plans differ on whether
// a dash separates them, so both forms are read.
const ENTRY_HEADER = /^(\d{2}\/\d{2}\/\d{4})\s*[-–—]?\s*(\S.*)$/;

// A labelled clause. Deliberately permissive: the vocabulary is DISCOVERED from
// the plans and thresholded by the caller, not asserted here.
const LABEL = /(?:^|•\s*)([A-Z][A-Za-z][A-Za-z /&'-]{1,40}?)\s*:\s/gm;

// Anatomic bullet headings INSIDE a radiology findings block ("Bones:", "Soft
// tissues:", "C5-C6:"). They subdivide one clause; they are not clauses.
const FINDINGS_SUBHEADING =
  /^(bones?|joints?|soft tissues?|spinal cord|vertebrae|alignment|marrow|discs?|muscles?|tendons?|ligaments?|osseous structures?|findings by level|specific levels?|[ctls]\d)/i;

// Front matter, cost tables and the planner's own apparatus. These are labels
// in the document but they say nothing about an encounter.
const NOT_A_CLAUSE =
  /^(name|age|dob|doi|credentials|employment|abbreviations|disclaimer|life expectancy|general information|medical records reviewed|drug costs|total|primary mct references|other references|https?|www|note|source|table|figure|cpt|icd|pdf|p|see|e\.?g|i\.?e|prepared by|date of report|re|attn|phone|fax|email|address|reference|references|new choice|healix labs|probable duration of care|future medical damages|provider visits|peer-to-peer conversation|synopsis|complaints|incident|functional medicine|total medical expenses|total cost of providers)\b/i;

/** "Diagnostic  Studies:" / "Impressions" / "Medications used" → one key. */
export function normalizeLabel(label: string): string {
  let k = label.replace(/\s+/g, " ").trim().toLowerCase();
  k = k.replace(/\bimpressions\b/, "impression");
  k = k.replace(/\bmedications\b/, "medication");
  k = k.replace(/\bprocedures\b/, "procedure");
  k = k.replace(/\bdiagnostics\b/, "diagnostic studies");
  k = k.replace(/\bfinding\b/, "findings");
  return k;
}

/** What KIND of record an entry chronicles, from its heading and vocabulary. */
export function entryKind(heading: string, labels: readonly string[]): AnalysisClass {
  const t = heading.toLowerCase();
  if (/\b(mri|ct scan|ct report|x-?ray|radiograph|ultrasound|sonogram|emg|ncv|nerve conduction|dexa|myelogram|arthrogram|pet scan|bone scan|echocardiogram|imaging|radiology)\b/.test(t)) return "DIAGNOSTIC_STUDY";
  if (/\b(operative report|operation report|surgery report|op report)\b/.test(t)) return "OPERATIVE";
  if (/\b(physical therapy|occupational therapy|therapy (note|report)|rehab)\b/.test(t)) return "THERAPY_COURSE";
  if (/\b(deposition|testimony|affidavit|sworn)\b/.test(t)) return "TESTIMONY";
  if (/\b(pathology|biopsy|specimen|laboratory|lab report)\b/.test(t)) return "PATHOLOGY_DIAGNOSTIC";
  if (/\b(anesthesia|anesthetic)\b/.test(t)) return "ANESTHESIA";
  if (/\b(ambulance|ems|paramedic|police|incident report|crash)\b/.test(t)) return "INCIDENT";
  if (labels.includes("procedure performed") || labels.includes("procedure")) return "OPERATIVE";
  if (labels.includes("impression") && labels.includes("findings")) return "DIAGNOSTIC_STUDY";
  return "CLINICAL_ENCOUNTER";
}

const toIso = (mdy: string): string | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Parse a published plan's chronology into entries.
 *
 * Only the medical chronology is of interest. Cost tables and the medication
 * schedule also open with a date, so a line quoting a dollar figure is not
 * taken for an encounter.
 */
export function parsePublishedPlan(text: string): PublishedEntry[] {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => !FURNITURE.some((re) => re.test(l)))
    .map((l) => l.replace(/\s+$/, ""));

  const heads: { i: number; date: string; rest: string }[] = [];
  lines.forEach((line, i) => {
    const m = ENTRY_HEADER.exec(line);
    if (m && !/\$/.test(m[2])) heads.push({ i, date: m[1], rest: m[2] });
  });

  return heads.map((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].i : lines.length;
    const body = lines.slice(h.i + 1, end).join("\n");

    const found: { label: string; at: number; end: number }[] = [];
    LABEL.lastIndex = 0;
    let m: RegExpExecArray | null;
    const haystack = `\n${body}`;
    while ((m = LABEL.exec(haystack)) !== null) {
      let key = normalizeLabel(m[1]);
      if (NOT_A_CLAUSE.test(key)) continue;
      if (key.split(" ").length > 4) continue;
      // An anatomic heading inside the findings block IS the findings clause.
      if (FINDINGS_SUBHEADING.test(key)) key = "findings";
      found.push({ label: key, at: m.index, end: m.index + m[0].length });
    }

    const clauses: PublishedClause[] = [];
    found.forEach((f, idx) => {
      const stop = idx + 1 < found.length ? found[idx + 1].at : haystack.length;
      const clauseText = haystack.slice(f.end, stop).replace(/\s+/g, " ").trim();
      const existing = clauses.find((c) => c.label === f.label);
      // A repeated label (radiology sub-headings folded into "findings") keeps
      // its first position and accumulates its text.
      if (existing) existing.text = `${existing.text} ${clauseText}`.trim();
      else clauses.push({ label: f.label, text: clauseText });
    });

    const firstLabelAt = found.length ? found[0].at : haystack.length;
    const heading = `${h.rest} ${haystack.slice(0, firstLabelAt)}`.replace(/\s+/g, " ").trim().slice(0, 200);

    return {
      date: h.date,
      isoDate: toIso(h.date),
      heading,
      clauses,
      kind: entryKind(heading, clauses.map((c) => c.label)),
    };
  });
}
