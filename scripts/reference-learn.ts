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
import { CARE_PATTERN_VERSION } from "../src/lib/learning/carePatterns";
import { deriveStyleProfile, assertFactFree, styleGuidance, STYLE_PROFILE_VERSION, type StyleProfile } from "../src/lib/learning/referenceStyle";
import { REFERENCE_DOC_TYPES } from "../src/lib/reference/boundary";

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

  // Style learning, where finalized-report TEXT is available. Reference
  // documents are the only legitimate source; record documents are the
  // patient's own file and must never shape prose across cases.
  const reportDocs = await prisma.document.findMany({
    where: { type: { in: [...REFERENCE_DOC_TYPES] as never[] }, caseId: { in: included.map((c) => c.id) } },
    select: { extractedText: true },
  });
  let style: StyleProfile | null = null;
  if (reportDocs.length) {
    style = deriveStyleProfile(
      reportDocs.map((d) => ({ paragraphs: String(d.extractedText ?? "").split(/\n\s*\n/).filter((x) => x.trim().length > 40) })),
    );
    assertFactFree(style);
    console.log(`\nStyle profile from ${reportDocs.length} finalized report(s):`);
    for (const g of styleGuidance(style)) console.log(`  · ${g}`);
  } else {
    console.log("\nNo finalized-report documents attached to the reference cases, so no style");
    console.log("profile can be derived. Attach them as LIFE_CARE_PLAN / EXPERT_REPORT documents;");
    console.log("the boundary keeps them out of patient evidence (see reference/boundary.ts).");
  }

  if (!write) {
    console.log("\nDry run. Re-run with --write to persist.");
    await prisma.$disconnect();
    return;
  }

  const firmId = (await prisma.case.findFirst({ where: { id: included[0]?.id }, select: { firmId: true } }))?.firmId;
  if (!firmId) {
    console.error("No firm resolved; nothing persisted.");
    return;
  }
  // Store the immutable case ID, not the human-facing number. The consumer
  // checks eligibility with a case ID, and storing the number meant the two
  // never matched — so an approved artifact was silently rejected for every
  // case, and the learning path could never have fired.
  const holdOutCase = holdOut ? await prisma.case.findFirst({ where: { caseNumber: holdOut }, select: { id: true } }) : null;
  if (holdOut && !holdOutCase) {
    console.error(`--hold-out ${holdOut} does not match a case; refusing to persist an artifact whose hold-out cannot be enforced.`);
    return;
  }
  const heldOut = holdOutCase ? [holdOutCase.id] : [];
  await prisma.learnedArtifact.create({
    data: { firmId, kind: "CARE_PATTERNS", version: CARE_PATTERN_VERSION, payload: patterns as never, sampleSize: included.length, heldOut },
  });
  if (style) {
    await prisma.learnedArtifact.create({
      data: { firmId, kind: "STYLE_PROFILE", version: STYLE_PROFILE_VERSION, payload: style as never, sampleSize: reportDocs.length, heldOut },
    });
  }
  console.log(`\nPersisted as UNAPPROVED candidates (approvedById is null).`);
  console.log("Nothing consumes an unapproved artifact — a machine-derived lesson is a");
  console.log("candidate, and adoption is a person's act. See docs/reference-learning.md.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
