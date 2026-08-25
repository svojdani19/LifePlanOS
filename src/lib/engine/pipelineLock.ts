import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// One plan generation per case at a time, held through the WHOLE pipeline.
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
//
// ── Why the lease renews ─────────────────────────────────────────────────────
//
// A fixed 15-minute staleness window has to do two incompatible jobs: recover
// from a process that died mid-run, and not interrupt one that is merely slow.
// A large case can exceed it legitimately, and when it did, a second caller
// took the lock from a run that was still writing — reintroducing exactly the
// concurrency this module exists to prevent, on precisely the cases where it
// does the most damage.
//
// So a live holder renews its claim on a timer. Renewal is scoped to the
// holder's own run id, so it cannot resurrect a claim somebody else has taken.
// If a renewal ever finds the claim is no longer ours, that is not a warning:
// the work in flight is now racing another run, and everything after it fails
// closed rather than writing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a claim stays honoured WITHOUT renewal before another caller may
 * take it. A live holder renews well inside this, so reaching it means the
 * holder stopped renewing — it died, or it lost the event loop entirely.
 */
export const PIPELINE_LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * How often a live holder renews. Comfortably inside the staleness window, so
 * several consecutive renewals can fail before anyone may take the lock.
 */
export const PIPELINE_LEASE_RENEW_MS = 60 * 1000;

/**
 * A runaway guard, NOT a coalescing budget.
 *
 * The loop below runs until the rerun flag is clear, because anything else
 * strands work. An earlier version capped coalesced passes at three and left
 * the flag set "for the next caller" — but every losing caller has already
 * returned PipelineBusyError, and the two background callers swallow it. If an
 * edit arrived during the last allowed pass and nothing else happened to fire,
 * that edit was never regenerated, and nothing anywhere was waiting to notice.
 *
 * This bound exists only so a bug that sets the flag without a corresponding
 * edit cannot spin forever. Reaching it is a fault and is raised as one; the
 * obligation is left set rather than discarded.
 */
export const MAX_PIPELINE_PASSES = 50;

/** A run was already in flight; this caller's work was folded into it. */
export class PipelineBusyError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`Plan generation is already running for case ${caseId}; this request was folded into that run.`);
    this.name = "PipelineBusyError";
    this.caseId = caseId;
  }
}

/**
 * The rerun flag stayed set across {@link MAX_PIPELINE_PASSES} complete passes.
 *
 * Not a coalescing outcome — a fault. Something is setting the flag without a
 * corresponding edit. The obligation is deliberately LEFT SET so it survives
 * for whoever looks next.
 */
export class PipelineRerunOverflowError extends Error {
  readonly caseId: string;
  readonly passes: number;
  constructor(caseId: string, passes: number) {
    super(`Plan generation for case ${caseId} ran ${passes} complete passes and the case was still marked out of date; refusing to loop further.`);
    this.name = "PipelineRerunOverflowError";
    this.caseId = caseId;
    this.passes = passes;
  }
}

/**
 * The lock was taken from us while we were working.
 *
 * Distinct from PipelineBusyError: that one means we never started. This one
 * means another run is now writing the same case underneath us, so anything we
 * have not yet written must not be written.
 */
export class PipelineLeaseLostError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`Lost the plan-generation lease for case ${caseId}; the run was abandoned rather than allowed to race.`);
    this.name = "PipelineLeaseLostError";
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

/** The holder's handle on its own claim, passed to the work it guards. */
export interface PipelineLease {
  /** This holder's token. Every write scoped to the lock uses it. */
  readonly runId: string;
  /** False once a renewal has found the claim is no longer ours. */
  owned(): boolean;
  /**
   * Throw unless the claim is still ours.
   *
   * Call before any further write. A long stage that completes after ownership
   * was lost must not persist: another run is writing the same case.
   */
  assertOwned(): void;
}

export interface PipelineLockOptions {
  now?: () => Date;
  /** Renewal period. Set to 0 to disable renewal (tests that drive it directly). */
  heartbeatMs?: number;
  /** Injected for tests; defaults to the global timers. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

/**
 * Renew a claim, scoped to its own run id.
 *
 * Returns false when the claim is no longer ours — taken by a stale-takeover,
 * or the case is gone. Never re-acquires: a renewal that could take the lock
 * back would defeat the takeover that the staleness window exists to allow.
 */
export async function renewPipelineLease(
  db: CaseLockStore,
  caseId: string,
  runId: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const { count } = await db.case.updateMany({
    where: { id: caseId, pipelineRunId: runId },
    data: { pipelineRunAt: now() },
  });
  return count === 1;
}

/**
 * Run `work` with exclusive ownership of the case's plan pipeline.
 *
 * Contention does not queue and does not run concurrently. It records that the
 * plan is out of date and throws {@link PipelineBusyError}; the holder makes
 * one more pass before releasing, so the losing caller's edit still reaches the
 * plan. Background callers should swallow that error — the work is not lost.
 *
 * `work` is ONE COMPLETE PASS. Whatever the caller needs done under the lock —
 * generation and every finalizer that must see its output — belongs inside it,
 * because the coalescing loop below re-runs exactly this unit.
 */
export async function withCasePipelineLock<T>(
  db: CaseLockStore,
  caseId: string,
  work: (lease: PipelineLease) => Promise<T>,
  options: PipelineLockOptions | (() => Date) = {},
): Promise<T> {
  // Back-compat: earlier callers passed a bare `now` function here.
  const opts: PipelineLockOptions = typeof options === "function" ? { now: options } : options;
  const now = opts.now ?? (() => new Date());
  const heartbeatMs = opts.heartbeatMs ?? PIPELINE_LEASE_RENEW_MS;
  const timers = opts.scheduler ?? { setInterval: (fn: () => void, ms: number) => setInterval(fn, ms), clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) };

  const runId = randomUUID();
  const staleBefore = new Date(now().getTime() - PIPELINE_LOCK_STALE_MS);

  const claim = await db.case.updateMany({
    // Free, or abandoned by a holder that stopped renewing. `pipelineRunAt:
    // null` with a non-null runId cannot happen — they are always written
    // together — but the OR is written against the runId so a row that predates
    // this column (NULL runId, NULL runAt) is claimable.
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

  let stillOwned = true;
  const lease: PipelineLease = {
    runId,
    owned: () => stillOwned,
    assertOwned: () => {
      if (!stillOwned) throw new PipelineLeaseLostError(caseId);
    },
  };

  // The heartbeat is fire-and-forget by necessity — it runs on a timer, not in
  // the await chain — so its ONLY job is to flip `stillOwned`. Everything that
  // acts on that flag does so synchronously, at a point where throwing is safe.
  let handle: unknown = null;
  if (heartbeatMs > 0) {
    handle = timers.setInterval(() => {
      void renewPipelineLease(db, caseId, runId, now)
        .then((ok) => {
          if (!ok) stillOwned = false;
        })
        // A renewal that fails to reach the database is NOT ownership loss:
        // the claim stands until the staleness window expires. Treating a
        // transient error as loss would abandon healthy runs.
        .catch(() => {});
    }, heartbeatMs);
  }

  try {
    let result = await work(lease);
    lease.assertOwned();
    // ── Continue until stable ────────────────────────────────────────────────
    // The exit condition is "the flag is clear", not "we have done N passes".
    // While we hold the lease we are the ONLY thing that can honour the flag —
    // every losing caller has already returned — so returning with it set
    // loses that caller's edit outright.
    //
    // This terminates because each pass clears the flag BEFORE doing its work:
    // the flag can only be set again by an edit arriving DURING that pass, so
    // once edits stop, the next check finds it clear. Continuous editing keeps
    // it looping, which is correct — the plan genuinely is out of date each
    // time — and the heartbeat keeps the lease alive while that happens.
    let passes = 1;
    for (;;) {
      const state = await db.case.findUnique({
        where: { id: caseId },
        select: { pipelineRunId: true, pipelineRerunRequested: true },
      });
      // Not ours any more (stale takeover, or the case is gone): the new holder
      // owns the rerun obligation, and the flag is still set for it. Do not run
      // — that would be two runs again.
      if (!state || state.pipelineRunId !== runId) break;
      if (!state.pipelineRerunRequested) break;
      if (passes >= MAX_PIPELINE_PASSES) {
        // Deliberately WITHOUT clearing the flag: the obligation survives, and
        // the fault is raised rather than absorbed.
        throw new PipelineRerunOverflowError(caseId, passes);
      }
      // Clear the flag BEFORE the pass, so an edit arriving during it sets the
      // flag again and earns its own pass rather than being absorbed by this one.
      const held = await db.case.updateMany({
        where: { id: caseId, pipelineRunId: runId },
        data: { pipelineRerunRequested: false, pipelineRunAt: now() },
      });
      if (held.count !== 1) break;
      passes += 1;
      result = await work(lease);
      lease.assertOwned();
    }
    return result;
  } finally {
    // Always, on every path — a leaked interval keeps a dead run's claim alive
    // forever, which is strictly worse than no renewal at all.
    if (handle !== null) timers.clearInterval(handle);
    // Scoped to our runId: if a stale takeover happened mid-run, the new
    // holder's claim must not be cleared by this one's release.
    await db.case.updateMany({
      where: { id: caseId, pipelineRunId: runId },
      data: { pipelineRunId: null, pipelineRunAt: null },
    });
  }
}
