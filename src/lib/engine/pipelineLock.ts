import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// One plan generation per case at a time.
//
// `generatePlan` is a long read-reset-write. It snapshots the prior plan,
// clears conditions and unreviewed care items in one transaction, then spends
// seconds reading every document and locating each condition's evidence before
// writing the replacement rows in a second, much later transaction. The window
// between the reset and the writes is the whole body of the function.
//
// Three call sites fire it in the background — two of them un-awaited — when a
// records reviewer publishes or corrects a note. A reviewer working a queue
// therefore launched overlapping runs. Each one reset what it had snapshotted
// and then wrote a complete plan, so the resets all landed before any of the
// writes and every run's output survived: one case held each of its nine
// diagnoses and each of its thirty-four care items three times over.
//
// The reclassification route already had the right idea — fold a request that
// arrives mid-run into the run in flight, then make one more pass — but it kept
// that state in a module-level `Map`. A Map guards one call site inside one
// process. It cannot see the other two call sites, and it cannot see a second
// worker. The state has to live where every writer can see it, which is the
// database.
//
// The claim is a single conditional UPDATE. Postgres serializes concurrent
// updates to the same row and re-evaluates the WHERE clause against the
// committed result, so of N callers that find the lock free, exactly one gets
// `count === 1`. That is the entire mutual-exclusion argument.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a claim stays honoured before another caller may take it. A process
 * killed mid-run cannot release its own lock, so without a takeover the case
 * would never regenerate again. Long enough to exceed any real run; short
 * enough that a crash costs one window, not a support call.
 */
export const PIPELINE_LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * Ceiling on coalesced passes, so a case being edited continuously cannot pin a
 * worker indefinitely. Hitting it is not data loss: the rerun flag stays set and
 * the next caller picks it up.
 */
export const MAX_COALESCED_RERUNS = 3;

/** A run was already in flight; this caller's work was folded into it. */
export class PipelineBusyError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`Plan generation is already running for case ${caseId}; this request was folded into that run.`);
    this.name = "PipelineBusyError";
    this.caseId = caseId;
  }
}

/** The slice of Prisma this needs — keeps the helper testable without a database. */
export interface CaseLockStore {
  case: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: Record<string, boolean>;
    }): Promise<{ pipelineRunId?: string | null; pipelineRerunRequested?: boolean | null } | null>;
  };
}

/**
 * Run `work` with exclusive ownership of the case's plan pipeline.
 *
 * Contention does not queue and does not run concurrently. It records that the
 * plan is out of date and throws {@link PipelineBusyError}; the holder makes
 * one more pass before releasing, so the losing caller's edit still reaches the
 * plan. Background callers should swallow that error — the work is not lost.
 */
export async function withCasePipelineLock<T>(
  db: CaseLockStore,
  caseId: string,
  work: () => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> {
  const runId = randomUUID();
  const staleBefore = new Date(now().getTime() - PIPELINE_LOCK_STALE_MS);

  const claim = await db.case.updateMany({
    // Free, or abandoned by a holder that died. `pipelineRunAt: null` with a
    // non-null runId cannot happen — they are always written together — but the
    // OR is written against the runId so a row that predates this column
    // (NULL runId, NULL runAt) is claimable.
    where: { id: caseId, OR: [{ pipelineRunId: null }, { pipelineRunAt: { lt: staleBefore } }] },
    data: { pipelineRunId: runId, pipelineRunAt: now(), pipelineRerunRequested: false },
  });

  if (claim.count !== 1) {
    // A claim can fail for two very different reasons, and conflating them
    // would turn "this case no longer exists" into a PipelineBusyError that
    // every background caller silently swallows. Contention is expected and
    // benign; a missing case is a real fault and must surface.
    const exists = await db.case.findUnique({ where: { id: caseId }, select: { pipelineRunId: true } });
    if (!exists) throw new Error(`Cannot generate a plan for case ${caseId}: no such case.`);
    // Someone else holds it. Running anyway is precisely the bug this exists to
    // prevent, so leave a note for the holder instead.
    await db.case.updateMany({ where: { id: caseId }, data: { pipelineRerunRequested: true } });
    throw new PipelineBusyError(caseId);
  }

  try {
    let result = await work();
    for (let pass = 0; pass < MAX_COALESCED_RERUNS; pass += 1) {
      const state = await db.case.findUnique({
        where: { id: caseId },
        select: { pipelineRunId: true, pipelineRerunRequested: true },
      });
      // Not ours any more (stale takeover, or the case is gone): the new holder
      // owns the rerun obligation. Do not run — that would be two runs again.
      if (!state || state.pipelineRunId !== runId || !state.pipelineRerunRequested) break;
      // Clear the flag BEFORE the pass, so an edit arriving during it sets the
      // flag again and earns its own pass rather than being absorbed by this one.
      const held = await db.case.updateMany({
        where: { id: caseId, pipelineRunId: runId },
        data: { pipelineRerunRequested: false, pipelineRunAt: now() },
      });
      if (held.count !== 1) break;
      result = await work();
    }
    return result;
  } finally {
    // Scoped to our runId: if a stale takeover happened mid-run, the new
    // holder's claim must not be cleared by this one's release.
    await db.case.updateMany({
      where: { id: caseId, pipelineRunId: runId },
      data: { pipelineRunId: null, pipelineRunAt: null },
    });
  }
}
