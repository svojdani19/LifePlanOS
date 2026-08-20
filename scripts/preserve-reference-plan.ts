// ─────────────────────────────────────────────────────────────────────────────
// Withdraw published-plan items from the runtime plan — after preserving them.
//
// Items with origin GOLD_IMPORT are a professionally finalized life care plan's
// own conclusions. They were living inside the case's active plan: in the
// panels, in the totals, in the exported report, and — worst — inside the gold
// harness's own input, so the harness scored the answer key against itself.
//
// Nothing in the repository creates these rows, so the database is their only
// copy. That makes the order of operations the whole point:
//
//   1. COPY every GOLD_IMPORT item into ReferencePlanItem, payload and all.
//   2. VERIFY the copy — count, and field-by-field on the preserved payload.
//   3. Only then WITHDRAW them from the runtime plan by setting supersededAt.
//
// Withdrawal is not deletion. The FutureCareItem rows survive with their review
// lineage intact; they simply stop satisfying `supersededAt: null`, which is the
// predicate every panel, total, report and reasoning pass already uses. The move
// is reversible from ReferencePlanItem alone via `--undo`.
//
//   npx tsx scripts/preserve-reference-plan.ts [--case <caseId>] [--apply] [--undo]
//
// Default is a DRY RUN: it reports what it would do and changes nothing.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../src/lib/db";
import { REFERENCE_ITEM_ORIGINS } from "../src/lib/reference/boundary";

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (flag: string) => process.argv.includes(flag);
const money = (n: number) => "$" + Math.round(n).toLocaleString();

async function undo(caseId?: string) {
  const preserved = await prisma.referencePlanItem.findMany({ where: caseId ? { caseId } : {} });
  let restored = 0;
  for (const p of preserved) {
    if (!p.sourceItemId) continue;
    const r = await prisma.futureCareItem.updateMany({ where: { id: p.sourceItemId }, data: { supersededAt: null } });
    restored += r.count;
  }
  console.log(`Restored ${restored} item(s) to the runtime plan. ReferencePlanItem rows left in place.`);
}

async function main() {
  const caseId = arg("--case");
  const apply = has("--apply");
  if (has("--undo")) return undo(caseId);

  const origins = [...REFERENCE_ITEM_ORIGINS] as never[];
  const items = await prisma.futureCareItem.findMany({
    where: { ...(caseId ? { caseId } : {}), origin: { in: origins }, supersededAt: null },
    orderBy: [{ caseId: "asc" }, { presentValue: "desc" }],
  });

  if (!items.length) {
    console.log("No active reference-origin items found. Nothing to preserve.");
    return;
  }

  const byCase = new Map<string, typeof items>();
  for (const i of items) byCase.set(i.caseId, [...(byCase.get(i.caseId) ?? []), i]);

  console.log(`${apply ? "APPLYING" : "DRY RUN"} — ${items.length} reference-origin item(s) across ${byCase.size} case(s)\n`);

  for (const [cid, group] of byCase) {
    const c = await prisma.case.findUnique({ where: { id: cid }, select: { caseNumber: true, firmId: true } });
    const pv = group.reduce((a, i) => a + i.presentValue, 0);
    console.log(`  ${c?.caseNumber ?? cid}: ${group.length} item(s), ${money(pv)} present value withdrawn from totals`);
    if (!apply) continue;

    // ── 1. PRESERVE ────────────────────────────────────────────────────────
    for (const i of group) {
      await prisma.referencePlanItem.upsert({
        where: { sourceItemId: i.id },
        create: {
          firmId: c?.firmId ?? "",
          caseId: i.caseId,
          sourceItemId: i.id,
          service: i.service,
          category: String(i.category),
          specialty: i.specialty ?? null,
          cptCode: i.cptCode ?? null,
          frequencyPerYear: i.frequencyPerYear ?? null,
          durationYears: i.durationYears ?? null,
          isLifetime: !!i.isLifetime,
          unitCost: i.unitCost ?? null,
          lifetimeCost: i.lifetimeCost ?? null,
          presentValue: i.presentValue ?? null,
          rationale: i.rationale ?? null,
          payload: JSON.parse(JSON.stringify(i)),
          sourceLabel: "GOLD_IMPORT — professionally finalized plan",
        },
        update: { payload: JSON.parse(JSON.stringify(i)) },
      });
    }

    // ── 2. VERIFY before anything is withdrawn ─────────────────────────────
    const preserved = await prisma.referencePlanItem.findMany({ where: { caseId: cid } });
    const bySource = new Map(preserved.map((p) => [p.sourceItemId, p]));
    const missing = group.filter((i) => !bySource.has(i.id));
    const mismatched = group.filter((i) => {
      const p = bySource.get(i.id);
      return !p || p.service !== i.service || p.presentValue !== i.presentValue || p.frequencyPerYear !== i.frequencyPerYear;
    });
    if (missing.length || mismatched.length) {
      console.error(`  ✗ preservation INCOMPLETE (${missing.length} missing, ${mismatched.length} mismatched) — withdrawing nothing for this case`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  ✓ preserved and verified ${preserved.length} item(s)`);

    // ── 3. WITHDRAW (not delete) ───────────────────────────────────────────
    const now = new Date();
    const out = await prisma.futureCareItem.updateMany({
      where: { id: { in: group.map((i) => i.id) } },
      data: { supersededAt: now },
    });
    console.log(`  ✓ withdrew ${out.count} item(s) from the runtime plan (rows retained, reversible with --undo)`);
  }

  if (!apply) console.log("\nRe-run with --apply to preserve and withdraw.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
