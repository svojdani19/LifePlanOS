// Enforce per-firm data-retention policies (Enterprise).
//
// For every firm with dataRetentionDays set, purges the PHI of CLOSED/ARCHIVED
// cases inactive past the window: stored record files (object storage),
// extracted/OCR text, parsed segments, and verbatim chronology source quotes.
// The case shell, chronology summaries, diagnoses, the plan, findings, export
// METADATA, and the append-only audit trail are retained — the legal record of
// what was done survives; the patient's chart does not outlive the policy.
//
//   npm run retention:enforce             # apply every firm's policy
//   npm run retention:enforce -- --dry    # report what WOULD purge, change nothing
//
// Safe to re-run: already-purged documents (no storageKey, no text) are no-ops.
// Every purged case writes a retention.purge audit event with counts.

import { prisma } from "../src/lib/db";
import { deleteObject } from "../src/lib/storage";
import { retentionCandidates, normalizeRetentionDays } from "../src/lib/security/retention";

async function main() {
  const dry = process.argv.includes("--dry");
  const now = new Date();
  const firms = await prisma.firm.findMany({
    where: { dataRetentionDays: { not: null } },
    select: { id: true, name: true, dataRetentionDays: true },
  });
  if (!firms.length) {
    console.log("No firm has a data-retention policy set. Nothing to do.");
    return;
  }

  for (const firm of firms) {
    const days = normalizeRetentionDays(firm.dataRetentionDays);
    const cases = await prisma.case.findMany({
      where: { firmId: firm.id, status: { in: ["CLOSED", "ARCHIVED"] } },
      select: { id: true, caseNumber: true, status: true, updatedAt: true },
    });
    const due = retentionCandidates(now, days, cases);
    console.log(`${firm.name}: ${days}-day window — ${due.length} of ${cases.length} closed/archived case(s) past retention.`);

    for (const kase of due) {
      const docs = await prisma.document.findMany({
        where: { caseId: kase.id },
        select: { id: true, storageKey: true, extractedText: true },
      });
      const withObjects = docs.filter((d) => d.storageKey);
      const withText = docs.filter((d) => d.extractedText);
      if (dry) {
        console.log(`  [dry] ${kase.caseNumber}: would purge ${withObjects.length} stored file(s), ${withText.length} extracted text(s).`);
        continue;
      }

      for (const d of withObjects) await deleteObject(d.storageKey!).catch(() => {});
      await prisma.document.updateMany({
        where: { caseId: kase.id },
        data: { storageKey: null, extractedText: null, flags: "Purged per firm data-retention policy" },
      });
      // Json columns cannot be nulled through updateMany — clear segments directly.
      await prisma.$executeRaw`UPDATE "Document" SET "segments" = NULL WHERE "caseId" = ${kase.id}`;
      await prisma.chronologyEvent.updateMany({ where: { caseId: kase.id }, data: { sourceQuote: null } });

      await prisma.auditLog.create({
        data: {
          firmId: firm.id,
          action: "retention.purge",
          targetType: "case",
          targetId: kase.id,
          caseId: kase.id,
          meta: { caseNumber: kase.caseNumber, retentionDays: days, purgedFiles: withObjects.length, purgedTexts: withText.length },
        },
      });
      console.log(`  ${kase.caseNumber}: purged ${withObjects.length} stored file(s), ${withText.length} extracted text(s).`);
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
