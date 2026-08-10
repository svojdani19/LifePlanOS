// ─────────────────────────────────────────────────────────────────────────────
// Recovering a record's date from the claims it already yielded.
//
// On a real case 564 of 767 records came out undated — three quarters of the
// file — and 134 of those carried clinical substance. Their claims read:
//
//   [procedure] HCPCS 3641 performed on 03/13/24
//   [procedure] CPT 99213 performed on 04/02/24
//   [procedure] Clinic visit (CPT 99442) on 02/20/2024
//
// The date is stated, in the record's own words, inside a claim whose excerpt
// was already verified against the page. What happened is that the extractor
// proposed no encounter date at all for these rows — dateSourceText is null —
// because a billing-shaped line does not look to it like an encounter, and the
// date validator's job is to reject print stamps and signature dates rather
// than to go looking for one.
//
// A planner has no such difficulty: their Procedures table is dated straight
// off the service lines, because for a service record the date of service IS
// the date of the record.
//
// So this reads a date out of the claims when the extractor supplied none. It
// is deliberately narrow — the date must sit in explicit service context, not
// merely appear somewhere in the text — and what it produces is always an
// INFERRED date, never a documented one, so a reviewer can see that the
// program worked it out rather than read it off a header.
// ─────────────────────────────────────────────────────────────────────────────

export interface DatedClaim {
  field: string;
  value: string;
  excerpt: string;
}

export interface RecoveredDate {
  iso: string;
  /** The claim text the date was read from, for review. */
  sourceText: string;
}

/**
 * Phrases that make a date the date of the SERVICE rather than an artifact.
 *
 * "Performed on", "date of service", "billed for" — the record stating when
 * the thing it documents happened. Deliberately excludes "printed", "signed",
 * "received", "statement" and the rest: those are the artifact contexts the
 * extractor's own validator exists to reject, and recovering a date from one
 * would reintroduce exactly the defect that validator prevents.
 */
const SERVICE_CONTEXT = String.raw`(?:performed|rendered|provided|furnished|administered|billed|charged|delivered|dispensed|supplied|occurred|seen|treated|admitted|discharged|conducted)\s+(?:on|date)?|date\s+of\s+(?:service|visit|procedure|operation|admission|surgery|treatment)|service\s+date|visit\s+date|encounter\s+date|dos|d\.?o\.?s\.?`;

/** Contexts that must never yield a record's date, mirroring the extractor. */
const ARTIFACT_CONTEXT =
  /\b(?:dob|date of birth|birth\s?date|print(?:ed)?|signed|signature|fax(?:ed)?|received|scanned|uploaded|created|expir\w*|policy|statement|due|report generated|as of)\b/i;

const DATE = String.raw`(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})|(\d{4})-(\d{2})-(\d{2})`;

const SERVICE_DATE = new RegExp(String.raw`(?:${SERVICE_CONTEXT})\s*[:#-]?\s*(?:${DATE})`, "gi");

/**
 * The record's date, read from its claims.
 *
 * Returns null when no claim states a date in service context — silence is the
 * honest answer, and an undated record already routes to human review.
 */
export function dateFromClaims(claims: readonly DatedClaim[], today = new Date()): RecoveredDate | null {
  const found = new Map<string, string>();
  for (const claim of claims) {
    for (const text of [claim.value, claim.excerpt]) {
      if (!text) continue;
      for (const m of text.matchAll(SERVICE_DATE)) {
        const at = m.index ?? 0;
        // "Metformin 500 mg tablet (as of 03/23/2024)" states when a
        // medication list was current, not when the record happened.
        if (ARTIFACT_CONTEXT.test(text.slice(Math.max(0, at - 30), at + m[0].length))) continue;
        const iso = toIso(m, today);
        if (iso && !found.has(iso)) found.set(iso, text.replace(/\s+/g, " ").trim().slice(0, 200));
      }
    }
  }
  if (!found.size) return null;
  // A record carrying several service dates is dated by its earliest: a
  // statement covering a course of care begins when the care began, and the
  // later dates belong to the entries that document them.
  const [iso, sourceText] = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]))[0];
  return { iso, sourceText };
}

function toIso(m: RegExpMatchArray, today: Date): string | null {
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
    // A two-digit year is this century unless that would be in the future.
    if (year < 100) year += year + 2000 > today.getFullYear() + 1 ? 1900 : 2000;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  // A record cannot document care that has not happened, and a date before
  // living memory is an OCR artifact rather than a service date.
  if (at.getTime() > today.getTime() || year < 1900) return null;
  return at.toISOString().slice(0, 10);
}
