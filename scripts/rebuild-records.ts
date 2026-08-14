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
import { buildRecords, makeRecordStore, persistRecords, type RecordSource } from "@/lib/records/buildRecords";
import { CURRENT_OUTPUT_WHERE } from "@/lib/records/encounterLifecycle";
import { caseFingerprint, caseLockKey } from "@/lib/records/buildRecords";
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
      where: { caseId: theCase.id, sourceDocumentId: doc.id, ...CURRENT_OUTPUT_WHERE },
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

  const result = await persistRecords(makeRecordStore(db as never), theCase.id, built);

  // Why every adjudicated pair was merged or kept apart, made durable.
  // Append-only and after publication: an audit of a build that did not
  // publish still happened, but recording it against the case would read as
  // describing the published state.
  if (result.published && built.adjudicationAudit.length) {
    const firm = await db.case.findUnique({ where: { id: theCase.id }, select: { firmId: true } });
    if (firm) {
      await db.duplicateAdjudication.createMany({
        data: built.adjudicationAudit.map((r) => ({
          firmId: firm.firmId,
          caseId: theCase.id,
          aRowIds: r.aRowIds,
          bRowIds: r.bRowIds,
          aDocumentId: r.aDocumentId,
          bDocumentId: r.bDocumentId,
          aContentHash: r.aContentHash,
          bContentHash: r.bContentHash,
          encounterDate: r.encounterDate ? new Date(`${r.encounterDate}T00:00:00Z`) : null,
          aProvider: r.aProvider,
          bProvider: r.bProvider,
          attribution: r.attribution,
          candidacyReason: r.candidacyReason,
          decision: r.decision,
          confidence: r.confidence,
          explanation: r.explanation,
          llmProvider: r.provider,
          llmModel: r.model,
          promptVersion: r.promptVersion,
          schemaVersion: r.schemaVersion,
          merged: r.decision === "MERGED",
          decidedAt: new Date(r.decidedAt),
        })),
      });
      console.log(`  adjudication audit: ${built.adjudicationAudit.length} decisions recorded`);
    }
  }

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

  if (stats.patientAttribution) {
    const pa = stats.patientAttribution;
    console.log(`\n  patient-name attribution: ${pa.candidates} resembling the patient, ${pa.asked} asked, ${pa.cleared.length} cleared, ${pa.failed} failed`);
    for (const c of pa.cleared) {
      console.log(`    cleared  ${c.date ?? "undated"}  "${c.provider}"  ${c.reason.slice(0, 90)}`);
    }
  }

  if (stats.adjudication) {
    const a = stats.adjudication;
    console.log(`\n  duplicate adjudication: ${a.candidates} undecided pairs, ${a.asked} asked, ${a.merged} merged, ${a.failed} failed`);
    if (a.truncated) {
      console.log("    NOTE: the pair cap was reached — coverage is incomplete and depends on iteration order");
    }
    for (const record of built.adjudicationAudit.filter((r) => r.decision === "MERGED")) {
      console.log(`    merged  ${record.encounterDate ?? "undated"}  ${record.attribution}  ${record.explanation.slice(0, 90)}`);
    }
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
