/**
 * Preflight and backfill for the safeguard rollout.
 *
 * The live database is managed with `prisma db push`, not `migrate deploy`: its
 * _prisma_migrations table holds a partial history, so a deploy would try to
 * replay migrations whose objects already exist. Push brings the SCHEMA up to
 * date and runs no DML — which matters here, because one of these migrations
 * carries a backfill that push will silently skip.
 *
 * That backfill is the point. evaluateCandidate used to write status ADOPTED
 * the moment held-out metrics improved, and retrieveGuidance serves ADOPTED
 * rows into live prompts. Rows adopted that way have no approver. If push runs
 * and the backfill does not, those lessons keep shaping every future case with
 * nobody having approved them — which is the exact defect the approval gate was
 * added to close, surviving the change that was supposed to close it.
 *
 * Everything here is:
 *   • dry-run by default; changing anything requires an explicit apply flag
 *   • preceded by a schema check, so it refuses to run against a database that
 *     has not been pushed yet rather than half-completing
 *   • counted before and after, and the counts are reported either way
 *   • one transaction
 *   • idempotent — a second run finds nothing to do and says so
 *
 * It never touches a row a human decided. `approvedById IS NOT NULL` is the
 * discriminator, and it is checked in SQL rather than in application code so
 * the guarantee lives with the write.
 */

export interface RolloutDb {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: RolloutDb) => Promise<T>): Promise<T>;
}

/** Objects this rollout's code requires. Missing any of them means stop. */
export const REQUIRED_OBJECTS: { table: string; column?: string }[] = [
  { table: "RetrievalAttempt" },
  { table: "BasisReconciliation" },
  { table: "LearningCandidate", column: "approvalClass" },
  { table: "LearningCandidate", column: "approvedById" },
  { table: "RecommendationBasis", column: "specification" },
  { table: "RecommendationBasis", column: "assessmentBasis" },
  { table: "RetrievalAttempt", column: "failedSources" },
];

export interface SchemaCheck {
  ok: boolean;
  missing: string[];
}

export async function verifySchema(db: RolloutDb): Promise<SchemaCheck> {
  const missing: string[] = [];
  // Scoped to the ACTIVE schema. Unqualified, these queries match a table of
  // the same name in ANY schema the database happens to hold — so on a
  // multi-schema database (this product runs in a named schema alongside
  // others) the preflight could pass on the strength of another tenant's or
  // another product's objects, and the backfill would then run against a schema
  // that does not have them.
  for (const o of REQUIRED_OBJECTS) {
    if (o.column) {
      const rows = await db.$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        o.table,
        o.column,
      );
      if (Number(rows[0]?.n ?? 0) === 0) missing.push(`${o.table}.${o.column}`);
    } else {
      const rows = await db.$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1`,
        o.table,
      );
      if (Number(rows[0]?.n ?? 0) === 0) missing.push(o.table);
    }
  }
  return { ok: missing.length === 0, missing };
}

export interface Survey {
  /** ADOPTED with no approver — adopted by a metric, never by a person. */
  machineAdopted: number;
  /** ADOPTED with an approver — a human decision, never touched. */
  humanApproved: number;
  awaitingApproval: number;
  /** LearningFinding rows that would follow their candidate back. */
  findingsToReturn: number;
}

export async function survey(db: RolloutDb): Promise<Survey> {
  const one = async (sql: string) =>
    Number((await db.$queryRawUnsafe<{ n: bigint | number }[]>(sql))[0]?.n ?? 0);
  return {
    machineAdopted: await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "status" = 'ADOPTED' AND "approvedById" IS NULL`),
    humanApproved: await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "status" = 'ADOPTED' AND "approvedById" IS NOT NULL`),
    awaitingApproval: await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "status" = 'APPROVAL_PENDING'`),
    findingsToReturn: await one(
      `SELECT count(*)::int AS n FROM "LearningFinding" f
        WHERE f."state" = 'ADOPTED'
          AND f."candidateId" IN (SELECT "id" FROM "LearningCandidate" WHERE "status" = 'ADOPTED' AND "approvedById" IS NULL)`,
    ),
  };
}

export interface RolloutReport {
  mode: "DRY_RUN" | "APPLIED";
  schema: SchemaCheck;
  before: Survey | null;
  after: Survey | null;
  candidatesReturned: number;
  findingsReturned: number;
  /** Human-readable lines, in the order they should be shown. */
  log: string[];
}

/**
 * Survey, and — only with `apply` — return machine-adopted lessons to the
 * approval queue.
 *
 * The two statements run in one transaction: a candidate returned to the queue
 * whose findings still read ADOPTED would leave the learning loop describing a
 * state that no longer exists.
 */
export async function runRollout(db: RolloutDb, opts: { apply?: boolean } = {}): Promise<RolloutReport> {
  const log: string[] = [];
  const schema = await verifySchema(db);
  if (!schema.ok) {
    log.push(`SCHEMA INCOMPLETE — missing: ${schema.missing.join(", ")}`);
    log.push("Run the schema push first. Nothing was surveyed or changed.");
    return { mode: opts.apply ? "APPLIED" : "DRY_RUN", schema, before: null, after: null, candidatesReturned: 0, findingsReturned: 0, log };
  }
  log.push("Schema check passed — every object this rollout needs is present.");

  // Counted BEFORE anything is decided, and reported whether or not we apply.
  const before = await survey(db);
  log.push(`Machine-adopted lessons (ADOPTED, no approver): ${before.machineAdopted}`);
  log.push(`Human-approved lessons (preserved untouched):    ${before.humanApproved}`);
  log.push(`Already awaiting approval:                       ${before.awaitingApproval}`);
  log.push(`Findings that would follow their candidate:      ${before.findingsToReturn}`);

  if (!before.machineAdopted) {
    log.push("Nothing to backfill. Safe to re-run at any time.");
    return { mode: opts.apply ? "APPLIED" : "DRY_RUN", schema, before, after: before, candidatesReturned: 0, findingsReturned: 0, log };
  }

  if (!opts.apply) {
    log.push("");
    log.push("DRY RUN — no rows were changed. Re-run with --apply to perform the backfill.");
    return { mode: "DRY_RUN", schema, before, after: before, candidatesReturned: 0, findingsReturned: 0, log };
  }

  const { candidatesReturned, findingsReturned } = await db.$transaction(async (tx) => {
    // Findings first: the candidate predicate they select on is about to stop
    // matching. Both statements are scoped by `approvedById IS NULL`, so a row
    // a human approved is unreachable from either of them.
    const f = await tx.$executeRawUnsafe(
      `UPDATE "LearningFinding" SET "state" = 'EVALUATED'
        WHERE "state" = 'ADOPTED'
          AND "candidateId" IN (SELECT "id" FROM "LearningCandidate" WHERE "status" = 'ADOPTED' AND "approvedById" IS NULL)`,
    );
    const c = await tx.$executeRawUnsafe(
      `UPDATE "LearningCandidate" SET "status" = 'APPROVAL_PENDING', "adoptedAt" = NULL
        WHERE "status" = 'ADOPTED' AND "approvedById" IS NULL`,
    );
    return { candidatesReturned: c, findingsReturned: f };
  });

  const after = await survey(db);
  log.push("");
  log.push(`APPLIED — ${candidatesReturned} lesson(s) returned to the approval queue, ${findingsReturned} finding(s) followed.`);
  log.push(`Human-approved lessons after: ${after.humanApproved} (was ${before.humanApproved}).`);
  if (after.machineAdopted !== 0) log.push(`WARNING: ${after.machineAdopted} machine-adopted lesson(s) remain — investigate before relying on this run.`);
  if (after.humanApproved !== before.humanApproved) log.push("WARNING: the human-approved count changed. It must not. Investigate immediately.");

  return { mode: "APPLIED", schema, before, after, candidatesReturned, findingsReturned, log };
}
