// Learning pass: fold physician corrections + rejections from the transition
// ledger into LearnedPrior rows (firm-scoped). Deterministic; re-runnable.
//   npx tsx scripts/learn.ts
import { prisma } from "../src/lib/db";
import { aggregatePriors, scopeKeyOf, type CorrectionEvent, type RejectionTally } from "../src/lib/engine/learning";

async function main() {
  const transitions = await prisma.recommendationTransition.findMany({ orderBy: { createdAt: "asc" } });
  const items = new Map(
    (await prisma.futureCareItem.findMany({ select: { id: true, service: true, conditionKey: true, frequencyPerYear: true, durationYears: true } })).map((i) => [i.id, i]),
  );
  const byFirm = new Map<string, { corrections: CorrectionEvent[]; tallies: Map<string, { rejected: number; total: number }> }>();
  for (const t of transitions) {
    const it = items.get(t.itemId);
    if (!it) continue;
    let firm = byFirm.get(t.firmId);
    if (!firm) { firm = { corrections: [] as CorrectionEvent[], tallies: new Map<string, { rejected: number; total: number }>() }; }
    byFirm.set(t.firmId, firm);
    const scopeKey = scopeKeyOf(it.conditionKey, it.service);
    const decided = /PHYSICIAN_APPROVED|PHYSICIAN_MODIFIED|PHYSICIAN_REJECTED/.test(t.newStatus);
    if (decided) {
      const tally = firm.tallies.get(scopeKey) ?? { rejected: 0, total: 0 };
      tally.total++;
      if (/REJECTED/.test(t.newStatus)) tally.rejected++;
      firm.tallies.set(scopeKey, tally);
    }
    // Structured diffs only — legacy name-array rows carry no values to learn from.
    if (Array.isArray(t.modifiedFields)) {
      for (const m of t.modifiedFields as unknown[]) {
        if (m && typeof m === "object" && "field" in m && "to" in m) {
          const { field, to } = m as { field: string; to: unknown };
          if ((field === "frequencyPerYear" || field === "durationYears") && typeof to === "number") {
            firm.corrections.push({ scopeKey, field, to });
          }
        }
      }
    }
  }
  let rows = 0;
  for (const [firmId, data] of byFirm) {
    const priors = aggregatePriors(
      data.corrections,
      [...data.tallies.entries()].map(([scopeKey, v]): RejectionTally => ({ scopeKey, ...v })),
    );
    for (const p of priors) {
      await prisma.learnedPrior.upsert({
        where: { firmId_scopeKey_field: { firmId, scopeKey: p.scopeKey, field: p.field } },
        create: { firmId, scopeKey: p.scopeKey, field: p.field, learnedValue: p.learnedValue, sampleSize: p.sampleSize, support: p.support as never },
        update: { learnedValue: p.learnedValue, sampleSize: p.sampleSize, support: p.support as never },
      });
      rows++;
    }
  }
  console.log(`Learned priors upserted: ${rows} across ${byFirm.size} firm(s).`);
  await prisma.$disconnect();
}
main();
