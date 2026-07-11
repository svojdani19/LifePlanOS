// Re-run OCR/extraction for stored documents whose text never made it out —
// scans uploaded before the OCR pipeline existed, or docs whose OCR failed.
//
//   npm run ocr:redo                    # every PDF document with (near-)empty text
//   npm run ocr:redo -- <caseId|name>   # only that case's documents
//
// Processes serially and prints progress; safe to re-run.

import { prisma } from "../src/lib/db";
import { processDocumentNow } from "../src/lib/documents/ocrQueue";

async function main() {
  const filter = process.argv[2]?.trim();
  const cases = filter
    ? await prisma.case.findMany({ where: { OR: [{ id: filter }, { clientName: { contains: filter, mode: "insensitive" } }] }, select: { id: true, clientName: true } })
    : await prisma.case.findMany({ select: { id: true, clientName: true } });
  const caseIds = cases.map((c) => c.id);

  const docs = await prisma.document.findMany({
    where: { caseId: { in: caseIds }, storageKey: { not: null }, filename: { endsWith: ".pdf", mode: "insensitive" } },
    select: { id: true, filename: true, pageCount: true, extractedText: true, case: { select: { clientName: true } } },
    orderBy: { createdAt: "asc" },
  });
  const todo = docs.filter((d) => (d.extractedText?.length ?? 0) / Math.max(1, d.pageCount ?? 1) < 60);
  if (!todo.length) {
    console.log("No documents need OCR reprocessing.");
    return;
  }
  console.log(`Reprocessing ${todo.length} document(s)…`);
  for (const d of todo) {
    console.log(`\n▸ ${d.case.clientName} — ${d.filename} (${d.pageCount ?? "?"} pages)`);
    try {
      await processDocumentNow(d.id);
    } catch (e) {
      console.error(`  FAILED: ${(e as Error).message}`);
    }
  }
  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
