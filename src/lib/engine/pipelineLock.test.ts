import { describe, it, expect } from "vitest";
import {
  withCasePipelineLock,
  renewPipelineLease,
  PipelineBusyError,
  PipelineLeaseLostError,
  PIPELINE_LOCK_STALE_MS,
  MAX_PIPELINE_PASSES,
  PipelineRerunOverflowError,
  type CaseLockStore,
} from "@/lib/engine/pipelineLock";

// ─────────────────────────────────────────────────────────────────────────────
// The defect these cover, precisely:
//
// `generatePlan` clears the plan, spends seconds locating evidence, then writes
// the replacement. Nothing serialized it, and records review fires it in the
// background on every published note. Overlapping runs each cleared what they
// had snapshotted and each wrote a full plan — so one case ended up holding
// each of its nine diagnoses and each of its thirty-four care items three
// times over.
//
// The store below is a real row, not a stub that returns whatever the test
// wants: `updateMany` evaluates the same predicate Postgres would, so "exactly
// one of N concurrent claimants wins" is something these tests observe rather
// than assume.
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  pipelineRunId: string | null;
  pipelineRunAt: Date | null;
  pipelineRerunRequested: boolean;
}

/**
 * A single-row stand-in for `Case` that enforces the predicate semantics the
 * lock depends on. Writes are applied synchronously between awaits, which is
 * what makes Postgres' row-level serialization faithful here: two claimants
 * cannot both observe the row as free.
 */
function makeStore(initial?: Partial<Row>) {
  const row: Row = {
    id: "case-1",
    pipelineRunId: null,
    pipelineRunAt: null,
    pipelineRerunRequested: false,
    ...initial,
  };
  const store: CaseLockStore & { row: Row } = {
    row,
    case: {
      async updateMany({ where, data }) {
        if (where.id !== undefined && where.id !== row.id) return { count: 0 };
        if (where.pipelineRunId !== undefined && where.pipelineRunId !== row.pipelineRunId) return { count: 0 };
        const or = where.OR as { pipelineRunId?: null; pipelineRunAt?: { lt: Date } }[] | undefined;
        if (or) {
          const free = or.some((clause) => {
            if ("pipelineRunId" in clause) return row.pipelineRunId === null;
            if (clause.pipelineRunAt) return row.pipelineRunAt !== null && row.pipelineRunAt < clause.pipelineRunAt.lt;
            return false;
          });
          if (!free) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      async findUnique() {
        return { pipelineRunId: row.pipelineRunId, pipelineRerunRequested: row.pipelineRerunRequested };
      },
    },
  };
  return store;
}

describe("withCasePipelineLock", () => {
  it("runs the work and releases the lock", async () => {
    const store = makeStore();
    const result = await withCasePipelineLock(store, "case-1", async () => "done");
    expect(result).toBe("done");
    expect(store.row.pipelineRunId).toBeNull();
    expect(store.row.pipelineRunAt).toBeNull();
  });

  it("holds the lock for the duration of the work", async () => {
    const store = makeStore();
    let heldDuringWork: string | null = null;
    await withCasePipelineLock(store, "case-1", async () => {
      heldDuringWork = store.row.pipelineRunId;
    });
    expect(heldDuringWork).not.toBeNull();
  });

  // Control for the test below. A concurrency assertion is worthless if the
  // harness cannot observe concurrency in the first place, so this runs the
  // identical bodies with no lock and requires that it sees all three at once —
  // which is exactly the behaviour that tripled the plan.
  it("control: the same three bodies overlap when nothing serializes them", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const body = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      concurrent -= 1;
    };
    await Promise.all([body(), body(), body()]);
    expect(maxConcurrent).toBe(3);
  });

  // THE regression. Without the lock all three of these run their bodies, and
  // three complete plans get written over one another.
  it("lets exactly one of three concurrent callers run, whatever the interleaving", async () => {
    const store = makeStore();
    let concurrent = 0;
    let maxConcurrent = 0;
    const ran: string[] = [];

    const attempt = (label: string) =>
      withCasePipelineLock(store, "case-1", async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Yield repeatedly: this is the reset-then-write window that the real
        // generator spends seconds inside.
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        ran.push(label);
        concurrent -= 1;
      }).catch((e) => {
        if (e instanceof PipelineBusyError) return "busy";
        throw e;
      });

    const outcomes = await Promise.all([attempt("a"), attempt("b"), attempt("c")]);

    expect(maxConcurrent).toBe(1);
    expect(outcomes.filter((o) => o === "busy")).toHaveLength(2);
    // The winner owes one more pass because the losers asked for one, so it
    // runs twice — but never at the same time as anything else.
    expect(new Set(ran).size).toBe(1);
  });

  it("does not drop a losing caller's work: it flags a rerun and the holder makes another pass", async () => {
    const store = makeStore();
    let passes = 0;
    await withCasePipelineLock(store, "case-1", async () => {
      passes += 1;
      // An edit lands mid-run, exactly as a second reviewer decision would.
      if (passes === 1) {
        await withCasePipelineLock(store, "case-1", async () => {
          throw new Error("the second caller must not run its body");
        }).catch((e) => {
          expect(e).toBeInstanceOf(PipelineBusyError);
        });
      }
    });
    expect(passes).toBe(2);
    expect(store.row.pipelineRerunRequested).toBe(false);
  });

  it("clears the rerun flag before the extra pass, so an edit during it earns its own pass", async () => {
    const store = makeStore();
    const flagsAtEntry: boolean[] = [];
    let passes = 0;
    await withCasePipelineLock(store, "case-1", async () => {
      passes += 1;
      flagsAtEntry.push(store.row.pipelineRerunRequested);
      if (passes <= 2) store.row.pipelineRerunRequested = true;
    });
    // Pass 1 and each extra pass start with a clear flag; had it been cleared
    // after the pass instead, the edit arriving during pass 2 would have been
    // wiped and never regenerated.
    expect(flagsAtEntry).toEqual([false, false, false]);
    expect(passes).toBe(3);
  });

  // THE stranding regression.
  //
  // The previous contract capped coalesced passes and left the flag set "for
  // the next caller". There is no next caller: every loser has already returned
  // PipelineBusyError, and both background callers swallow it. An edit arriving
  // during the last allowed pass was simply never regenerated.
  it("keeps going until the case is stable, past any former cap, with no new caller", async () => {
    const store = makeStore();
    let passes = 0;
    // Set the flag on every pass well beyond the old cap of 3, then stop.
    const OBLIGATIONS = 9;
    await withCasePipelineLock(store, "case-1", async () => {
      passes += 1;
      if (passes <= OBLIGATIONS) store.row.pipelineRerunRequested = true;
    });
    // Every obligation was honoured by THIS holder…
    expect(passes).toBe(OBLIGATIONS + 1);
    // …and it did not return owing anything.
    expect(store.row.pipelineRerunRequested).toBe(false);
    expect(store.row.pipelineRunId).toBeNull();
  });

  it("never returns while it still holds the lease and still owes a pass", async () => {
    const store = makeStore();
    let passes = 0;
    await withCasePipelineLock(store, "case-1", async () => {
      passes += 1;
      // Edits land through pass 4 — the last one arriving during what would
      // have been the final pass under the old cap of 3.
      if (passes <= 4) store.row.pipelineRerunRequested = true;
    });
    expect(passes).toBe(5);
    expect(store.row.pipelineRerunRequested).toBe(false);
  });

  it("raises a fault rather than looping forever, and does NOT discard the obligation", async () => {
    const store = makeStore();
    let passes = 0;
    await expect(
      withCasePipelineLock(store, "case-1", async () => {
        passes += 1;
        store.row.pipelineRerunRequested = true; // never satisfied — a bug, not editing
      }),
    ).rejects.toBeInstanceOf(PipelineRerunOverflowError);
    expect(passes).toBe(MAX_PIPELINE_PASSES);
    // Left set on purpose: the work is still owed, and the condition is loud.
    expect(store.row.pipelineRerunRequested).toBe(true);
    // The lock is still released, so the case is not wedged.
    expect(store.row.pipelineRunId).toBeNull();
  });

  it("hands the obligation to a stale takeover rather than dropping it", async () => {
    const store = makeStore();
    let passes = 0;
    await withCasePipelineLock(store, "case-1", async () => {
      passes += 1;
      store.row.pipelineRerunRequested = true;
      // Ownership moves away mid-run: the new holder inherits the flag.
      store.row.pipelineRunId = "new-owner";
    });
    expect(passes).toBe(1);
    expect(store.row.pipelineRerunRequested).toBe(true);
    expect(store.row.pipelineRunId).toBe("new-owner");
  });

  it("releases the lock when the work throws, and propagates the error", async () => {
    const store = makeStore();
    await expect(
      withCasePipelineLock(store, "case-1", async () => {
        throw new Error("generation failed");
      }),
    ).rejects.toThrow("generation failed");
    expect(store.row.pipelineRunId).toBeNull();
  });

  it("takes over a claim abandoned by a dead process", async () => {
    const store = makeStore({
      pipelineRunId: "crashed-run",
      pipelineRunAt: new Date(Date.now() - PIPELINE_LOCK_STALE_MS - 1000),
    });
    const result = await withCasePipelineLock(store, "case-1", async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("does not take over a claim that is merely slow", async () => {
    const store = makeStore({
      pipelineRunId: "live-run",
      pipelineRunAt: new Date(Date.now() - PIPELINE_LOCK_STALE_MS + 60_000),
    });
    await expect(withCasePipelineLock(store, "case-1", async () => "ran")).rejects.toBeInstanceOf(PipelineBusyError);
    expect(store.row.pipelineRunId).toBe("live-run");
  });

  it("a stale takeover is not released by the run it displaced", async () => {
    const store = makeStore();
    await withCasePipelineLock(store, "case-1", async () => {
      // Simulate the watchdog handing ownership to someone else mid-run.
      store.row.pipelineRunId = "new-owner";
      store.row.pipelineRunAt = new Date();
    });
    // The displaced run's release is scoped to its own id, so the new owner's
    // claim survives. Clearing it would let a third run start concurrently.
    expect(store.row.pipelineRunId).toBe("new-owner");
  });

  it("reports a missing case as a fault, not as contention", async () => {
    // Background callers swallow PipelineBusyError by design. If a vanished
    // case produced one, the failure would disappear entirely.
    const missing: CaseLockStore = {
      case: {
        async updateMany() {
          return { count: 0 };
        },
        async findUnique() {
          return null;
        },
      },
    };
    const err = await withCasePipelineLock(missing, "gone", async () => "ran").catch((e) => e);
    expect(err).not.toBeInstanceOf(PipelineBusyError);
    expect(String(err)).toContain("no such case");
  });

  it("does not make an extra pass once ownership has moved on", async () => {
    const store = makeStore();
    let passes = 0;
    await withCasePipelineLock(store, "case-1", async () => {
      passes += 1;
      store.row.pipelineRerunRequested = true;
      store.row.pipelineRunId = "new-owner";
    });
    // The rerun obligation belongs to whoever holds the lock now.
    expect(passes).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lease renewal.
//
// A fixed 15-minute staleness window has to recover from a dead process AND
// not interrupt a slow one. A large case can exceed it legitimately, and when
// it did, a second caller took the lock from a run that was still writing —
// reintroducing the very concurrency the lock exists to prevent, on exactly
// the cases where it does the most damage.
// ─────────────────────────────────────────────────────────────────────────────

/** A scheduler the test drives by hand, so no wall-clock time is involved. */
function manualScheduler() {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  return {
    scheduler: {
      setInterval: (fn: () => void) => {
        ticks.push(fn);
        return ticks.length - 1;
      },
      clearInterval: () => {
        cleared += 1;
      },
    },
    tick: async () => {
      for (const fn of ticks) fn();
      // Let the renewal promise inside the tick settle.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
    clearedCount: () => cleared,
    timerCount: () => ticks.length,
  };
}

describe("renewPipelineLease", () => {
  it("renews a claim that is still ours and moves the staleness clock", async () => {
    const store = makeStore({ pipelineRunId: "mine", pipelineRunAt: new Date(1000) });
    const ok = await renewPipelineLease(store, "case-1", "mine", () => new Date(9999));
    expect(ok).toBe(true);
    expect(store.row.pipelineRunAt).toEqual(new Date(9999));
  });

  it("refuses to renew a claim somebody else now holds", async () => {
    const store = makeStore({ pipelineRunId: "theirs", pipelineRunAt: new Date(1000) });
    expect(await renewPipelineLease(store, "case-1", "mine")).toBe(false);
    // And it must not have taken the lock back — that would defeat the
    // takeover the staleness window exists to allow.
    expect(store.row.pipelineRunId).toBe("theirs");
  });

  it("refuses to renew a released claim", async () => {
    const store = makeStore({ pipelineRunId: null });
    expect(await renewPipelineLease(store, "case-1", "mine")).toBe(false);
    expect(store.row.pipelineRunId).toBeNull();
  });
});

describe("lease renewal during long-running work", () => {
  it("keeps a long run's claim fresh so it cannot be stolen while it works", async () => {
    const store = makeStore();
    const m = manualScheduler();
    const start = new Date(0);
    let clock = start;

    let contended = false;
    await withCasePipelineLock(
      store,
      "case-1",
      async (lease) => {
        // Time passes well beyond the staleness window…
        clock = new Date(PIPELINE_LOCK_STALE_MS * 3);
        await m.tick();
        // …but the claim was renewed, so it is still current and still ours.
        expect(lease.owned()).toBe(true);
        expect(store.row.pipelineRunAt).toEqual(clock);
        // A fresh claimant arriving now must be refused. Contend ONCE: a
        // refusal sets the rerun flag, and the holder honours every obligation
        // before returning, so contending on every pass would never converge.
        if (contended) return;
        contended = true;
        await expect(
          withCasePipelineLock(store, "case-1", async () => "stolen", { now: () => clock, heartbeatMs: 0 }),
        ).rejects.toBeInstanceOf(PipelineBusyError);
      },
      { now: () => clock, scheduler: m.scheduler },
    );
    expect(store.row.pipelineRunId).toBeNull();
  });

  it("always clears its timer, including when the work throws", async () => {
    const m = manualScheduler();
    const store = makeStore();
    await expect(
      withCasePipelineLock(store, "case-1", async () => { throw new Error("boom"); }, { scheduler: m.scheduler }),
    ).rejects.toThrow("boom");
    expect(m.timerCount()).toBe(1);
    expect(m.clearedCount()).toBe(1);
  });

  it("clears its timer on the success path too", async () => {
    const m = manualScheduler();
    const store = makeStore();
    await withCasePipelineLock(store, "case-1", async () => "fine", { scheduler: m.scheduler });
    expect(m.clearedCount()).toBe(1);
  });

  it("fails closed when the lease is lost mid-run rather than writing", async () => {
    const store = makeStore();
    const m = manualScheduler();
    let sawLoss = false;
    await expect(
      withCasePipelineLock(
        store,
        "case-1",
        async (lease) => {
          // Another run takes the case while this one is still working.
          store.row.pipelineRunId = "someone-else";
          await m.tick();
          sawLoss = !lease.owned();
          // Anything further this run would persist must not be persisted.
          lease.assertOwned();
          return "wrote something";
        },
        { scheduler: m.scheduler },
      ),
    ).rejects.toBeInstanceOf(PipelineLeaseLostError);
    expect(sawLoss).toBe(true);
    // The run that took it keeps it.
    expect(store.row.pipelineRunId).toBe("someone-else");
  });

  it("does not treat a transient renewal error as ownership loss", async () => {
    // A renewal that cannot reach the database says nothing about ownership;
    // the claim stands until the staleness window expires. Abandoning healthy
    // runs on one failed round-trip would be worse than not renewing at all.
    const m = manualScheduler();
    const store = makeStore();
    let calls = 0;
    const flaky: CaseLockStore = {
      case: {
        async updateMany(args) {
          calls += 1;
          if (calls === 2) throw new Error("connection reset");
          return store.case.updateMany(args);
        },
        findUnique: (args) => store.case.findUnique(args),
      },
    };
    const result = await withCasePipelineLock(
      flaky,
      "case-1",
      async (lease) => {
        await m.tick();
        expect(lease.owned()).toBe(true);
        return "survived";
      },
      { scheduler: m.scheduler },
    );
    expect(result).toBe("survived");
  });

  it("checks ownership after every coalesced pass, not only the first", async () => {
    const store = makeStore();
    const m = manualScheduler();
    let passes = 0;
    await expect(
      withCasePipelineLock(
        store,
        "case-1",
        async () => {
          passes += 1;
          if (passes === 1) {
            store.row.pipelineRerunRequested = true;
            return "first";
          }
          // The lease is taken during the SECOND pass.
          store.row.pipelineRunId = "someone-else";
          await m.tick();
          return "second";
        },
        { scheduler: m.scheduler },
      ),
    ).rejects.toBeInstanceOf(PipelineLeaseLostError);
    expect(passes).toBe(2);
  });
});
