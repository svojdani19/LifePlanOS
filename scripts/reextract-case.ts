// ─────────────────────────────────────────────────────────────────────────────
// Re-extract every document of a case, one at a time, with progress.
//
//   npm run records:reextract -- <caseId|caseNumber>
//
// Sequential on purpose: the pipeline already runs chunks concurrently inside
// a document, and stacking documents on top of that is how a provider starts
// refusing. Smallest documents first, so a systematic problem shows up in
// minutes rather than after the 625-page one.
//
// Each document is independent: a failure is reported and the run moves on.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@/generated/prisma";
import { processDocumentExtraction } from "@/lib/documents/extractionRun";

const db = new PrismaClient();

const hhmm = (ms: number) => `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`;

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("usage: npm run records:reextract -- <caseId|caseNumber>");
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
    select: { id: true, filename: true, pageCount: true },
    orderBy: { pageCount: "asc" },
  });

  console.log(`case ${theCase.caseNumber}: re-extracting ${documents.length} documents\n`);
  const startedAll = Date.now();
  let ok = 0;
  let failed = 0;

  for (const [i, doc] of documents.entries()) {
    const label = `[${i + 1}/${documents.length}] ${doc.filename} (${doc.pageCount ?? "?"}pp)`;
    const started = Date.now();
    try {
      // One rebuild at the end, not one per document: the rebuild is
      // case-wide, so per-document is quadratic work.
      const result = await processDocumentExtraction(doc.id, { force: true, deferDerivedRefresh: true });
      const took = hhmm(Date.now() - started);
      console.log(`${label}\n    ${result.status} — ${result.accepted} accepted, ${result.rejected} rejected, ${took}`);
      if (result.status === "COMPLETE") ok++;
      else failed++;
    } catch (error) {
      failed++;
      console.log(`${label}\n    THREW — ${String(error).slice(0, 160)}`);
    }
  }

  // The rebuild every document's run deferred. Until this runs, the Records
  // page and chronology still describe the PREVIOUS extraction.
  console.log("\nrebuilding records and chronology once for the whole case…");
  const rebuildStarted = Date.now();
  const { makeRecordStore, refreshCaseRecordsWithRecovery } = await import("@/lib/records/buildRecords");
  const refreshed = await refreshCaseRecordsWithRecovery(makeRecordStore(db as never), theCase.id);
  console.log(`  ${refreshed.published ? "published" : "NOT published"} — ${refreshed.status} (${hhmm(Date.now() - rebuildStarted)})`);

  // What the whole case looks like now, by the audit's own verdicts.
  const byAudit = await db.extractedEncounter.groupBy({
    by: ["auditResult"],
    where: { caseId: theCase.id, status: { in: ["AI_DRAFT", "AI_AUDIT_PASSED"] } },
    _count: true,
  });
  console.log(`\ndone in ${hhmm(Date.now() - startedAll)}: ${ok} complete, ${failed} not`);
  console.log("current rows by audit result:");
  for (const row of byAudit.sort((a, b) => b._count - a._count)) {
    console.log(`  ${String(row._count).padStart(5)} ${row.auditResult ?? "none"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
