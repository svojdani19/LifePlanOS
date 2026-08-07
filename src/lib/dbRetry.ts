// ─────────────────────────────────────────────────────────────────────────────
// Transient database-failure retry.
//
// The extraction pipeline already retries transient PROVIDER failures, because
// a model that is briefly overloaded should cost a chunk a retry rather than a
// document its run. The database had no equivalent — and on a serverless
// Postgres (Neon) the database is the flakier of the two: a sweep over a real
// case file lost nine documents in a row, every one of them at its FIRST query,
// before any extraction work had begun. The connection pool was refusing
// connections under sustained load; nothing was wrong with the documents.
//
// The same blip behind an API request would fail a document mid-run and hand
// the caller an error. The run-lifecycle work makes that recoverable — the run
// stays unfinished and resumable rather than vanishing — but recoverable is
// not the same as recovered.
//
// WHAT MAY BE RETRIED
// Reads and idempotent updates retry freely. A CREATE is different: if the
// insert actually committed and the connection dropped before the
// acknowledgement, a blind retry writes the row twice. Creates therefore take
// an `existing` probe, so the retry asks "did my write land?" before repeating
// it. A caller that cannot answer that question must not retry its create, and
// the absence of a probe is the signal to fail instead.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";

/**
 * Prisma error codes that mean "the connection or the server, not your query".
 *   P1000 authentication failed          P1008 operation timed out
 *   P1001 cannot reach the database      P1017 server closed the connection
 *   P1002 connection timed out           P2024 timed out fetching from the pool
 * P1000 is deliberately absent: bad credentials never fix themselves, and
 * retrying them just delays a clear failure.
 */
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

const TRANSIENT_MESSAGE =
  /can'?t reach database|connection (?:closed|reset|refused|terminated|lost)|server has closed the connection|timed out fetching|connection pool|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|Connection terminated/i;

/** Is this failure worth trying again, or is it the query's own fault? */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? "");
  return TRANSIENT_MESSAGE.test(message);
}

export interface DbRetryOptions {
  /** Backoff schedule in ms; its length is the number of RETRIES. */
  backoffs?: number[];
  /**
   * For a CREATE: resolves to the row if the write already landed, null if it
   * did not. Without it a create is not retried at all — writing a duplicate
   * encounter is worse than surfacing the error.
   */
  existing?: () => Promise<unknown>;
  /** Reviewer-facing label used in the thrown message. */
  label?: string;
}

const DEFAULT_BACKOFFS = [1_000, 4_000, 10_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a database operation, retrying transient connection failures with
 * backoff. A non-transient error is rethrown immediately — a constraint
 * violation or a bad query is not going to succeed on the second attempt.
 */
export async function withDbRetry<T>(op: () => Promise<T>, options: DbRetryOptions = {}): Promise<T> {
  const backoffs = options.backoffs ?? DEFAULT_BACKOFFS;
  let last: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await op();
    } catch (err) {
      last = err;
      if (!isTransientDbError(err) || attempt === backoffs.length) throw err;

      // A create can only be retried when the caller can tell us whether the
      // first attempt actually landed.
      if (options.existing) {
        const already = await options.existing().catch(() => null);
        if (already != null) return already as T;
      }

      await sleep(backoffs[attempt]);
      // Force a fresh connection: the pool's handle is the thing that failed.
      await prisma.$connect().catch(() => {});
    }
  }
  throw last;
}

/**
 * A create that is safe to retry: the probe decides whether the row already
 * exists before the insert is repeated. Callers that cannot express such a
 * probe should use withDbRetry without one and accept a hard failure.
 */
export async function createWithDbRetry<T>(create: () => Promise<T>, existing: () => Promise<T | null>, label?: string): Promise<T> {
  return withDbRetry(create, { existing: existing as () => Promise<unknown>, label });
}
