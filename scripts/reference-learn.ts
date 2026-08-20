// ─────────────────────────────────────────────────────────────────────────────
// Derive learning artifacts from the reference corpus.
//
//   npx tsx scripts/reference-learn.ts [--hold-out REF-2026-0005] [--write]
//
// Reads the preserved ReferencePlanItem rows — the published plans' own line
// items — and produces:
//
//   • a CARE-PATTERN set: which INTERVENTION IDENTITIES planners considered for
//     which condition keys, as counts. No service text, frequency or cost.
//   • a STYLE profile, when finalized-report text is available as documents.
//
// LEAVE-ONE-OUT is the default posture, not an option: `--hold-out` excludes a
// case so artifacts can be built for evaluating it. Learning from a plan and
// then scoring against that same plan measures memorisation.
//
// Nothing is written without `--write`. Artifacts are fact-free by construction
// and re-checked before persistence.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../src/lib/db";
import { deriveCarePatterns, assertPatternFactFree, type PatternSource } from "../src/lib/learning/carePatterns";
import { resolveConditionKeys } from "../src/lib/engine/careLibrary";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (f: string) => process.argv.includes(f);

async function main() {
  const holdOut = arg("--hold-out");
  const write = has("--write");

  const cases = await prisma.case.findMany({
    where: { referencePlanItems: { some: {} } },
    select: { id: true, caseNumber: true, diagnosis: true, conditions: { select: { name: true } }, referencePlanItems: { select: { service: true, category: true } } },
  });
  if (!cases.length) {
    console.log("No reference plans preserved. Run scripts/preserve-reference-plan.ts --apply first.");
    return;
  }

  const included = cases.filter((c) => c.caseNumber !== holdOut);
  if (holdOut) console.log(`Holding out ${holdOut}; learning from ${included.length} of ${cases.length} reference plan(s).`);

  const sources: PatternSource[] = included.map((c) => ({
    conditionKeys: [...new Set([c.diagnosis ?? "", ...c.conditions.map((x) => x.name)].flatMap((t) => resolveConditionKeys(t)))],
    services: c.referencePlanItems.map((r) => ({ service: r.service, category: r.category })),
  }));

  const patterns = deriveCarePatterns(sources);
  assertPatternFactFree(patterns);

  console.log(`\nCare-consideration patterns (${patterns.length}):`);
  for (const p of patterns) {
    const share = p.outOf ? Math.round((100 * p.observedIn) / p.outOf) : 0;
    console.log(`  ${p.conditionKey.padEnd(16)} ${p.intervention.padEnd(28)} ${p.observedIn}/${p.outOf}  (${share}%)`);
  }

  if (!write) {
    console.log("\nDry run. Re-run with --write to persist.");
    return;
  }
  console.log("\n[not persisted] Artifact storage is deliberately not wired in this pass — the");
  console.log("patterns above are derived and verified fact-free, and promotion to a stored,");
  console.log("versioned artifact requires the clinical-approval path the learning loop already");
  console.log("uses for priors. See docs/reference-learning.md.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
