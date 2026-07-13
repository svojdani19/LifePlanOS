// Backfill the Clinical Reasoning Engine assessments for EVERY existing case.
//
// New/regenerated plans get assessed automatically (the generate and physician
// routes call persistCaseReasoning). This script brings cases created before the
// engine — or before a reasoning-policy change — up to date in one pass.
//
//   npm run reasoning:backfill                         # every case with a plan
//   npm run reasoning:backfill -- <caseId|clientName>  # a single case
//
// Safe to re-run: persistCaseReasoning upserts by (caseId, recommendationId) and
// leaves unchanged assessments (same material hash) untouched.

import { prisma } from "../src/lib/db";
import { persistCaseReasoning } from "../src/lib/engine/clinicalReasoningPersist";

async function main() {
  const filter = process.argv[2]?.trim();
  const cases = await prisma.case.findMany({
    where: filter ? { OR: [{ id: filter }, { clientName: { contains: filter, mode: "insensitive" } }] } : undefined,
    select: { id: true, firmId: true, clientName: true, _count: { select: { futureCareItems: true } } },
    orderBy: { createdAt: "asc" },
  });

  const withPlans = cases.filter((c) => c._count.futureCareItems > 0);
  const skipped = cases.length - withPlans.length;
  if (!withPlans.length) {
    console.log(`No cases with future-care items to assess${filter ? ` for "${filter}"` : ""}.`);
    return;
  }
  console.log(`Assessing ${withPlans.length} case(s)${skipped ? ` (${skipped} without a plan skipped)` : ""}…\n`);

  let ok = 0;
  for (const c of withPlans) {
    process.stdout.write(`• ${c.clientName} (${c._count.futureCareItems} items) … `);
    try {
      const assessments = await persistCaseReasoning(c.id, c.firmId);
      console.log(`assessed ${assessments.length}`);
      ok++;
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`\nDone — ${ok}/${withPlans.length} case(s) assessed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
