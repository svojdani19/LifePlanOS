// Gold-standard capture — freezes a physician-reviewed case as a GoldCase
// fixture. The reviewed plan IS the gold answer: APPROVED/MODIFIED current
// items become expectedItems with their post-review numeric values (the
// physician-corrected truth), REJECTED items become expectedExclusions, and
// the summed present value becomes the totals target (±10%). Nothing is
// invented — every value comes from the case as reviewed.
//   npx tsx scripts/gold-capture.ts <caseId> <name>
import { prisma } from "../src/lib/db";
import { PROBABILITY_NUMERIC, type GoldFixture, type GoldItem } from "../src/lib/engine/goldStandard";

async function main() {
  const [caseId, name] = process.argv.slice(2);
  if (!caseId || !name) {
    console.error("Usage: npx tsx scripts/gold-capture.ts <caseId> <name>");
    process.exitCode = 1;
    return;
  }

  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const items = await prisma.futureCareItem.findMany({
    where: { caseId, supersededAt: null },
    orderBy: { presentValue: "desc" },
  });

  const reviewed = items.filter((i) => i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED");
  const rejected = items.filter((i) => i.physicianStatus === "REJECTED");
  const pending = items.length - reviewed.length - rejected.length;

  const expectedItems: GoldItem[] = reviewed.map((i) => ({
    service: i.service,
    category: i.category,
    probability: PROBABILITY_NUMERIC[i.probability] ?? undefined,
    frequencyPerYear: i.frequencyPerYear,
    durationYears: i.durationYears ?? undefined,
    isLifetime: i.isLifetime,
  }));
  const presentValue = reviewed.reduce((sum, i) => sum + i.presentValue, 0);
  const fixture: GoldFixture = {
    expectedItems,
    expectedExclusions: rejected.map((i) => i.service),
    totals: { presentValue: Math.round(presentValue), tolerancePct: 10 },
  };

  const gold = await prisma.goldCase.upsert({
    where: { name },
    create: {
      firmId: c.firmId,
      name,
      sourceCaseId: c.id,
      fixture: fixture as never,
      notes: `Captured from ${c.caseNumber} (${c.clientName}) — ${reviewed.length} reviewed items, ${rejected.length} exclusions.`,
    },
    update: { sourceCaseId: c.id, fixture: fixture as never, capturedAt: new Date() },
  });

  console.log("── Gold capture ─────────────────────────────────────────────");
  console.log(`Case: ${c.caseNumber} · ${c.clientName} (${c.id})`);
  console.log(`GoldCase: "${gold.name}" (${gold.id})`);
  console.log(`Expected items (APPROVED/MODIFIED): ${expectedItems.length}`);
  for (const it of expectedItems) {
    console.log(`  • ${it.service} — ${it.frequencyPerYear}/yr ${it.isLifetime ? "for life" : it.durationYears ? `× ${it.durationYears}y` : "one-time"} · p=${it.probability ?? "?"}`);
  }
  console.log(`Exclusions (REJECTED): ${fixture.expectedExclusions.length}`);
  for (const s of fixture.expectedExclusions) console.log(`  ✗ ${s}`);
  console.log(`Totals target: PV $${fixture.totals!.presentValue!.toLocaleString()} ± ${fixture.totals!.tolerancePct}%`);
  if (pending > 0) console.log(`Note: ${pending} current item(s) still PENDING were not captured — the fixture only trusts physician-reviewed lines.`);
  if (expectedItems.length === 0 && fixture.expectedExclusions.length === 0) {
    console.log("WARNING: the fixture is EMPTY — this case has no physician-reviewed (APPROVED/MODIFIED/REJECTED) current items. Complete physician review, then re-capture; the harness will report this fixture as vacuous until then.");
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
