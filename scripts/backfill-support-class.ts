// ─────────────────────────────────────────────────────────────────────────────
// Classify rows that predate `supportClass`.
//
// The column defaults to CANDIDATE_REVIEW. That fails CLOSED for a new row —
// correct — and is wrong for an existing one: a plan a physician approved
// months ago would show almost nothing in its supported total, because the
// default says "awaiting support" about care that was already adopted.
//
// The backfill uses `classifyExistingItem`, the SAME function the review routes
// call, so a backfilled row and a freshly-reviewed row cannot disagree. It is
// idempotent (rows already carrying the right class are skipped) and it reports
// the totals shift per case BEFORE writing, so the change to a headline number
// is never silent.
//
//   npx tsx scripts/backfill-support-class.ts [--case <caseId>] [--apply]
//
// Default is a dry run.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../src/lib/db";
import { classifyExistingItem, needsReclassification } from "../src/lib/engine/reviewDecision";
import { computePlanTotals } from "../src/lib/engine/supportClass";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const M = (n: number) => "$" + Math.round(n).toLocaleString();

async function main() {
  const caseId = arg("--case");
  const apply = process.argv.includes("--apply");

  const cases = await prisma.case.findMany({
    where: caseId ? { id: caseId } : {},
    select: { id: true, caseNumber: true },
    orderBy: { caseNumber: "asc" },
  });

  let totalChanged = 0;
  for (const c of cases) {
    const items = await prisma.futureCareItem.findMany({ where: { caseId: c.id, supersededAt: null } });
    if (!items.length) continue;
    const stale = items.filter(needsReclassification);
    if (!stale.length) continue;

    const before = computePlanTotals(items);
    const after = computePlanTotals(items.map((i) => ({ ...i, supportClass: classifyExistingItem(i).supportClass })));
    console.log(
      `${c.caseNumber}: ${stale.length}/${items.length} rows reclassified · ` +
        `supported ${M(before.supported.presentValue)} → ${M(after.supported.presentValue)} ` +
        `(${before.supported.items} → ${after.supported.items} items)`,
    );
    for (const i of stale.slice(0, 5)) {
      const v = classifyExistingItem(i);
      console.log(`    ${String(i.service).slice(0, 44).padEnd(44)} ${String(i.supportClass).padEnd(20)} → ${v.supportClass}`);
    }
    if (stale.length > 5) console.log(`    …and ${stale.length - 5} more`);

    totalChanged += stale.length;
    if (!apply) continue;
    for (const i of stale) {
      const v = classifyExistingItem(i);
      await prisma.futureCareItem.update({ where: { id: i.id }, data: { supportClass: v.supportClass, supportReason: v.reason } });
    }
  }

  if (!totalChanged) console.log("Every row already carries the classification it should. Nothing to do.");
  else if (!apply) console.log(`\nDry run — ${totalChanged} row(s) would change. Re-run with --apply.`);
  else console.log(`\nApplied to ${totalChanged} row(s).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
