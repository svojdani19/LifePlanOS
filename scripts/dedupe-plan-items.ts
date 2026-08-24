/**
 * Repair future-care items duplicated by overlapping plan generations.
 *
 * `generatePlan` used to run without mutual exclusion (see engine/pipelineLock.ts).
 * Records review fires it in the background on every published note, so a
 * reviewer working a queue launched overlapping runs whose resets all landed
 * before any of their writes — and each run then wrote a complete plan. One
 * demo case ended up carrying each of its thirty-four care items three times.
 *
 * The lock stops new duplicates. This removes the ones already written.
 *
 * Conditions are NOT handled here: the migration that adds
 * `@@unique([caseId, name])` repairs those, because the index cannot be built
 * until it has.
 *
 * What it will not do:
 *   • touch a superseded row — that is preserved review history, by design;
 *   • touch an authored row (PLANNER_ADDED / PHYSICIAN_ADDED) — a professional
 *     put it there, and two same-named authored items is a judgement call for a
 *     person, not this script;
 *   • delete a row carrying review history when a duplicate of it also carries
 *     review history. Two reviewed copies is a conflict a human must resolve,
 *     so the group is reported and skipped.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx scripts/dedupe-plan-items.ts
 *   npx tsx scripts/dedupe-plan-items.ts --apply
 *   npx tsx scripts/dedupe-plan-items.ts --case REF-2026-0005 --apply
 */
import { prisma } from "../src/lib/db";
import { hasReviewHistory } from "../src/lib/engine/lifecycle";
import { AUTHORED_ORIGINS } from "../src/lib/reference/origins";

const apply = process.argv.includes("--apply");
const caseArgIndex = process.argv.indexOf("--case");
const caseRef = caseArgIndex >= 0 ? process.argv[caseArgIndex + 1] : null;

/** Same identity the generator's own dedupe uses: a service within a category. */
const identity = (i: { category: string; service: string }) => `${i.category}::${i.service.trim().toLowerCase()}`;

async function main() {
  const cases = await prisma.case.findMany({
    where: caseRef ? { caseNumber: caseRef } : {},
    select: { id: true, caseNumber: true },
    orderBy: { createdAt: "asc" },
  });
  if (caseRef && !cases.length) {
    console.error(`No case with reference ${caseRef}.`);
    process.exitCode = 1;
    return;
  }

  let totalDeleted = 0;
  let totalConflicts = 0;

  for (const kase of cases) {
    const items = await prisma.futureCareItem.findMany({
      where: { caseId: kase.id, supersededAt: null },
      select: {
        id: true, category: true, service: true, origin: true, createdAt: true,
        physicianStatus: true, physicianNote: true, edited: true,
        presentValue: true, lifetimeCost: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const groups = new Map<string, typeof items>();
    for (const item of items) {
      if (AUTHORED_ORIGINS.has(item.origin)) continue; // a person put it there
      const key = identity(item);
      const bucket = groups.get(key) ?? [];
      bucket.push(item);
      groups.set(key, bucket);
    }

    const doomed: string[] = [];
    const conflicts: string[] = [];
    for (const [key, bucket] of groups) {
      if (bucket.length < 2) continue;
      const reviewed = bucket.filter(hasReviewHistory);
      if (reviewed.length > 1) {
        // Two copies a physician has acted on. Deleting either destroys a
        // person's recorded decision, so this is reported, not resolved.
        conflicts.push(`${key} — ${reviewed.length} reviewed copies`);
        continue;
      }
      // Keep the reviewed copy if there is one; otherwise the earliest, which
      // is the id anything else already points at.
      const keep = reviewed[0] ?? bucket[0];
      for (const item of bucket) if (item.id !== keep.id) doomed.push(item.id);
    }

    if (!doomed.length && !conflicts.length) continue;

    const distinct = new Set([...groups.keys()]).size;
    console.log(`\n${kase.caseNumber}: ${items.length} live item(s), ${distinct} distinct service(s)`);
    if (doomed.length) console.log(`  duplicates to remove: ${doomed.length}`);
    for (const c of conflicts) console.log(`  CONFLICT (skipped): ${c}`);

    totalDeleted += doomed.length;
    totalConflicts += conflicts.length;

    if (apply && doomed.length) {
      // Transitions and any other child rows referencing these items are left
      // to their own FK rules; nothing here rewrites review history.
      const { count } = await prisma.futureCareItem.deleteMany({ where: { id: { in: doomed }, caseId: kase.id } });
      console.log(`  deleted ${count}`);
    }
  }

  console.log(
    `\n${apply ? "Removed" : "Would remove"} ${totalDeleted} duplicate item(s)` +
      (totalConflicts ? `; ${totalConflicts} group(s) need a human decision` : "") +
      (apply ? "." : ". Re-run with --apply to write."),
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
