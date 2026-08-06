// The run lock is what stops two workers writing duplicate drafts for the same
// document, and the heartbeat is what stops a crashed worker blocking it
// forever. Both are enforced with compare-and-set, so these tests exercise the
// races directly. Synthetic identifiers only — no record content is involved.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    runs: [] as Record<string, unknown>[],
    seq: 0,
    /** Simulate losing the unique index race on create. */
    uniqueViolation: false,
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v instanceof Date) return (row[k] as Date | null)?.getTime() === v.getTime();
      return row[k] === v;
    });
  const prisma = {
    recordExtraction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => state.runs.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.uniqueViolation) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        // The real uniqueness rule: one row per (sourceDocumentId, lockKey)
        // where lockKey is non-null.
        if (data.lockKey && state.runs.some((r) => r.sourceDocumentId === data.sourceDocumentId && r.lockKey === data.lockKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `run-${++state.seq}`, createdAt: new Date("2026-08-06T00:00:00Z"), ...data };
        state.runs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.runs.find((r) => r.id === where.id)!;
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = state.runs.filter((r) => matches(r, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

import { claimRun, findIdempotentRun, finishRun, pauseRun, chunkBudget, STALE_LOCK_MS } from "./runLifecycle";

const NOW = new Date("2026-08-06T12:00:00Z");
const identity = (over: Record<string, unknown> = {}) => ({
  firmId: "firm-1",
  caseId: "case-1",
  sourceDocumentId: "doc-1",
  sourceFingerprint: "fp-aaa",
  promptVersion: "rex-1.3",
  schemaVersion: "s-1",
  provider: "anthropic",
  model: "test-model",
  createdById: null,
  ...over,
});

beforeEach(() => {
  db.state.runs = [];
  db.state.seq = 0;
  db.state.uniqueViolation = false;
  delete process.env.RECORD_CHUNK_BUDGET;
});

describe("a run row exists from the moment work starts", () => {
  it("claiming creates a RUNNING row holding the lock, before any model call", async () => {
    const claim = await claimRun(identity(), NOW);
    expect(claim.kind).toBe("CLAIMED");
    const row = db.state.runs[0];
    expect(row.status).toBe("RUNNING");
    expect(row.lockKey).toBe("ACTIVE");
    expect(row.startedAt).toEqual(NOW);
    expect(row.heartbeatAt).toEqual(NOW);
    expect(row.finishedAt).toBeUndefined();
    // Provenance is fixed at the start, so an interrupted run is still
    // attributable to a prompt and model.
    expect(row.promptVersion).toBe("rex-1.3");
    expect(row.sourceFingerprint).toBe("fp-aaa");
  });

  it("finishing releases the lock and stamps the duration", async () => {
    const claim = await claimRun(identity(), NOW);
    if (claim.kind !== "CLAIMED") throw new Error("expected a claim");
    await finishRun(claim.runId, "COMPLETE", { acceptedCount: 7 }, NOW);
    const row = db.state.runs[0];
    expect(row.status).toBe("COMPLETE");
    expect(row.lockKey).toBeNull(); // finished runs never hold the lock
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.durationMs as number).toBeGreaterThanOrEqual(0);
  });
});

describe("one unfinished run per document", () => {
  it("a second worker is turned away while a live run holds the lock", async () => {
    await claimRun(identity(), NOW);
    const second = await claimRun(identity(), new Date(NOW.getTime() + 60_000));
    expect(second.kind).toBe("BUSY");
    expect(db.state.runs).toHaveLength(1); // no competing run row
  });

  it("losing the unique-index race is reported as BUSY, not as an error", async () => {
    db.state.uniqueViolation = true;
    const claim = await claimRun(identity(), NOW);
    expect(claim.kind).toBe("BUSY");
  });

  it("a finished run does not block the next one", async () => {
    const first = await claimRun(identity(), NOW);
    if (first.kind !== "CLAIMED") throw new Error("expected a claim");
    await finishRun(first.runId, "COMPLETE", {}, NOW);
    const second = await claimRun(identity({ sourceFingerprint: "fp-bbb" }), new Date(NOW.getTime() + 1000));
    expect(second.kind).toBe("CLAIMED");
    expect(db.state.runs).toHaveLength(2);
  });
});

describe("a crashed run cannot block a document forever", () => {
  it("a cold heartbeat is reclaimable; a warm one is not", async () => {
    await claimRun(identity(), NOW);
    const warm = await claimRun(identity(), new Date(NOW.getTime() + STALE_LOCK_MS - 1_000));
    expect(warm.kind).toBe("BUSY");
    const cold = await claimRun(identity(), new Date(NOW.getTime() + STALE_LOCK_MS + 1_000));
    expect(cold.kind).toBe("RESUMED"); // the same row is taken over, not duplicated
    expect(db.state.runs).toHaveLength(1);
    expect(db.state.runs[0].status).toBe("RUNNING");
  });

  it("two workers reclaiming the same dead run: exactly one wins", async () => {
    await claimRun(identity(), NOW);
    const later = new Date(NOW.getTime() + STALE_LOCK_MS + 1_000);
    const a = await claimRun(identity(), later);
    // The second attempt reads the row the winner already stamped, so its
    // compare-and-set matches nothing.
    const b = await claimRun(identity(), later);
    expect([a.kind, b.kind]).toEqual(["RESUMED", "BUSY"]);
  });
});

describe("pause and resume", () => {
  it("a paused run keeps the lock and records a PHI-free cursor", async () => {
    const claim = await claimRun(identity(), NOW);
    if (claim.kind !== "CLAIMED") throw new Error("expected a claim");
    await pauseRun(claim.runId, 40, { chunksTotal: 120 });
    const row = db.state.runs[0];
    expect(row.status).toBe("PAUSED");
    expect(row.lockKey).toBe("ACTIVE"); // still owns the document
    expect(row.resumeState).toEqual({ nextChunkIndex: 40 });
    expect(row.chunksDone).toBe(40);
    // The cursor is chunk positions and counts — nothing from the record.
    expect(JSON.stringify(row.resumeState)).not.toMatch(/[a-z]{4,}\s/i);
  });

  it("the next invocation resumes at the cursor instead of re-reading the document", async () => {
    const claim = await claimRun(identity(), NOW);
    if (claim.kind !== "CLAIMED") throw new Error("expected a claim");
    await pauseRun(claim.runId, 40, {});
    const resumed = await claimRun(identity(), new Date(NOW.getTime() + 5_000));
    expect(resumed).toMatchObject({ kind: "RESUMED", runId: claim.runId, startIndex: 40 });
    expect(db.state.runs).toHaveLength(1);
  });

  it("a paused run over source bytes that changed is abandoned, never resumed", async () => {
    const claim = await claimRun(identity(), NOW);
    if (claim.kind !== "CLAIMED") throw new Error("expected a claim");
    await pauseRun(claim.runId, 40, {});
    // The document was re-OCR'd or replaced: the cursor points into text that
    // no longer exists.
    const fresh = await claimRun(identity({ sourceFingerprint: "fp-CHANGED" }), new Date(NOW.getTime() + 5_000));
    expect(fresh.kind).toBe("CLAIMED");
    const abandoned = db.state.runs.find((r) => r.id === claim.runId)!;
    expect(abandoned.status).toBe("ABANDONED");
    expect(abandoned.lockKey).toBeNull();
    expect(String(abandoned.error)).toMatch(/changed while this run was paused/);
  });

  it("the budget is opt-in: unset means the whole document is processed", () => {
    expect(chunkBudget()).toBeNull();
    process.env.RECORD_CHUNK_BUDGET = "50";
    expect(chunkBudget()).toBe(50);
    process.env.RECORD_CHUNK_BUDGET = "0";
    expect(chunkBudget()).toBeNull();
    process.env.RECORD_CHUNK_BUDGET = "nonsense";
    expect(chunkBudget()).toBeNull();
  });
});

describe("identical work is not repeated", () => {
  const complete = (over: Record<string, unknown> = {}) => {
    db.state.runs.push({
      id: "run-prior",
      firmId: "firm-1",
      caseId: "case-1",
      sourceDocumentId: "doc-1",
      status: "COMPLETE",
      sourceFingerprint: "fp-aaa",
      promptVersion: "rex-1.3",
      schemaVersion: "s-1",
      model: "test-model",
      acceptedCount: 12,
      lockKey: null,
      createdAt: new Date("2026-08-05T00:00:00Z"),
      ...over,
    });
  };

  it("same bytes, prompt, schema and model → the prior run is reused", async () => {
    complete();
    expect(await findIdempotentRun(identity())).toMatchObject({ id: "run-prior", acceptedCount: 12 });
  });

  it("changed source, prompt, schema or model → the work is NOT reused", async () => {
    complete();
    expect(await findIdempotentRun(identity({ sourceFingerprint: "fp-bbb" }))).toBeNull();
    expect(await findIdempotentRun(identity({ promptVersion: "rex-1.4" }))).toBeNull();
    expect(await findIdempotentRun(identity({ schemaVersion: "s-2" }))).toBeNull();
    expect(await findIdempotentRun(identity({ model: "other-model" }))).toBeNull();
  });

  it("a failed prior run is never mistaken for finished work", async () => {
    complete({ status: "EXTRACTION_FAILED" });
    expect(await findIdempotentRun(identity())).toBeNull();
  });
});
