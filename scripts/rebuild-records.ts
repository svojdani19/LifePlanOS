// ─────────────────────────────────────────────────────────────────────────────
// Rebuild a case's records list and medical chronology from its extracted rows.
//
//   npm run records:rebuild -- <caseId|caseNumber>
//   npm run records:rebuild -- REF-2026-0005 --dry-run
//
// The work itself lives in src/lib/records/buildRecords.ts, which the live
// upload pipeline calls too. This script is the manual entry point and nothing
// more: dating, classification and entry-writing must not differ between a case
// that was uploaded and the same case rebuilt by hand.
//
// Nothing is written unless the whole case composed successfully, and events a
// reviewer has touched are never replaced.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, PrismaClient } from "@/generated/prisma";
import { buildRecords, persistRecords, type RecordSource, type RecordStore } from "@/lib/records/buildRecords";
import { ACTIVE_ENCOUNTER_WHERE } from "@/lib/records/encounterLifecycle";
import type { MergeableRow } from "@/lib/records/entryMerge";

const ROW_SELECT = {
  id: true,
  sourceDocumentId: true,
  analysisClass: true,
  encounterDate: true,
  dateStatus: true,
  segmentKey: true,
  provider: true,
  facility: true,
  page: true,
  pageEnd: true,
  substanceClass: true,
  claims: true,
  // Review state and any human corrections. Without these a rebuild cannot
  // tell a physician's summary from one it wrote itself.
  status: true,
  factualSummary: true,
  encounterType: true,
  providerCredentials: true,
  verifiedContentHash: true,
} as const;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  // On by default; --no-adjudicate falls back to the deterministic result.
  const adjudicate = !args.includes("--no-adjudicate");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: npm run records:rebuild -- <caseId|caseNumber> [--dry-run] [--no-adjudicate]");
    process.exit(1);
  }

  const db = new PrismaClient();
  const theCase = await db.case.findFirst({
    where: { OR: [{ id: target }, { caseNumber: target }] },
    select: { id: true, caseNumber: true, clientName: true },
  });
  if (!theCase) {
    console.error(`no case matching ${target}`);
    process.exit(1);
  }
  console.log(`case ${theCase.caseNumber ?? theCase.id}${dryRun ? "  (dry run)" : ""}`);

  const documents = await db.document.findMany({
    where: { caseId: theCase.id },
    select: { id: true, pageCount: true, extractedText: true },
  });

  const sources: RecordSource[] = [];
  for (const doc of documents) {
    const rows = (await db.extractedEncounter.findMany({
      where: { caseId: theCase.id, sourceDocumentId: doc.id, ...ACTIVE_ENCOUNTER_WHERE },
      select: ROW_SELECT,
    })) as unknown as MergeableRow[];
    sources.push({ id: doc.id, pageCount: doc.pageCount, extractedText: doc.extractedText, rows });
  }

  const built = await buildRecords({
    caseId: theCase.id,
    patientName: theCase.clientName,
    documents: sources,
    write: !dryRun,
    adjudicateDuplicates: adjudicate,
    onProgress: (done, total) => {
      if (done % 25 === 0) process.stdout.write(`\r  ${done}/${total} composed   `);
    },
  });

  report(built);

  if (dryRun) {
    console.log("\ndry run — nothing written");
    await db.$disconnect();
    return;
  }

  const result = await persistRecords(asStore(db), theCase.id, built);
  if (!result.published) {
    console.error(`\nNOT PUBLISHED: ${result.reason}`);
    await db.$disconnect();
    process.exit(1);
  }
  console.log(
    `\npublished: ${result.documentsUpdated} documents, ${result.chronologyInserted} events inserted, ` +
      `${result.draftsRemoved} drafts replaced, ${result.reviewedKept} reviewed events kept`,
  );
  await db.$disconnect();
}

function report(built: Awaited<ReturnType<typeof buildRecords>>) {
  const { stats } = built;
  console.log(`
  source documents      ${stats.documents}  (${stats.pages} pages)
  extracted rows        ${stats.rows}
  consolidated notes    ${stats.notes} -> ${stats.afterDedupe} after cross-document dedupe
  chronology events     ${stats.chronologyEvents}
  undated clinical      ${stats.undatedClinical}
  writer fallbacks      ${stats.fallbacks}
  failures              ${stats.failures}`);

  if (stats.adjudication) {
    const a = stats.adjudication;
    console.log(`\n  duplicate adjudication: ${a.candidates} undecided pairs, ${a.asked} asked, ${a.merged} merged, ${a.failed} failed`);
  }

  console.log("\n  dates by basis:");
  for (const [basis, n] of Object.entries(stats.dateBasis).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)} ${basis}`);
  }
  if (Object.keys(stats.insubstantial).length) {
    console.log("\n  kept out of the clinical list:");
    for (const [reason, n] of Object.entries(stats.insubstantial).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)} ${reason}`);
    }
  }
  console.log("\n  held off the timeline:");
  for (const [reason, n] of Object.entries(stats.heldOffTimeline).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)} ${reason}`);
  }

  if (built.failures.length) {
    console.error(`\n${built.failures.length} note(s) failed to compose:`);
    for (const failure of built.failures.slice(0, 10)) console.error(`  ${failure.error}`);
  }
}

/** Prisma with the narrow surface persistence asks for. */
function asStore(db: PrismaClient): RecordStore {
  const wrap = (client: Pick<PrismaClient, "document" | "chronologyEvent">): RecordStore => ({
    document: {
      update: ({ where, data }) =>
        client.document.update({
          where,
          data: { segments: data.segments as unknown as Prisma.InputJsonValue },
        }),
    },
    chronologyEvent: {
      count: (args) => client.chronologyEvent.count(args as never),
      findMany: (args) => client.chronologyEvent.findMany(args as never) as never,
      deleteMany: (args) => client.chronologyEvent.deleteMany(args as never),
      createMany: (args) => client.chronologyEvent.createMany({ data: args.data as never }),
    },
    $transaction: (work) => db.$transaction((tx) => work(wrap(tx)), { timeout: 120_000 }),
  });
  return wrap(db);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
