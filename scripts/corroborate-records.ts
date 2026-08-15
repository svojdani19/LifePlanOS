// ─────────────────────────────────────────────────────────────────────────────
// Backfill machine corroboration for a case's existing extracted rows.
//
//   npm run records:corroborate -- <caseId|caseNumber>
//
// Live extraction runs corroborate as they finish; this covers rows extracted
// before the tier existed. Same discipline: only rows meeting the
// deterministic bar get an independent blind read, comparison is server-side,
// failures record nothing, and nothing here verifies anything — a
// corroborated row still waits for a human.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@/generated/prisma";
import { corroborateRows, type CorroborationRow } from "@/lib/records/corroboration";

const db = new PrismaClient();

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("usage: npm run records:corroborate -- <caseId|caseNumber>");
    process.exit(1);
  }
  const theCase = await db.case.findFirst({
    where: { OR: [{ id: key }, { caseNumber: key }] },
    select: { id: true, caseNumber: true },
  });
  if (!theCase) {
    console.error(`no case matches "${key}"`);
    process.exit(1);
  }

  const documents = await db.document.findMany({
    where: { caseId: theCase.id },
    select: { id: true, filename: true, extractedText: true },
  });

  let candidates = 0;
  let asked = 0;
  let corroborated = 0;
  let failed = 0;
  for (const doc of documents) {
    const fetched = await db.extractedEncounter.findMany({
      where: { caseId: theCase.id, sourceDocumentId: doc.id, status: "AI_AUDIT_PASSED" },
      select: { id: true, status: true, dateStatus: true, page: true, pageEnd: true, warnings: true, claims: true, corroboration: true },
    });
    // Only rows not yet corroborated (JSON-null filtering is clearer here).
    const rows = fetched.filter((r) => r.corroboration == null) as CorroborationRow[];
    if (!rows.length) continue;
    const outcome = await corroborateRows(rows, doc.extractedText ?? "");
    for (const [rowId, verdict] of outcome.verdicts) {
      await db.extractedEncounter.update({ where: { id: rowId }, data: { corroboration: verdict as never } });
    }
    candidates += outcome.candidates;
    asked += outcome.asked;
    corroborated += outcome.corroborated;
    failed += outcome.failed;
    if (outcome.asked) {
      console.log(`  ${doc.filename}: ${outcome.candidates} candidate(s), ${outcome.corroborated} corroborated, ${outcome.failed} failed`);
    }
  }
  console.log(`\ncase ${theCase.caseNumber}: ${candidates} candidates, ${asked} asked, ${corroborated} corroborated, ${failed} failed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
