// ─────────────────────────────────────────────────────────────────────────────
// Blind evaluation: what did the GENERATOR find, measured against the plan a
// professional published?
//
// The answer key is ReferencePlanItem — the published plan's own line items,
// preserved out of the runtime plan. The candidate set is the generator's own
// output only: reference imports, physician additions and reviewed items are
// excluded, and `assertBlind` refuses the run rather than flattering it.
//
//   npx tsx scripts/reference-eval.ts [caseNumber]
//
// Per-case results, never only an average: with five reference cases an
// aggregate hides exactly the variation that matters.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../src/lib/db";
import { scoreFutureCareAgreement, type ScoredItem } from "../src/lib/learning/futureCareAgreement";

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const money = (n: number) => "$" + Math.round(n).toLocaleString();

async function main() {
  const [filter] = process.argv.slice(2);
  const refCases = await prisma.referencePlanItem.groupBy({ by: ["caseId"], _count: { _all: true } });
  if (!refCases.length) {
    console.log("No ReferencePlanItem rows. Run scripts/preserve-reference-plan.ts --apply first.");
    return;
  }

  for (const rc of refCases) {
    const c = await prisma.case.findUnique({ where: { id: rc.caseId }, select: { caseNumber: true, clientName: true } });
    if (filter && c?.caseNumber !== filter) continue;

    const published = (await prisma.referencePlanItem.findMany({ where: { caseId: rc.caseId } })).map<ScoredItem>((r) => ({
      service: r.service,
      category: r.category,
      frequencyPerYear: r.frequencyPerYear,
      durationYears: r.durationYears,
      isLifetime: r.isLifetime,
      presentValue: r.presentValue,
    }));

    // THE FROZEN SNAPSHOT, not the live plan.
    //
    // This used to query current rows and filter out reviewed ones. A filter is
    // not a freeze: an item a planner EDITED keeps its generator origin and a
    // PENDING status, so edited output scored as generator output. The
    // hand-written origin list also omitted TEMPLATE_SPECIALTY, leaving a whole
    // generator path unscored.
    const snapshot = await prisma.generatorSnapshot?.findFirst({
      where: { caseId: rc.caseId },
      orderBy: { takenAt: "desc" },
    }).catch(() => null);
    if (!snapshot) {
      console.log(`\n${c?.caseNumber ?? rc.caseId}: no generator snapshot — regenerate the plan to freeze one, then re-run.`);
      continue;
    }
    const generated = (snapshot.items as unknown as ScoredItem[]).map<ScoredItem>((i) => ({
      service: i.service,
      category: i.category ?? null,
      frequencyPerYear: i.frequencyPerYear,
      durationYears: i.durationYears,
      isLifetime: i.isLifetime,
      presentValue: i.presentValue,
      origin: i.origin,
    }));

    console.log(`\n${"═".repeat(78)}\n ${c?.caseNumber ?? rc.caseId} — blind future-care evaluation\n${"═".repeat(78)}`);
    console.log(` published concepts: ${published.length}   generator candidates: ${generated.length}   snapshot ${snapshot.takenAt.toISOString().slice(0, 19)}`);

    const s = scoreFutureCareAgreement(generated, published);
    console.log(`\n  precision ${pct(s.precision)}   recall ${pct(s.recall)}   F1 ${pct(s.f1)}`);
    console.log(`  dollar-weighted recall ${pct(s.dollarWeightedRecall)}  (published PV ${money(s.publishedPV)}, generated PV ${money(s.generatedPV)})`);
    console.log(`  frequency agreement ${pct(s.frequencyAgreement)}   duration ${pct(s.durationAgreement)}   lifetime ${pct(s.lifetimeAgreement)}`);

    console.log(`\n  recall by family:`);
    for (const f of s.familyRecall) console.log(`    ${f.family.padEnd(24)} ${f.found}/${f.published}`);

    console.log(`\n  MATCHED (${s.matched.length}):`);
    for (const m of s.matched) {
      const flags = [m.frequencyAgrees === false ? "freq✗" : "", m.durationAgrees === false ? "dur✗" : "", m.kind !== "EXACT" ? m.kind.toLowerCase() : ""].filter(Boolean).join(" ");
      console.log(`    ✓ ${m.intervention.padEnd(28)} ${m.published[0].service.slice(0, 40).padEnd(40)} ${flags}`);
    }
    console.log(`\n  MISSED (${s.missed.length}) — published, never proposed:`);
    for (const m of s.missed.sort((a, b) => b.publishedPV - a.publishedPV)) {
      console.log(`    ✗ ${m.intervention.padEnd(28)} ${m.items[0].service.slice(0, 40).padEnd(40)} ${money(m.publishedPV)}`);
    }
    console.log(`\n  UNEXPECTED (${s.unexpected.length}) — proposed, not published (needs clinical adjudication):`);
    for (const u of s.unexpected.sort((a, b) => b.generatedPV - a.generatedPV)) {
      console.log(`    ? ${u.intervention.padEnd(28)} ${u.items[0].service.slice(0, 40).padEnd(40)} ${money(u.generatedPV)}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
