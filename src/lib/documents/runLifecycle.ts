// ─────────────────────────────────────────────────────────────────────────────
// Extraction run lifecycle: start, lock, resume, finish.
//
// The run row is created when work STARTS, not when it ends, so an interrupted
// run is visible as an unfinished run rather than as no run at all — the
// difference between "this document was never processed" and "processing
// stopped halfway" is exactly the difference the record's completeness claim
// depends on.
//
//   • One unfinished run per document, enforced by a unique index on
//     (sourceDocumentId, lockKey) with lockKey NULL on finished runs. Two
//     concurrent extractions of the same document cannot both proceed and
//     write duplicate drafts.
//   • A crash cannot block a document forever: the lock carries a heartbeat,
//     and a run whose heartbeat has gone cold may be taken over.
//   • Identical work is not repeated: a COMPLETE run over the same source
//     bytes, prompt, schema and model is returned as-is unless forced.
//   • A run that exhausts its chunk budget PAUSES with a durable cursor and
//     resumes where it stopped. The cursor is chunk positions only — no record
//     content, so nothing here carries PHI.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { withDbRetry } from "@/lib/dbRetry";

/** A run whose heartbeat is older than this is presumed dead and reclaimable. */
export const STALE_LOCK_MS = 30 * 60_000;

/** The lockKey value held by an unfinished run. NULL means finished. */
const ACTIVE = "ACTIVE";

export interface RunIdentity {
  firmId: string;
  caseId: string;
  sourceDocumentId: string;
  sourceFingerprint: string;
  promptVersion: string;
  schemaVersion: string;
  provider: string;
  model: string | null;
  createdById?: string | null;
}

export type RunClaim =
  | { kind: "CLAIMED"; runId: string; startIndex: 0 }
  | { kind: "RESUMED"; runId: string; startIndex: number }
  | { kind: "IDEMPOTENT"; runId: string; accepted: number }
  | { kind: "BUSY"; runId: string | null };

/**
 * A prior COMPLETE run over the same bytes with the same prompt, schema and
 * model would produce the same answer; re-running it burns tokens and churns
 * draft rows for nothing.
 */
export async function findIdempotentRun(id: RunIdentity): Promise<{ id: string; acceptedCount: number } | null> {
  const prior = await withDbRetry(() =>
    prisma.recordExtraction.findFirst({
    where: {
      sourceDocumentId: id.sourceDocumentId,
      firmId: id.firmId,
      status: "COMPLETE",
      sourceFingerprint: id.sourceFingerprint,
      promptVersion: id.promptVersion,
      schemaVersion: id.schemaVersion,
      model: id.model,
    },
    orderBy: { createdAt: "desc" },
      select: { id: true, acceptedCount: true },
    }),
  );
  return prior ?? null;
}

/**
 * Take ownership of this document's extraction, or report that someone else
 * already has it. Never blocks and never steals a live run.
 */
export async function claimRun(id: RunIdentity, now: Date = new Date()): Promise<RunClaim> {
  const live = await withDbRetry(() =>
    prisma.recordExtraction.findFirst({ where: { sourceDocumentId: id.sourceDocumentId, lockKey: ACTIVE } }),
  );

  if (live) {
    const resumable = live.status === "PAUSED";
    const heartbeat = live.heartbeatAt ?? live.startedAt ?? live.createdAt;
    const cold = now.getTime() - new Date(heartbeat).getTime() > STALE_LOCK_MS;

    // A paused run over source bytes that have since changed cannot be
    // resumed — its cursor points into a document that no longer exists.
    if (resumable && live.sourceFingerprint !== id.sourceFingerprint) {
      await prisma.recordExtraction.updateMany({
        where: { id: live.id, lockKey: ACTIVE },
        data: { status: "ABANDONED", lockKey: null, finishedAt: now, error: "The source document changed while this run was paused; it was abandoned and a fresh run was started." },
      });
    } else if (resumable || cold) {
      // Compare-and-set on the exact state we read: if another worker resumed
      // or reclaimed it first, we lose and back off rather than double-run.
      //
      // Deliberately NOT retried on a connection failure. A CAS that may or
      // may not have applied cannot be safely repeated: the retry would match
      // nothing (we changed the heartbeat) and report BUSY. Failing to claim
      // is the safe outcome — we simply do not proceed.
      const taken = await prisma.recordExtraction.updateMany({
        where: { id: live.id, lockKey: ACTIVE, status: live.status, heartbeatAt: live.heartbeatAt },
        data: { status: "RUNNING", heartbeatAt: now, ...(cold && !resumable ? { error: null } : {}) },
      });
      if (taken.count === 0) return { kind: "BUSY", runId: live.id };
      const state = (live.resumeState ?? null) as { nextChunkIndex?: number } | null;
      const startIndex = resumable && typeof state?.nextChunkIndex === "number" && state.nextChunkIndex > 0 ? state.nextChunkIndex : 0;
      return { kind: "RESUMED", runId: live.id, startIndex };
    } else {
      // A live run with a warm heartbeat owns this document.
      return { kind: "BUSY", runId: live.id };
    }
  }

  try {
    const run = await prisma.recordExtraction.create({
      data: {
        firmId: id.firmId,
        caseId: id.caseId,
        sourceDocumentId: id.sourceDocumentId,
        createdById: id.createdById ?? null,
        status: "RUNNING",
        provider: id.provider,
        model: id.model,
        promptVersion: id.promptVersion,
        schemaVersion: id.schemaVersion,
        sourceFingerprint: id.sourceFingerprint,
        startedAt: now,
        heartbeatAt: now,
        lockKey: ACTIVE,
      },
    });
    return { kind: "CLAIMED", runId: run.id, startIndex: 0 };
  } catch (err) {
    // Lost a genuine race on the unique index — the other worker owns it.
    if (isUniqueViolation(err)) return { kind: "BUSY", runId: null };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Keep the lock warm during long runs so it is not mistaken for a crash. */
export async function heartbeat(runId: string, chunksDone: number): Promise<void> {
  await prisma.recordExtraction
    .updateMany({ where: { id: runId, lockKey: ACTIVE }, data: { heartbeatAt: new Date(), chunksDone } })
    .catch(() => {});
}

/**
 * Stop cleanly at the chunk budget with a durable cursor. The lock is HELD: a
 * paused run still owns its document, so the next invocation resumes it
 * instead of starting a competing run.
 */
export async function pauseRun(runId: string, nextChunkIndex: number, data: Record<string, unknown>): Promise<void> {
  await withDbRetry(() =>
    prisma.recordExtraction.update({
      where: { id: runId },
      data: { ...data, status: "PAUSED", resumeState: { nextChunkIndex }, chunksDone: nextChunkIndex, heartbeatAt: new Date() },
    }),
  );
}

/** Reach a terminal state and release the lock. */
export async function finishRun(runId: string, status: string, data: Record<string, unknown>, startedAt?: Date | null): Promise<{ id: string; error: string | null }> {
  const now = new Date();
  // Writing the same terminal state twice is harmless, so this retries freely.
  // Losing it is not harmless: the run would stay RUNNING and hold its lock
  // until the heartbeat went cold.
  return withDbRetry(() =>
    prisma.recordExtraction.update({
    where: { id: runId },
    data: {
      ...data,
      status,
      finishedAt: now,
      ...(startedAt ? { durationMs: now.getTime() - startedAt.getTime() } : {}),
        resumeState: undefined,
        lockKey: null,
      },
    }),
  );
}

/**
 * Per-invocation chunk budget. Unset means no budget — the default, because a
 * record must process end to end. A deployment running under a hard request
 * timeout sets RECORD_CHUNK_BUDGET so long documents pause and resume rather
 * than being killed mid-run.
 */
export function chunkBudget(): number | null {
  const raw = Number(process.env.RECORD_CHUNK_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}
