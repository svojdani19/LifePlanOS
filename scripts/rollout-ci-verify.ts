// Prove the backfill DOES something, against a disposable CI database.
//
// CI previously ran the script twice against an empty database and asserted it
// changed nothing. That proves no-op idempotence and nothing else: a backfill
// that was silently a no-op in every case would have passed identically.
//
// This seeds representative rows — machine-adopted lessons that must move,
// human-approved lessons that must not, and findings that must follow their
// candidate — runs the real backfill, checks exact counts and preserved
// provenance, then runs it again and proves the second run changes nothing.
//
// DISPOSABLE DATABASES ONLY. It refuses to start against anything that is not
// plainly a local or CI host, because it writes and deletes rows.

import { prisma } from "@/lib/db";
import { runRollout, survey, type RolloutDb } from "@/lib/ops/rolloutBackfill";

const FIRM = "firm-rollout-ci";
const IDS = {
  machineA: "cand-machine-a",
  machineB: "cand-machine-b",
  human: "cand-human",
  pending: "cand-pending",
};

function assertDisposable() {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try { host = new URL(url).host; } catch { /* handled below */ }
  const ok = /^(127\.0\.0\.1|localhost|postgres|db)(:\d+)?$/.test(host);
  if (!ok) {
    console.error(`Refusing to run: "${host || "unparseable host"}" is not a recognised disposable database host.`);
    console.error("This script writes and deletes rows. Run it only against a local or CI Postgres.");
    process.exit(2);
  }
  return host;
}

const q = (sql: string, ...v: unknown[]) => prisma.$executeRawUnsafe(sql, ...v);

async function seed() {
  await cleanup();
  // Two adopted by a metric with no approver — these must return to the queue.
  for (const id of [IDS.machineA, IDS.machineB]) {
    await q(
      `INSERT INTO "LearningCandidate" ("id","firmId","mechanism","failureCode","guidance","scope","status","approvalClass","adoptedAt","supportCount","version","createdAt","updatedAt")
       VALUES ($1,$2,'TASK_GUIDANCE','MISSED_SECTION','fixture guidance','DOCUMENT_CLASS','ADOPTED','STYLE',now(),3,1,now(),now())`,
      id, FIRM,
    );
  }
  // Adopted by a person — must be untouched, provenance intact.
  await q(
    `INSERT INTO "LearningCandidate" ("id","firmId","mechanism","failureCode","guidance","scope","status","approvalClass","adoptedAt","approvedById","approvedAt","approverCredential","supportCount","version","createdAt","updatedAt")
     VALUES ($1,$2,'TASK_GUIDANCE','MISSED_SECTION','human-approved guidance','DOCUMENT_CLASS','ADOPTED','STYLE',now(),'md-1',now(),'MD, verified',3,1,now(),now())`,
    IDS.human, FIRM,
  );
  // Already queued — must stay queued and not be double-counted.
  await q(
    `INSERT INTO "LearningCandidate" ("id","firmId","mechanism","failureCode","guidance","scope","status","approvalClass","supportCount","version","createdAt","updatedAt")
     VALUES ($1,$2,'TASK_GUIDANCE','MISSED_SECTION','pending guidance','DOCUMENT_CLASS','APPROVAL_PENDING','STYLE',3,1,now(),now())`,
    IDS.pending, FIRM,
  );
  // One finding per machine-adopted candidate, plus one on the human-approved
  // one that must NOT move.
  for (const [i, cand] of [IDS.machineA, IDS.machineB, IDS.human].entries()) {
    await q(
      `INSERT INTO "LearningFinding" ("id","firmId","stage","failureCode","severity","detectionSource","state","candidateId","createdAt","updatedAt")
       VALUES ($1,$2,'EXTRACTION','MISSED_SECTION','MATERIAL','DETERMINISTIC_CHECK','ADOPTED',$3,now(),now())`,
      `find-${i}`, FIRM, cand,
    );
  }
}

async function cleanup() {
  await q(`DELETE FROM "LearningFinding" WHERE "firmId" = $1`, FIRM);
  await q(`DELETE FROM "LearningCandidate" WHERE "firmId" = $1`, FIRM);
}

const one = async (sql: string, ...v: unknown[]) =>
  Number(((await prisma.$queryRawUnsafe<{ n: number }[]>(sql, ...v))[0])?.n ?? 0);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

async function main() {
  const host = assertDisposable();
  console.log(`Rollout backfill verification against ${host}\n`);

  await seed();

  const before = await survey(prisma as unknown as RolloutDb);
  console.log("Seeded:", JSON.stringify(before));
  check("two machine-adopted lessons are present", before.machineAdopted, 2);
  check("one human-approved lesson is present", before.humanApproved, 1);
  check("one lesson already awaiting approval", before.awaitingApproval, 1);
  check("two findings would follow their candidate", before.findingsToReturn, 2);

  // ── Dry run must change nothing ──────────────────────────────────────────
  const dry = await runRollout(prisma as unknown as RolloutDb);
  check("dry run reports DRY_RUN", dry.mode, "DRY_RUN");
  check("dry run changed no candidates", dry.candidatesReturned, 0);
  check("machine-adopted count is unchanged after the dry run", (await survey(prisma as unknown as RolloutDb)).machineAdopted, 2);

  // ── Apply ────────────────────────────────────────────────────────────────
  const applied = await runRollout(prisma as unknown as RolloutDb, { apply: true });
  check("apply returned both machine-adopted lessons", applied.candidatesReturned, 2);
  check("apply moved both findings", applied.findingsReturned, 2);

  check("machine-adopted lessons are gone", await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "firmId"=$1 AND "status"='ADOPTED' AND "approvedById" IS NULL`, FIRM), 0);
  check("they are queued, alongside the one already queued", await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "firmId"=$1 AND "status"='APPROVAL_PENDING'`, FIRM), 3);
  check("their adoptedAt was cleared", await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "id" IN ($1,$2) AND "adoptedAt" IS NULL`, IDS.machineA, IDS.machineB), 2);

  // ── The human decision is untouched, provenance and all ──────────────────
  check("the human-approved lesson is still ADOPTED", await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "id"=$1 AND "status"='ADOPTED'`, IDS.human), 1);
  check("its approver, timestamp and credential survive", await one(`SELECT count(*)::int AS n FROM "LearningCandidate" WHERE "id"=$1 AND "approvedById"='md-1' AND "approvedAt" IS NOT NULL AND "approverCredential"='MD, verified' AND "adoptedAt" IS NOT NULL`, IDS.human), 1);
  check("its finding still reads ADOPTED", await one(`SELECT count(*)::int AS n FROM "LearningFinding" WHERE "candidateId"=$1 AND "state"='ADOPTED'`, IDS.human), 1);
  check("the machine-adopted findings were returned to EVALUATED", await one(`SELECT count(*)::int AS n FROM "LearningFinding" WHERE "candidateId" IN ($1,$2) AND "state"='EVALUATED'`, IDS.machineA, IDS.machineB), 2);

  // ── Second apply must be a genuine no-op ─────────────────────────────────
  const snapshot = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT "id","status","adoptedAt","approvedById" FROM "LearningCandidate" WHERE "firmId"=$1 ORDER BY "id"`, FIRM,
  );
  const again = await runRollout(prisma as unknown as RolloutDb, { apply: true });
  check("the second apply changes nothing", again.candidatesReturned, 0);
  const after = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT "id","status","adoptedAt","approvedById" FROM "LearningCandidate" WHERE "firmId"=$1 ORDER BY "id"`, FIRM,
  );
  check("every row is byte-identical after re-running", JSON.stringify(after), JSON.stringify(snapshot));

  await cleanup();
  await prisma.$disconnect();

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
