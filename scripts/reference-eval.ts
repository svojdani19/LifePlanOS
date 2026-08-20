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

    // GENERATOR OUTPUT ONLY. Everything a person touched is excluded here, not
    // filtered downstream, so a contaminated set cannot be scored by accident.
    const generated = (await prisma.futureCareItem.findMany({
      where: {
        caseId: rc.caseId,
        supersededAt: null,
        origin: { in: ["TEMPLATE_CONDITION", "TEMPLATE_BASELINE", "RECORD_RECOMMENDED"] },
        physicianStatus: { notIn: ["APPROVED", "MODIFIED"] },
      },
    })).map<ScoredItem>((i) => ({
      service: i.service,
      category: String(i.category),
      frequencyPerYear: i.frequencyPerYear,
      durationYears: i.durationYears,
      isLifetime: i.isLifetime,
      presentValue: i.presentValue,
      origin: i.origin,
      physicianStatus: i.physicianStatus,
    }));

    console.log(`\n${"═".repeat(78)}\n ${c?.caseNumber ?? rc.caseId} — blind future-care evaluation\n${"═".repeat(78)}`);
    console.log(` published concepts: ${published.length}   generator candidates: ${generated.length}`);

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
