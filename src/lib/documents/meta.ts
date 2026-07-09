// ─────────────────────────────────────────────────────────────────────────────
// Record metadata extraction.
//
// From a record's body, pull the three descriptors every reviewed record should
// carry: the documented date, the documenting individual (name + credentials +
// role designation), and the location/facility where the episode took place.
// Everything is read from the CONTENT — labels the record actually uses ("DATE
// OF SERVICE", "SURGEON:", "FACILITY:") — never invented. Missing fields stay
// null so the reviewer sees exactly what the record did (and did not) document.
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordMeta {
  serviceDate: Date | null;
  authorName: string | null;
  authorCredentials: string | null;
  authorRole: string | null;
  facility: string | null;
}

// Recognized post-nominal credential tokens (longest/most-specific first).
const CRED = "PharmD|PsyD|CRNA|OTR\\/L|DPT|MSN|BSN|PA-C|FACS|FAAOS|CLCP|CCM|CSR|PhD|MPT|MD|DO|OT|PT|RN|NP|PA|DC";

// A labeled documented date. First labeled date wins (that is the record's own
// primary date); a bare trailing "DATE:" is the last-resort fallback.
const DATE_LABEL = new RegExp(
  "\\b(?:date of (?:service|procedure|exam(?:ination)?|evaluation|visit|admission)|date collected|collected|fill date|admission date|exam date|date signed|date)\\b\\s*[:\\-]?\\s*" +
    "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Z][a-z]+\\.?\\s+\\d{1,2},?\\s*\\d{4})",
  "i",
);

// Role labels that introduce a documenting individual (most-specific first). The
// label is matched case-insensitively; the name/credentials that follow are then
// parsed case-sensitively (so capitalization still identifies the actual name).
const AUTHOR_LABELS = [
  "assistant surgeon", "surgeon", "radiologist", "anesthesiologist", "attending physician", "treating physician",
  "examining physician", "attending", "physician", "therapist", "examiner", "evaluated by", "dictated by",
  "electronically signed by", "signed by", "reviewed by", "reported by", "ordered by", "prepared by", "provider", "pharmacist",
];
const AUTHOR_LABEL = new RegExp("\\b(" + AUTHOR_LABELS.join("|") + ")\\b\\s*[:\\-]\\s*(?:by\\s+)?(?:Dr\\.?\\s+)?", "i");
// From the text after the label: Name[, CREDS][ — Role].
const AUTHOR_TAIL = new RegExp(
  "^([A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){0,2})" + // name (1–3 capitalized tokens)
    "(?:\\s*,\\s*((?:" + CRED + ")(?:\\s*#?\\d+)?(?:\\s*,\\s*(?:" + CRED + "))*))?" + // credentials
    "(?:\\s*[—–-]\\s*([^.\\n]+?))?\\s*(?:[.\\n]|$)", // trailing role/specialty
);

// A labeled location/facility — capture to end of line so internal periods
// (e.g. "St. Jude Medical Center") survive; a trailing period is trimmed.
const FACILITY_LABEL = new RegExp("\\b(?:facility|location|hospital|clinic|laboratory|performed at)\\b\\s*[:\\-]\\s*([^\\n]+?)\\s*\\.?\\s*(?:\\n|$)", "i");

// Fallback role designation by document type when the record does not name one.
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

export function parseRecordMeta(text: string | null | undefined, type?: string): RecordMeta {
  const t = (text ?? "").replace(/\r/g, "");
  const meta: RecordMeta = { serviceDate: null, authorName: null, authorCredentials: null, authorRole: null, facility: null };
  if (!t.trim()) return meta;

  const dm = t.match(DATE_LABEL);
  if (dm) meta.serviceDate = toDate(dm[1]);

  const am = t.match(AUTHOR_LABEL);
  if (am) {
    const tail = t.slice((am.index ?? 0) + am[0].length).match(AUTHOR_TAIL);
    if (tail) {
      meta.authorName = tail[1]?.trim() || null;
      meta.authorCredentials = tail[2]?.trim() || null;
      meta.authorRole = tail[3]?.trim() || ROLE_BY_TYPE[type ?? ""] || titleCase(am[1]);
    } else {
      meta.authorRole = ROLE_BY_TYPE[type ?? ""] || titleCase(am[1]);
    }
  } else if (type && ROLE_BY_TYPE[type]) {
    // No named author, but the record type still implies a role designation.
    meta.authorRole = ROLE_BY_TYPE[type];
  }

  const fm = t.match(FACILITY_LABEL);
  if (fm) meta.facility = fm[1]?.trim() || null;

  return meta;
}
