// ─────────────────────────────────────────────────────────────────────────────
// Is this record's year one the document actually attests?
//
// Nine records of a March 2024 surgical admission were dated to 2004 and filed
// under "prior medical history — before the date of injury". In a life care
// plan that is not a cosmetic error: it moves injury-related care into the
// pre-existing column, which is the distinction the whole document turns on.
//
// The misread is invisible from the record alone. Every one arrived marked
// DOCUMENTED, and dateSourceText — the field that would say where the date was
// read from — is null on all 3,831 dated rows in the case, so "documented"
// carries no evidence with it. The claims do not help either: 108 of the 123
// affected rows state no date of their own anywhere.
//
// The document does help. Around those rows it prints 2024 six thousand times
// and 2004 fifty-four, and one row dated 2004-10-10 sits in text reading "many
// months postop L2-S1 decompression" — care that can only follow the March 2024
// operation.
//
// So a year is judged against the document that produced it, and only two
// things may follow. If the record's own month and day are printed nearby with
// a year the document does attest, the date is corrected to that and the text
// it was read from is kept. Otherwise the date is refused, not replaced: an
// undated record routes to human review, where a misdated one asserts something
// false with a citation attached.
//
// A records production genuinely contains old care. That is why attestation is
// measured per document and relatively — a year the document prints hundreds of
// times is that document's business, however far it sits from the rest.
// ─────────────────────────────────────────────────────────────────────────────

/** Years a document prints, and how often. */
export interface YearProfile {
  counts: Map<number, number>;
  /** The most-printed year, or null for a document that prints none. */
  dominant: number | null;
  total: number;
}

/**
 * A year must reach this share of the document's most-printed year to be taken
 * as one the document genuinely covers.
 *
 * On the case that prompted this, the misread year sat at 0.9% of the dominant
 * one while the least-attested genuine year sat at 4%. One per cent leaves that
 * gap intact without pretending to more precision than the evidence supports.
 */
export const ATTESTED_SHARE = 0.01;

/** A year printed this many times is attested whatever the dominant year does. */
export const ATTESTED_FLOOR = 40;

const YEAR = /\b(?:19|20)\d{2}\b/g;

export function yearProfile(documentText: string): YearProfile {
  const counts = new Map<number, number>();
  for (const match of documentText.matchAll(YEAR)) {
    const year = Number(match[0]);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  let dominant: number | null = null;
  let best = 0;
  let total = 0;
  for (const [year, n] of counts) {
    total += n;
    if (n > best) {
      best = n;
      dominant = year;
    }
  }
  return { counts, dominant, total };
}

/** Does the document print this year often enough to be covering it? */
export function yearAttested(year: number, profile: YearProfile): boolean {
  const n = profile.counts.get(year) ?? 0;
  if (n >= ATTESTED_FLOOR) return true;
  if (!profile.dominant) return true; // A document printing no years contradicts nothing.
  const dominant = profile.counts.get(profile.dominant) ?? 0;
  return n >= dominant * ATTESTED_SHARE;
}

export type DateVerdict =
  | { verdict: "KEEP" }
  | { verdict: "RETIME"; iso: string; evidence: string }
  | { verdict: "UNTRUSTED"; reason: string };

/**
 * Judge a record's date against the document it came from.
 *
 * `nearbyText` is the document text around the record — the same span the entry
 * was written from. Passing the whole document would let a date anywhere in a
 * 284-page chart corroborate a record on any page of it.
 */
export function dateVerdict(date: Date, nearbyText: string, profile: YearProfile): DateVerdict {
  const year = date.getUTCFullYear();
  if (yearAttested(year, profile)) return { verdict: "KEEP" };

  // The same day of the same month, printed nearby under a year the document
  // does cover: the record's date as the page actually gives it.
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const corrected = sameDayNearby(nearbyText, month, day, profile, year);
  if (corrected) return { verdict: "RETIME", iso: corrected.iso, evidence: corrected.evidence };

  return {
    verdict: "UNTRUSTED",
    reason: `year ${year} appears ${profile.counts.get(year) ?? 0} times in a document dominated by ${profile.dominant}`,
  };
}

const NUMERIC_DATE = /\b(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)\d{2})\b|\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g;

function sameDayNearby(
  text: string,
  month: number,
  day: number,
  profile: YearProfile,
  reject: number,
): { iso: string; evidence: string } | null {
  const found = new Map<number, string>();
  for (const m of text.matchAll(NUMERIC_DATE)) {
    const [mm, dd, yyyy] = m[4]
      ? [Number(m[5]), Number(m[6]), Number(m[4])]
      : [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mm !== month || dd !== day) continue;
    if (yyyy === reject || !yearAttested(yyyy, profile)) continue;
    if (!found.has(yyyy)) found.set(yyyy, snippet(text, m.index ?? 0, m[0].length));
  }
  if (!found.size) return null;
  // Two attested years both printing this day is not evidence for either.
  if (found.size > 1) return null;
  const [year, evidence] = [...found.entries()][0];
  return { iso: `${year}-${pad(month)}-${pad(day)}`, evidence };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function snippet(text: string, at: number, length: number): string {
  return text
    .slice(Math.max(0, at - 60), at + length + 60)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
