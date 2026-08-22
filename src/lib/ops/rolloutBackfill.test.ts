// The rollout backfill.
//
// `prisma db push` brings the schema up to date and runs no DML, so the
// backfill carried by the learning-approval migration is silently skipped on a
// push-managed database. That backfill is the whole point: lessons adopted by a
// metric with no approver keep shaping every future case, which is the defect
// the approval gate exists to close, surviving the change that closes it.
//
// Exercised against a fake here; against a real disposable Postgres in CI.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runRollout, verifySchema, survey, REQUIRED_OBJECTS, type RolloutDb } from "@/lib/ops/rolloutBackfill";

/** A fake that answers the real SQL by pattern, and counts what it changed. */
function fakeDb(opts: {
  missing?: string[];
  machineAdopted?: number;
  humanApproved?: number;
  awaitingApproval?: number;
  findingsToReturn?: number;
  failWrite?: boolean;
} = {}) {
  const state = {
    machineAdopted: opts.machineAdopted ?? 0,
    humanApproved: opts.humanApproved ?? 0,
    awaitingApproval: opts.awaitingApproval ?? 0,
    findingsToReturn: opts.findingsToReturn ?? 0,
  };
  const executed: string[] = [];
  let inTransaction = false;

  const db: RolloutDb & { executed: string[]; state: typeof state; transactions: number } = {
    executed,
    state,
    transactions: 0,
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      if (sql.includes("information_schema.columns")) {
        const key = `${values[0]}.${values[1]}`;
        return [{ n: (opts.missing ?? []).includes(key) ? 0 : 1 }] as unknown as T;
      }
      if (sql.includes("information_schema.tables")) {
        return [{ n: (opts.missing ?? []).includes(String(values[0])) ? 0 : 1 }] as unknown as T;
      }
      if (sql.includes(`"LearningFinding"`)) return [{ n: state.findingsToReturn }] as unknown as T;
      if (sql.includes("'APPROVAL_PENDING'")) return [{ n: state.awaitingApproval }] as unknown as T;
      if (sql.includes(`"approvedById" IS NOT NULL`)) return [{ n: state.humanApproved }] as unknown as T;
      if (sql.includes(`"approvedById" IS NULL`)) return [{ n: state.machineAdopted }] as unknown as T;
      throw new Error(`unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql: string): Promise<number> {
      if (!inTransaction) throw new Error("write ran outside a transaction");
      if (opts.failWrite) throw new Error("write failed");
      executed.push(sql);
      if (sql.includes(`UPDATE "LearningFinding"`)) {
        const n = state.findingsToReturn;
        state.findingsToReturn = 0;
        return n;
      }
      const n = state.machineAdopted;
      state.awaitingApproval += n;
      state.machineAdopted = 0;
      return n;
    },
    async $transaction<T>(fn: (tx: RolloutDb) => Promise<T>): Promise<T> {
      db.transactions++;
      inTransaction = true;
      const snapshot = { ...state };
      try {
        return await fn(db);
      } catch (e) {
        Object.assign(state, snapshot); // rollback
        throw e;
      } finally {
        inTransaction = false;
      }
    },
  };
  return db;
}

describe("it refuses to run against a schema that is not ready", () => {
  it("names every missing object and changes nothing", async () => {
    const db = fakeDb({ missing: ["RetrievalAttempt", "LearningCandidate.approvalClass"], machineAdopted: 5 });
    const r = await runRollout(db, { apply: true });
    expect(r.schema.ok).toBe(false);
    expect(r.schema.missing).toEqual(["RetrievalAttempt", "LearningCandidate.approvalClass"]);
    expect(db.executed).toHaveLength(0);
    expect(r.before).toBeNull();
    expect(r.log.join("\n")).toMatch(/SCHEMA INCOMPLETE/);
  });

  it("checks every object the rollout's code depends on", async () => {
    const db = fakeDb();
    expect((await verifySchema(db)).ok).toBe(true);
    expect(REQUIRED_OBJECTS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("it reports counts before it changes anything", () => {
  it("surveys in dry run and writes nothing", async () => {
    const db = fakeDb({ machineAdopted: 7, humanApproved: 3, awaitingApproval: 2, findingsToReturn: 11 });
    const r = await runRollout(db);
    expect(r.mode).toBe("DRY_RUN");
    expect(r.before).toEqual({ machineAdopted: 7, humanApproved: 3, awaitingApproval: 2, findingsToReturn: 11 });
    expect(db.executed).toHaveLength(0);
    expect(db.state.machineAdopted).toBe(7);
    expect(r.log.join("\n")).toMatch(/DRY RUN — no rows were changed/);
  });

  it("dry run is the default — apply must be asked for explicitly", async () => {
    const db = fakeDb({ machineAdopted: 4 });
    expect((await runRollout(db)).mode).toBe("DRY_RUN");
    expect((await runRollout(db, {})).mode).toBe("DRY_RUN");
    expect(db.executed).toHaveLength(0);
  });
});

describe("applying returns machine-adopted lessons and preserves human decisions", () => {
  it("returns exactly the lessons no person approved", async () => {
    const db = fakeDb({ machineAdopted: 7, humanApproved: 3, findingsToReturn: 11 });
    const r = await runRollout(db, { apply: true });
    expect(r.mode).toBe("APPLIED");
    expect(r.candidatesReturned).toBe(7);
    expect(r.findingsReturned).toBe(11);
    expect(r.after).toMatchObject({ machineAdopted: 0, humanApproved: 3, awaitingApproval: 7 });
  });

  it("every write is scoped by approvedById IS NULL", async () => {
    // The guarantee lives in the SQL, not in application code above it.
    const db = fakeDb({ machineAdopted: 2, humanApproved: 9, findingsToReturn: 2 });
    await runRollout(db, { apply: true });
    expect(db.executed).toHaveLength(2);
    for (const sql of db.executed) expect(sql).toContain(`"approvedById" IS NULL`);
  });

  it("never changes the human-approved count", async () => {
    const db = fakeDb({ machineAdopted: 5, humanApproved: 12, findingsToReturn: 5 });
    const r = await runRollout(db, { apply: true });
    expect(r.after!.humanApproved).toBe(r.before!.humanApproved);
    expect(r.log.join("\n")).not.toMatch(/WARNING/);
  });

  it("runs both statements in one transaction", async () => {
    // A candidate back in the queue whose findings still read ADOPTED would
    // leave the loop describing a state that no longer exists.
    const db = fakeDb({ machineAdopted: 3, findingsToReturn: 3 });
    await runRollout(db, { apply: true });
    expect(db.transactions).toBe(1);
  });

  it("rolls back entirely when a statement fails", async () => {
    const db = fakeDb({ machineAdopted: 3, findingsToReturn: 3, failWrite: true });
    await expect(runRollout(db, { apply: true })).rejects.toThrow(/write failed/);
    expect(db.state.machineAdopted).toBe(3);
    expect(db.state.findingsToReturn).toBe(3);
  });
});

describe("it is safe to re-run", () => {
  it("a second apply finds nothing to do", async () => {
    const db = fakeDb({ machineAdopted: 4, humanApproved: 1, findingsToReturn: 4 });
    const first = await runRollout(db, { apply: true });
    expect(first.candidatesReturned).toBe(4);

    const second = await runRollout(db, { apply: true });
    expect(second.candidatesReturned).toBe(0);
    expect(second.log.join("\n")).toMatch(/Nothing to backfill\. Safe to re-run/);
  });

  it("re-running does not disturb what the first run created", async () => {
    const db = fakeDb({ machineAdopted: 4, humanApproved: 1, findingsToReturn: 4 });
    await runRollout(db, { apply: true });
    const before = { ...db.state };
    await runRollout(db, { apply: true });
    expect(db.state).toEqual(before);
  });

  it("a dry run on an already-migrated database says so and writes nothing", async () => {
    const db = fakeDb({ machineAdopted: 0, humanApproved: 6, awaitingApproval: 2 });
    const r = await runRollout(db);
    expect(r.candidatesReturned).toBe(0);
    expect(db.executed).toHaveLength(0);
    expect(r.log.join("\n")).toMatch(/Nothing to backfill/);
  });
});

describe("the runner", () => {
  it("does not print the connection string", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "..", "scripts", "rollout-backfill.ts"), "utf8");
    // Host only. Echoing DATABASE_URL puts a password in every scrollback and
    // CI log the script ever runs in.
    expect(src).toMatch(/new URL\(url\)\.host/);
    expect(src).not.toMatch(/console\.log\([^)]*DATABASE_URL/);
    expect(src).not.toMatch(/console\.log\(\s*url\s*\)/);
  });

  it("requires --apply and defaults to a dry run", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "..", "scripts", "rollout-backfill.ts"), "utf8");
    expect(src).toMatch(/process\.argv\.includes\("--apply"\)/);
    expect(src).toMatch(/DRY RUN/);
  });
});
