// ─────────────────────────────────────────────────────────────────────────────
// Data-retention engine (Enterprise). A firm may set dataRetentionDays: PHI
// held for a CLOSED or ARCHIVED case is purged once the case has been inactive
// that long. Deliberately narrow about WHAT is purged:
//   purged   — stored record files (object storage), extracted/OCR text,
//              parsed segments, verbatim source quotes on chronology events
//   retained — the case shell, chronology summaries, diagnoses, the plan,
//              validation findings, export METADATA, and the append-only
//              audit trail (the legal record of what was done and when)
// Active cases are never touched, whatever their age. The candidate logic is
// pure and tested; the enforcement script wraps it with storage deletes and
// audit events.
// ─────────────────────────────────────────────────────────────────────────────

export interface RetentionCaseInput {
  id: string;
  status: string;
  /** last activity on the case */
  updatedAt: Date;
}

const PURGEABLE_STATUSES = new Set(["CLOSED", "ARCHIVED"]);
export const MIN_RETENTION_DAYS = 30;

/** Normalize a configured retention window. Null/undefined = retain forever;
 *  anything below the floor clamps up so a typo cannot mass-purge a firm. */
export function normalizeRetentionDays(days: number | null | undefined): number | null {
  if (days == null || !Number.isFinite(days)) return null;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(days));
}

/** The cases whose PHI is past the firm's retention window. Pure. */
export function retentionCandidates<T extends RetentionCaseInput>(now: Date, retentionDays: number | null | undefined, cases: T[]): T[] {
  const days = normalizeRetentionDays(retentionDays);
  if (days == null) return [];
  const cutoff = now.getTime() - days * 24 * 3600 * 1000;
  return cases.filter((c) => PURGEABLE_STATUSES.has(c.status) && c.updatedAt.getTime() < cutoff);
}
