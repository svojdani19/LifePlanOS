// ─────────────────────────────────────────────────────────────────────────────
// What a human decided outranks what the program would decide again.
//
// A rebuild read the claims and wrote a fresh summary for every record, every
// time. It never asked whether a reviewer had already written one. So a
// physician who corrected a summary, a provider name, a date or a
// classification saw the correction survive until the next document finished
// processing — at which point the case rebuilt and the correction was gone,
// replaced by newly phrased prose that looked just as confident.
//
// That is the worst failure mode this system has. A wrong summary is visible
// and fixable; a correction that silently reverts teaches a reviewer that their
// work does not stick, and there is no way to tell from the page that it
// happened.
//
// So: a row a human edited, reviewed or verified is authoritative. Its wording
// is reused verbatim rather than regenerated, and its corrected fields govern
// the entry. The program may still disagree — and when it does, the
// disagreement is surfaced for review rather than resolved by overwriting the
// human.
// ─────────────────────────────────────────────────────────────────────────────

/** Review states in which a human has put their name to the content. */
export const HUMAN_AUTHORED_STATES = ["HUMAN_EDITED", "REVIEWED", "VERIFIED"] as const;

/**
 * States where the content is the program's own work.
 *
 * AI_AUDIT_PASSED is here deliberately. An adversarial audit passing is the
 * program agreeing with itself, and treating that as review would let a case
 * present unreviewed content as reviewed.
 */
export const MACHINE_AUTHORED_STATES = ["AI_DRAFT", "AI_AUDIT_PASSED", "STALE"] as const;

export interface ReviewableRow {
  status?: string | null;
  factualSummary?: string | null;
  encounterDate?: Date | null;
  provider?: string | null;
  providerCredentials?: string | null;
  facility?: string | null;
  encounterType?: string | null;
  analysisClass?: string | null;
  substanceClass?: string | null;
  verifiedContentHash?: string | null;
}

/** Has a human put their name to this row's content? */
export function isHumanAuthored(row: ReviewableRow): boolean {
  return (HUMAN_AUTHORED_STATES as readonly string[]).includes(row.status ?? "");
}

export interface AuthoritativeFacts {
  /** The row whose human-authored wording governs, if any. */
  summary: string | null;
  encounterDate: Date | null;
  provider: string | null;
  providerCredentials: string | null;
  facility: string | null;
  encounterType: string | null;
  analysisClass: string | null;
  substanceClass: string | null;
  verifiedContentHash: string | null;
  /** The states the contributing rows were in, for the audit trail. */
  states: string[];
}

/**
 * The human-authoritative facts among the rows an entry was folded from.
 *
 * An entry can absorb several rows, and only some may be reviewed. The most
 * strongly reviewed row governs: VERIFIED over REVIEWED over HUMAN_EDITED. Two
 * rows at the same standing are resolved by source order, which is stable
 * across rebuilds — picking by recency would make the output depend on when the
 * rebuild ran.
 */
export function authoritativeFacts(rows: readonly ReviewableRow[]): AuthoritativeFacts | null {
  const authored = rows.filter(isHumanAuthored);
  if (!authored.length) return null;

  const rank = (row: ReviewableRow) => {
    const at = (HUMAN_AUTHORED_STATES as readonly string[]).indexOf(row.status ?? "");
    return at < 0 ? -1 : at;
  };
  const governing = authored.reduce((best, row) => (rank(row) > rank(best) ? row : best), authored[0]);

  return {
    // Only non-empty wording governs. A reviewer who cleared a field did not
    // thereby author an empty summary.
    summary: governing.factualSummary?.trim() || null,
    encounterDate: governing.encounterDate ?? null,
    provider: governing.provider?.trim() || null,
    providerCredentials: governing.providerCredentials?.trim() || null,
    facility: governing.facility?.trim() || null,
    encounterType: governing.encounterType?.trim() || null,
    analysisClass: governing.analysisClass?.trim() || null,
    substanceClass: governing.substanceClass?.trim() || null,
    verifiedContentHash: governing.verifiedContentHash ?? null,
    states: [...new Set(authored.map((r) => r.status ?? ""))].filter(Boolean),
  };
}

/**
 * A claim the human summary does not account for.
 *
 * Raised, never acted on. If the source says something the corrected summary
 * omits, that is a question for a reviewer — possibly the reviewer trimmed
 * noise, possibly the extractor found something they had not seen. What must
 * not happen is the program deciding the human was wrong and rewriting them.
 */
export interface ClaimDiscrepancy {
  field: string;
  value: string;
}

const STOP = new Set(["the", "a", "an", "of", "and", "with", "for", "was", "were", "patient", "his", "her", "their"]);

export function claimDiscrepancies(
  summary: string,
  claims: readonly { field: string; value: string }[],
  opts: { limit?: number } = {},
): ClaimDiscrepancy[] {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    );
  const inSummary = words(summary);
  const out: ClaimDiscrepancy[] = [];

  for (const claim of claims) {
    const terms = [...words(claim.value)];
    if (!terms.length) continue;
    const covered = terms.filter((t) => inSummary.has(t)).length / terms.length;
    // A claim the summary does not touch at all. A partially covered claim is
    // ordinary summarising and is not worth a reviewer's attention.
    if (covered === 0) out.push({ field: claim.field, value: claim.value });
    if (out.length >= (opts.limit ?? 10)) break;
  }
  return out;
}
