// Gold-standard harness — scores what the GENERATOR currently produces against
// the captured gold corpus. For each GoldCase (or just the named one), loads
// every CURRENT (non-superseded) FutureCareItem on the source case regardless
// of review status — the question is what generation produces, not what the
// physician kept — and scores it with scoreAgainstGold. Informational
// scorecard, not a CI gate: exit code is always 0.
//   npx tsx scripts/gold-harness.ts [name]
import { prisma } from "../src/lib/db";
import { PROBABILITY_NUMERIC, scoreAgainstGold, type GoldFixture, type GoldItem } from "../src/lib/engine/goldStandard";

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function main() {
  const [nameFilter] = process.argv.slice(2);
  const golds = await prisma.goldCase.findMany({ where: nameFilter ? { name: nameFilter } : {}, orderBy: { name: "asc" } });
  if (golds.length === 0) {
    console.log(nameFilter ? `No GoldCase named "${nameFilter}".` : "No GoldCases captured yet. Run scripts/gold-capture.ts first.");
    return;
  }

  const corpus: { name: string; f1: number; paramAcc: number }[] = [];
  for (const gold of golds) {
    console.log(`\n── Gold scorecard: ${gold.name} ─────────────────────────────`);
    if (!gold.sourceCaseId) {
      console.log("  (no sourceCaseId — nothing to score against)");
      continue;
    }
    const c = await prisma.case.findUnique({ where: { id: gold.sourceCaseId } });
    if (!c) {
      console.log(`  (source case ${gold.sourceCaseId} no longer exists)`);
      continue;
    }
    const items = await prisma.futureCareItem.findMany({ where: { caseId: c.id, supersededAt: null } });
    const generated: GoldItem[] = items.map((i) => ({
      service: i.service,
      category: i.category,
      probability: PROBABILITY_NUMERIC[i.probability] ?? undefined,
      frequencyPerYear: i.frequencyPerYear,
      durationYears: i.durationYears ?? undefined,
      isLifetime: i.isLifetime,
    }));
    const actualPV = Math.round(items.reduce((sum, i) => sum + i.presentValue, 0));

    const fixture = gold.fixture as unknown as GoldFixture;
    if (fixture.expectedItems.length === 0 && fixture.expectedExclusions.length === 0) {
      console.log(`Case: ${c.caseNumber} · ${c.clientName} — VACUOUS fixture (no expected items or exclusions); nothing to score. Re-capture after physician review.`);
      continue;
    }
    const s = scoreAgainstGold(generated, fixture, { presentValue: actualPV });
    corpus.push({ name: gold.name, f1: s.f1, paramAcc: s.parameterAccuracy });

    console.log(`Case: ${c.caseNumber} · ${c.clientName} — ${generated.length} current generated item(s) vs ${fixture.expectedItems.length} gold item(s), ${fixture.expectedExclusions.length} exclusion(s)`);
    console.log(`Items: precision ${pct(s.itemPrecision)} · recall ${pct(s.itemRecall)} · F1 ${pct(s.f1)}`);
    console.log(`Parameter accuracy (within 25%): ${pct(s.parameterAccuracy)}`);
    const goldPV = fixture.totals?.presentValue;
    console.log(`Totals: PV $${actualPV.toLocaleString()} vs gold $${goldPV != null ? goldPV.toLocaleString() : "—"} → ${s.totalsWithinTolerance == null ? "n/a" : s.totalsWithinTolerance ? `within ±${fixture.totals?.tolerancePct ?? 10}%` : `OUTSIDE ±${fixture.totals?.tolerancePct ?? 10}%`}`);
    if (s.missing.length) { console.log(`Missing (${s.missing.length}):`); for (const m of s.missing) console.log(`  − ${m}`); }
    if (s.unexpected.length) { console.log(`Unexpected (${s.unexpected.length}):`); for (const u of s.unexpected) console.log(`  + ${u}`); }
    if (s.excludedButPresent.length) { console.log(`EXCLUSION VIOLATIONS (${s.excludedButPresent.length}):`); for (const x of s.excludedButPresent) console.log(`  ✗ ${x}`); }
    const withDeltas = s.matched.filter((m) => m.deltas.length);
    if (withDeltas.length) {
      console.log(`Parameter deltas (>25% off) on ${withDeltas.length} matched item(s):`);
      for (const m of withDeltas) for (const d of m.deltas) console.log(`  Δ ${m.service} · ${d.field}: expected ${d.expected}, got ${d.actual}`);
    }
    // Self-capture caveat: when the source case's current items carry physician
    // review decisions, the reviewed values ARE the fixture by construction.
    const reviewedNow = items.filter((i) => i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED").length;
    if (reviewedNow > 0) {
      console.log(`Caveat: ${reviewedNow}/${items.length} current item(s) carry physician review — post-review values overlap the fixture by construction, so this self-capture score is optimistic. The harness earns its keep when generation changes or new cases are scored against this corpus.`);
    }
  }

  if (corpus.length) {
    const avg = (f: (x: (typeof corpus)[number]) => number) => corpus.reduce((s, x) => s + f(x), 0) / corpus.length;
    console.log(`\n── Corpus summary ───────────────────────────────────────────`);
    console.log(`${corpus.length} gold case(s) scored · mean F1 ${pct(avg((x) => x.f1))} · mean parameter accuracy ${pct(avg((x) => x.paramAcc))}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
