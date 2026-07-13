// ─────────────────────────────────────────────────────────────────────────────
// Chart-structure preprocessing for large consolidated records.
//
// A scanned hospital chart (hundreds of pages) is dominated by REPEATED page
// furniture — patient-name banners, facility footers, audit/acknowledgement
// lines, and medication-administration / intake-&-output flowsheet grids — that
// OCR turns into noise and that a date-anchored segmenter keeps mistaking for
// encounters. This module strips that furniture BEFORE segmentation.
//
// The key idea is that furniture is learnable from the chart itself: a line that
// recurs verbatim across many pages is almost never a clinical finding (a real
// finding rarely repeats word-for-word). So we count line frequencies, treat the
// high-frequency non-clinical lines as furniture, and drop them — while always
// preserving "Page N of M" markers (page citations depend on them) and never
// dropping a clinically-worded line even if it repeats. This is vendor-agnostic:
// it adapts to whatever furniture a given EHR/scan produces.
//
// Pure functions only; unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_MARK = /^page\s+\d+(?:\s+of\s+\d+)?/i;

// Clinical vocabulary — a repeated line carrying any of these is protected from
// furniture removal (e.g. a reprinted medication order or problem line).
const CLINICAL_WORD =
  /\b(fracture|arthroplasty|revision|diagnos|impression|assessment|surger|surgical|sepsis|pneumonia|opacit|effusion|hemoglobin|edema|wound|incision|prosthes|loosening|stenosis|radiculopathy|infarct|embol|hemorrhage|ischemi|consult|hypotens|hypertens|tachycard|respiratory failure|arthritis|osteo|pain\b|\bmg\b|\bml\b|oxycodone|gabapentin|morphine|antibiotic|discharge diagnosis|chief complaint|\bhpi\b)/i;

// Flowsheet / medication-administration / audit furniture — dropped even below
// the repetition threshold because these grids are pure structure, never prose.
const FLOWSHEET_LINE =
  /^(?:intake\s*&?\s*output|iv intake|i\/o\b|\bprotocol\s*:|\bfreq\s*:|status\s*:\s*(?:signed|discharge|completed|new|active|verified)|new\s*:\s*completed|date\s*&?\s*time\s+user|.*\bview only\b|cumulative (?:dose|intake|volume)|container volume|\.stk-med|\bMAR\b\s*:|order (?:source|is entered)|acknowledge?ment|device event|background dose|\bdose\s+\d|once\/prn|q\d+h\/prn|not administered|dispensed at|electronically (?:signed|verified)|\bflowsheet\b|vital signs\s+flowsheet|\||recorded (?:client|date|by))/i;

/** Read the page count from a "Page N of M" marker (0 when none is present). */
function pageCount(text: string): number {
  let max = 0;
  const re = /page\s+\d+\s+of\s+(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

const normLine = (s: string): string => s.trim().replace(/\s+/g, " ");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A banner phrase (facility / patient / department / audit label) is furniture
// that OCR often merges onto the same line as real text; we strip it as a
// substring wherever it appears, not just as a whole line.
const BANNER_HINT =
  /\b(medical center|hospital|health system|clinic|department|recorded (?:client|date|by)|ordering md|determined by patient|user\b|protocol\b|phoebe|sumter|putney)\b/i;
function isBanner(line: string): boolean {
  if (line.length < 10 || CLINICAL_WORD.test(line)) return false;
  if (BANNER_HINT.test(line)) return true;
  // Otherwise: a proper-noun banner (mostly Title-Case / all-caps words, few digits).
  const words = line.match(/[A-Za-z][A-Za-z'-]+/g) ?? [];
  const capish = words.filter((w) => /^[A-Z]/.test(w)).length;
  const digits = (line.match(/\d/g) ?? []).length;
  return words.length >= 2 && capish / words.length > 0.7 && digits <= 2;
}

/**
 * Learn the set of furniture lines in a chart: normalized lines that recur at or
 * above a page-scaled threshold and do not read as clinical content.
 */
export function learnFurniture(text: string): Set<string> {
  const pages = pageCount(text) || Math.max(1, Math.round(text.length / 1800));
  // Scale with chart size but never below 5 — enough repetition that a real
  // clinical sentence would essentially never reach it by chance.
  const threshold = Math.max(5, Math.round(pages / 50));
  const freq = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const n = normLine(raw);
    if (n.length >= 6 && n.length <= 90 && !PAGE_MARK.test(n)) freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  const furniture = new Set<string>();
  for (const [line, n] of freq) if (n >= threshold && !CLINICAL_WORD.test(line)) furniture.add(line);
  return furniture;
}

/**
 * Strip repeated page furniture and flowsheet/MAR grids from a chart, preserving
 * page markers and clinically-worded lines. Returns the text unchanged for small
 * records (nothing to learn from). Safe on any text.
 */
export function stripChartFurniture(text: string | null | undefined): string {
  const t = String(text ?? "");
  if (t.length < 4000) return t; // too small to learn furniture reliably
  const furniture = learnFurniture(t);
  // Banner phrases (longest first) get removed even when merged mid-line.
  const banners = [...furniture].filter(isBanner).sort((a, b) => b.length - a.length);
  const bannerRe = banners.length ? new RegExp(banners.map(escapeRe).join("|"), "gi") : null;
  const out: string[] = [];
  for (const raw of t.split("\n")) {
    const n = normLine(raw);
    if (PAGE_MARK.test(n)) { out.push(raw); continue; } // keep page citations
    if (!n) { out.push(raw); continue; }
    if (furniture.has(n)) continue;
    if (FLOWSHEET_LINE.test(n) && !CLINICAL_WORD.test(n)) continue;
    // Scrub embedded banners, then re-check the line still has real content.
    const scrubbed = bannerRe ? normLine(raw.replace(bannerRe, " ")) : normLine(raw);
    if (!scrubbed) continue;
    out.push(scrubbed);
  }
  return out.join("\n");
}
