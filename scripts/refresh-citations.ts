// Re-apply the current citation-relevance policy to EVERY case in the database.
//
// Article citations on future-care items are produced by enrichCitations() (the
// same function the generation pipeline runs), so new cases are always current.
// This script brings EXISTING cases up to the latest policy in one pass — run it
// after any change to the relevance ranking, or to backfill cases created before
// a policy update.
//
//   npm run citations:refresh            # every case that has a plan
//   npm run citations:refresh -- <caseId|clientName>   # a single case
//
// Safe to re-run: enrichCitations overwrites each item's citations idempotently.

import { prisma } from "../src/lib/db";
import { enrichCitations } from "../src/lib/engine/generate";

async function main() {
  const filter = process.argv[2]?.trim();
  const cases = await prisma.case.findMany({
    where: filter ? { OR: [{ id: filter }, { clientName: { contains: filter, mode: "insensitive" } }] } : undefined,
    select: { id: true, clientName: true, _count: { select: { futureCareItems: true } } },
    orderBy: { createdAt: "asc" },
  });

  const withPlans = cases.filter((c) => c._count.futureCareItems > 0);
  const skipped = cases.length - withPlans.length;
  if (!withPlans.length) {
    console.log(`No cases with future-care items to refresh${filter ? ` for "${filter}"` : ""}.`);
    return;
  }
  console.log(`Refreshing citations for ${withPlans.length} case(s)${skipped ? ` (${skipped} without a plan skipped)` : ""}…\n`);

  let ok = 0;
  for (const c of withPlans) {
    process.stdout.write(`• ${c.clientName} (${c._count.futureCareItems} items) … `);
    try {
      const n = await enrichCitations(c.id);
      console.log(`cited ${n}/${c._count.futureCareItems}`);
      ok++;
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`\nDone — ${ok}/${withPlans.length} case(s) refreshed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
