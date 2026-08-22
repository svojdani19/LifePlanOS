// Rollout preflight + backfill runner.
//
//   npx tsx scripts/rollout-backfill.ts            # dry run, changes nothing
//   npx tsx scripts/rollout-backfill.ts --apply    # performs the backfill
//
// Dry run is the default and --apply is the only way past it. The logic lives
// in src/lib/ops/rolloutBackfill.ts so it can be reviewed and tested on its
// own; this file is the entry point, the confirmation, and the exit code.
//
// See docs/ROLLOUT.md for the ordered steps and the rollback.

import { prisma } from "@/lib/db";
import { runRollout, type RolloutDb } from "@/lib/ops/rolloutBackfill";

async function main() {
  const apply = process.argv.includes("--apply");

  // Print the target host without its credentials. A rollout script that echoes
  // a connection string puts a password in every terminal scrollback and CI log
  // that ever runs it.
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => {
    try { return new URL(url).host; } catch { return "(unparseable DATABASE_URL)"; }
  })();
  console.log(`Target: ${host}`);
  console.log(`Mode:   ${apply ? "APPLY — rows will be changed" : "DRY RUN — nothing will be changed"}`);
  console.log("");

  const report = await runRollout(prisma as unknown as RolloutDb, { apply });
  for (const line of report.log) console.log(line);

  await prisma.$disconnect();

  // Non-zero when the schema is not ready, so a CI step or a shell chain stops
  // rather than reporting a rollout that never ran as a success.
  if (!report.schema.ok) process.exit(2);
  if (apply && report.after && report.after.machineAdopted !== 0) process.exit(3);
}

main().catch(async (err) => {
  console.error(`Rollout failed: ${err instanceof Error ? err.message : String(err)}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
