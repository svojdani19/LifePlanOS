// ─────────────────────────────────────────────────────────────────────────────
// Dates carried by a record's FILENAME ("Lum MRI Report 06.02.25.pdf").
//
// This is never a documented fact: the filename is applied by whoever received
// or scanned the record, not by the clinician who wrote it. It is therefore
// only ever offered as a SUGGESTION for a human to confirm against the source —
// never written as an encounter date, and never used to fill a gap silently.
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reject values that cannot be a service date for a record on file. */
function plausible(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (y < 1990) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  return dt.getTime() <= Date.now() + 86_400_000;
}

/**
 * Extract a suggested ISO date from a filename, or null. Ambiguous or
 * implausible values yield null rather than a guess — a wrong suggestion costs
 * a reviewer more than an absent one.
 */
export function dateFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const name = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
  const pad = (n: number) => String(n).padStart(2, "0");
  const hits: string[] = [];

  // 06.02.25 / 6-2-2025 / 06_02_25 (month-first, as US records are named)
  for (const m of name.matchAll(/\b(\d{1,2})[._/-](\d{1,2})[._/-](\d{2,4})\b/g)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const raw = Number(m[3]);
    const y = m[3].length === 2 ? raw + (raw > 50 ? 1900 : 2000) : raw;
    if (plausible(y, mo, d)) hits.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  // 2025-06-02
  for (const m of name.matchAll(/\b(\d{4})[._/-](\d{1,2})[._/-](\d{1,2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (plausible(y, mo, d)) hits.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  // June 2 2025 / Jun 2, 2025
  for (const m of name.matchAll(/\b([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/g)) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (mi >= 0 && plausible(y, mi + 1, d)) hits.push(`${y}-${pad(mi + 1)}-${pad(d)}`);
  }

  const unique = [...new Set(hits)];
  // A filename naming a RANGE ("2.27.25-4.3.25") is ambiguous about which date
  // an individual encounter belongs to — suggest nothing rather than guess.
  return unique.length === 1 ? unique[0] : null;
}
