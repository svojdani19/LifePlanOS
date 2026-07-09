// ─────────────────────────────────────────────────────────────────────────────
// Record metadata extraction.
//
// From a record's body, pull the descriptors every reviewed record should carry:
// the documented date(s), the documenting individual(s) (name + credentials +
// role), and the location(s) where care took place — all read from the CONTENT,
// never invented. When a record spans MULTIPLE dates/providers/locations (e.g. a
// multi-page consolidated chart), each is captured with the page(s) it appears
// on, so the reviewer sees the date range and every provider/location cited.
// ─────────────────────────────────────────────────────────────────────────────

export interface Provider {
  name: string;
  credentials: string | null;
  role: string | null;
  pages: number[];
}
export interface RecordLocation {
  name: string;
  pages: number[];
}
export interface RecordMeta {
  serviceDate: Date | null; // earliest, or the single date
  serviceDateEnd: Date | null; // latest, when the record spans a range
  datePages: number[]; // pages on which dated entries appear
  authorName: string | null; // primary (first) provider
  authorCredentials: string | null;
  authorRole: string | null;
  facility: string | null; // primary (first) location
  providers: Provider[];
  locations: RecordLocation[];
}

// Recognized post-nominal credential tokens (longest/most-specific first).
const CRED = "PharmD|PsyD|CRNA|OTR\\/L|DPT|MSN|BSN|PA-C|FACS|FAAOS|CLCP|CCM|CSR|PhD|MPT|MD|DO|OT|PT|RN|NP|PA|DC";

const DATE_LABEL = new RegExp(
  "\\b(?:date of (?:service|procedure|exam(?:ination)?|evaluation|visit|admission)|date collected|collected|fill date|admission date|exam date|date signed|date)\\b\\s*[:\\-]?\\s*" +
    "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Z][a-z]+\\.?\\s+\\d{1,2},?\\s*\\d{4})",
  "i",
);

const AUTHOR_LABELS = [
  "assistant surgeon", "surgeon", "radiologist", "anesthesiologist", "attending physician", "treating physician",
  "examining physician", "attending", "physician", "therapist", "examiner", "evaluated by", "dictated by",
  "electronically signed by", "signed by", "reviewed by", "reported by", "ordered by", "prepared by", "provider", "pharmacist",
];
const AUTHOR_LABEL = new RegExp("\\b(" + AUTHOR_LABELS.join("|") + ")\\b\\s*[:\\-]\\s*(?:by\\s+)?(?:Dr\\.?\\s+)?", "i");
const AUTHOR_TAIL = new RegExp(
  "^([A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){0,2})" +
    "(?:\\s*,\\s*((?:" + CRED + ")(?:\\s*#?\\d+)?(?:\\s*,\\s*(?:" + CRED + "))*))?" +
    "(?:\\s*[—–-]\\s*([^.\\n]+?))?\\s*(?:[.\\n]|$)",
);

const FACILITY_LABEL = new RegExp("\\b(?:facility|location|hospital|clinic|laboratory|performed at)\\b\\s*[:\\-]\\s*([^\\n]+?)\\s*\\.?\\s*(?:\\n|$)", "i");

const ROLE_BY_TYPE: Record<string, string> = {
  OPERATIVE_NOTE: "Operating Surgeon",
  IMAGING_REPORT: "Radiologist",
  ER_RECORD: "Emergency Physician",
  PT_OT_RECORD: "Physical Therapist",
  NEUROPSYCHOLOGICAL_EVALUATION: "Neuropsychologist",
  IME_REPORT: "Independent Medical Examiner",
  PHARMACY_RECORD: "Pharmacist",
  LAB_REPORT: "Laboratory / Pathology",
  DEPOSITION: "Court Reporter",
  PSYCHIATRY_RECORD: "Psychiatrist",
  PAIN_MANAGEMENT: "Pain Management Physician",
};

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}
function toDate(raw: string): Date | null {
  const d = new Date(raw.includes("/") ? raw : raw.replace(/(\d),/, "$1,"));
  return isNaN(d.getTime()) ? null : d;
}

// "Page N" / "Page N of M" markers → the page each character offset falls on.
function pageMarks(text: string): { offset: number; page: number }[] {
  const marks: { offset: number; page: number }[] = [];
  const re = /\bpage\s+(\d+)\b(?:\s+of\s+\d+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ offset: m.index, page: parseInt(m[1], 10) });
  return marks;
}
function pageForOffset(off: number, marks: { offset: number; page: number }[]): number | null {
  if (!marks.length) return null;
  let pg = marks[0].page;
  for (const mk of marks) {
    if (mk.offset <= off) pg = mk.page;
    else break;
  }
  return pg;
}

// Format a page list as compact ranges: [1,2,3,5] → "1–3, 5".
export function pageRange(pages: number[]): string {
  const s = [...new Set(pages)].filter((n) => n > 0).sort((a, b) => a - b);
  if (!s.length) return "";
  const out: string[] = [];
  let start = s[0];
  let prev = s[0];
  for (let i = 1; i <= s.length; i++) {
    if (s[i] === prev + 1) prev = s[i];
    else {
      out.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = s[i];
      prev = s[i];
    }
  }
  return out.join(", ");
}

export function parseRecordMeta(text: string | null | undefined, type?: string): RecordMeta {
  const t = (text ?? "").replace(/\r/g, "");
  const meta: RecordMeta = {
    serviceDate: null, serviceDateEnd: null, datePages: [],
    authorName: null, authorCredentials: null, authorRole: null, facility: null,
    providers: [], locations: [],
  };
  if (!t.trim()) {
    if (type && ROLE_BY_TYPE[type]) meta.authorRole = ROLE_BY_TYPE[type];
    return meta;
  }
  const marks = pageMarks(t);

  // ── Dates (all labeled occurrences) → earliest, latest, and their pages. ─────
  const dateMap = new Map<string, { date: Date; pages: Set<number> }>();
  const dre = new RegExp(DATE_LABEL.source, "gi");
  let dm: RegExpExecArray | null;
  while ((dm = dre.exec(t))) {
    const d = toDate(dm[1]);
    if (!d) continue;
    const key = d.toISOString().slice(0, 10);
    const pg = pageForOffset(dm.index, marks);
    const e = dateMap.get(key) ?? { date: d, pages: new Set<number>() };
    if (pg) e.pages.add(pg);
    dateMap.set(key, e);
  }
  const dates = [...dateMap.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (dates.length) {
    meta.serviceDate = dates[0].date;
    meta.serviceDateEnd = dates.length > 1 ? dates[dates.length - 1].date : null;
    meta.datePages = [...new Set(dates.flatMap((d) => [...d.pages]))].sort((a, b) => a - b);
  }

  // ── Providers (all labeled documenting individuals) with their pages. ────────
  const provMap = new Map<string, Provider>();
  const are = new RegExp(AUTHOR_LABEL.source, "gi");
  let am: RegExpExecArray | null;
  while ((am = are.exec(t))) {
    const tail = t.slice(am.index + am[0].length).match(AUTHOR_TAIL);
    const pg = pageForOffset(am.index, marks);
    if (!tail || !tail[1]) continue; // only list named individuals
    const name = tail[1].trim();
    const cred = tail[2]?.trim() || null;
    const role = tail[3]?.trim() || ROLE_BY_TYPE[type ?? ""] || titleCase(am[1]);
    const key = name.toLowerCase();
    const e = provMap.get(key) ?? { name, credentials: cred, role, pages: [] };
    if (cred && !e.credentials) e.credentials = cred;
    if (!e.role && role) e.role = role;
    if (pg && !e.pages.includes(pg)) e.pages.push(pg);
    provMap.set(key, e);
  }
  meta.providers = [...provMap.values()].map((p) => ({ ...p, pages: p.pages.sort((a, b) => a - b) }));
  if (meta.providers.length) {
    meta.authorName = meta.providers[0].name;
    meta.authorCredentials = meta.providers[0].credentials;
    meta.authorRole = meta.providers[0].role;
  } else if (type && ROLE_BY_TYPE[type]) {
    meta.authorRole = ROLE_BY_TYPE[type];
  }

  // ── Locations (all labeled facilities) with their pages. ─────────────────────
  const locMap = new Map<string, RecordLocation>();
  const fre = new RegExp(FACILITY_LABEL.source, "gi");
  let fm: RegExpExecArray | null;
  while ((fm = fre.exec(t))) {
    const name = fm[1]?.trim();
    if (!name) continue;
    const pg = pageForOffset(fm.index, marks);
    const key = name.toLowerCase();
    const e = locMap.get(key) ?? { name, pages: [] };
    if (pg && !e.pages.includes(pg)) e.pages.push(pg);
    locMap.set(key, e);
  }
  meta.locations = [...locMap.values()].map((l) => ({ ...l, pages: l.pages.sort((a, b) => a - b) }));
  if (meta.locations.length) meta.facility = meta.locations[0].name;

  return meta;
}
