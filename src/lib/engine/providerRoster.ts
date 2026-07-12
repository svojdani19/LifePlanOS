// ─────────────────────────────────────────────────────────────────────────────
// Treating-provider roster (EPIC-011). Pure extraction of the providers
// affiliated with a case's care from the records we already parse — document
// authors, multi-provider lists, and chronology providers — deduplicated by a
// normalized name. Produces SUGGESTED entries the user then curates. NO new
// inference or network; only structured fields already populated by ingestion.
// ─────────────────────────────────────────────────────────────────────────────

export interface DocForRoster {
  id: string;
  filename: string;
  authorName?: string | null;
  authorCredentials?: string | null;
  authorRole?: string | null;
  facility?: string | null;
  providers?: unknown; // [{ name, credentials, role, pages }]
}
export interface ChronoForRoster {
  provider?: string | null;
  facility?: string | null;
  sourcePage?: number | null;
  sourceDocumentId?: string | null;
}

export interface ExtractedProvider {
  name: string;
  nameKey: string;
  credentials: string | null;
  specialty: string | null;
  facility: string | null;
  sourceDocumentIds: { documentId: string | null; filename: string | null; pages: number[] }[];
}

// A person name we can attribute care to (not a facility/label). Requires at
// least two Title-Case words, and rejects obvious org/metadata tokens.
const ORGISH = /\b(hospital|center|centre|clinic|medical|associates|institute|imaging|radiology|laboratory|\blab\b|health|services|group|department|pharmacy|unknown|provider|patient|facility|records?)\b/i;
function isPersonName(raw: string): boolean {
  const s = raw.replace(/,.*$/, "").trim(); // drop a trailing ", MD …"
  if (ORGISH.test(raw)) return false;
  const words = s.match(/\b[A-Z][a-zA-Z.'-]+/g) ?? [];
  return words.length >= 2 && words.length <= 5;
}
// Normalize a provider name for dedupe/reconciliation: drop credentials,
// punctuation, and case; collapse to "first last" order-insensitive-ish.
export function normalizeProviderName(raw: string): string {
  const base = raw
    .replace(/\b(MD|DO|PT|DPT|RN|PA-?C?|NP|PhD|PharmD|DC|OD|DDS|MPT|OTR|MS|MSN)\b/gi, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const words = base.split(" ").filter(Boolean);
  return words.sort().join(" ");
}
// Split a "Name, CRED — Role" style string, or the parsed fields, into parts.
function parseCredentials(raw: string): { name: string; credentials: string | null } {
  const m = raw.match(/^(.*?),\s*([A-Za-z.\s/-]+?)(?:\s*[—–-]\s*.*)?$/);
  if (m) return { name: m[1].trim(), credentials: m[2].trim() };
  return { name: raw.trim(), credentials: null };
}

/**
 * Extract the deduplicated provider roster from a case's documents & chronology.
 * Merges multiple appearances into one entry with all source documents/pages.
 */
export function extractProviders(docs: DocForRoster[], chronology: ChronoForRoster[]): ExtractedProvider[] {
  const byKey = new Map<string, ExtractedProvider>();
  const add = (rawName: string, credentials: string | null, specialty: string | null, facility: string | null, docId: string | null, filename: string | null, pages: number[]) => {
    if (!rawName || !isPersonName(rawName)) return;
    const parsed = parseCredentials(rawName);
    const name = parsed.name;
    const nameKey = normalizeProviderName(name);
    if (!nameKey) return;
    const existing = byKey.get(nameKey);
    if (existing) {
      existing.credentials = existing.credentials ?? credentials ?? parsed.credentials;
      existing.specialty = existing.specialty ?? specialty;
      existing.facility = existing.facility ?? facility;
      const src = existing.sourceDocumentIds.find((s) => s.documentId === docId);
      if (src) src.pages = [...new Set([...src.pages, ...pages])].sort((a, b) => a - b);
      else if (docId || filename) existing.sourceDocumentIds.push({ documentId: docId, filename, pages });
    } else {
      byKey.set(nameKey, { name, nameKey, credentials: credentials ?? parsed.credentials, specialty, facility, sourceDocumentIds: docId || filename ? [{ documentId: docId, filename, pages }] : [] });
    }
  };

  for (const d of docs) {
    if (d.authorName) add(d.authorName, d.authorCredentials ?? null, d.authorRole ?? null, d.facility ?? null, d.id, d.filename, []);
    const provs = (Array.isArray(d.providers) ? d.providers : []) as { name?: string; credentials?: string | null; role?: string | null; pages?: number[] }[];
    for (const p of provs) if (p?.name) add(p.name, p.credentials ?? null, p.role ?? null, d.facility ?? null, d.id, d.filename, Array.isArray(p.pages) ? p.pages : []);
  }
  for (const e of chronology) {
    if (e.provider) add(e.provider, null, null, e.facility ?? null, e.sourceDocumentId ?? null, null, e.sourcePage ? [e.sourcePage] : []);
  }
  // Present the most-documented providers first.
  return [...byKey.values()].sort((a, b) => b.sourceDocumentIds.length - a.sourceDocumentIds.length);
}

/**
 * Reconcile freshly-extracted providers against the existing curated roster:
 * return the NEW suggestions to insert (not already present). Existing rows —
 * especially CONFIRMED or interviewed ones — are preserved by the caller; this
 * only computes what to add.
 */
export function newSuggestions(extracted: ExtractedProvider[], existingKeys: Set<string>): ExtractedProvider[] {
  return extracted.filter((p) => !existingKeys.has(p.nameKey));
}
