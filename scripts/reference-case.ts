// ─────────────────────────────────────────────────────────────────────────────
// Reference-case intake: feed a REAL case's source records (and, optionally,
// its professionally finalized report) into the pipeline so it becomes a
// worked example — and, once reviewed, a gold-standard exemplar the learning
// loop scores against.
//
//   npx tsx scripts/reference-case.ts "<Client Name>" /path/to/case-folder
//
// Folder layout (all optional except at least one record):
//   records/*.pdf|*.docx|*.txt   — the medical/vocational/financial records
//   final-report.pdf|.docx|.txt  — the finalized professional report, if any
//   meta.json                    — { caseNumber?, side?, caseType?, dateOfBirth?,
//                                    sex?, primaryDiagnosis?, icd10Code? }
//
// What it does (existing pipeline only — nothing bespoke):
//   1. Creates the case under the demo firm (or FIRM_ID env).
//   2. Ingests every file in records/ through ingestDocument (real extraction,
//      classification, segmentation — same as a UI upload).
//   3. Attaches final-report.* as a REFERENCE document (type EXPERT_REPORT),
//      clearly labeled — it is never treated as case records.
//   4. Runs generatePlan → validation → reasoning.
//   5. Prints the review checklist and the gold-capture command.
//
// It does NOT fabricate diagnoses, providers, or review decisions. Diagnosis
// suggestions surface in the Intake tab for a human to approve; physician
// review happens in the Review queue; only then is gold capture meaningful.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { prisma } from "../src/lib/db";
import { ingestDocument } from "../src/lib/documents/ingest";
import { generatePlan } from "../src/lib/engine/generate";
import { persistCaseValidation } from "../src/lib/engine/validation";
import { persistCaseReasoning } from "../src/lib/engine/clinicalReasoningPersist";

const RECORD_EXTS = new Set([".pdf", ".docx", ".doc", ".txt", ".csv"]);

async function main() {
  const [name, dir] = process.argv.slice(2);
  if (!name || !dir || !existsSync(dir)) {
    console.error('Usage: npx tsx scripts/reference-case.ts "<Client Name>" /path/to/case-folder');
    process.exit(1);
  }
  const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
  const firm = process.env.FIRM_ID
    ? await prisma.firm.findUniqueOrThrow({ where: { id: process.env.FIRM_ID } })
    : await prisma.firm.findFirstOrThrow();
  const admin = await prisma.user.findFirstOrThrow({ where: { firmId: firm.id, role: "ADMIN" } });

  const count = await prisma.case.count({ where: { firmId: firm.id } });
  const c = await prisma.case.create({
    data: {
      firmId: firm.id,
      createdById: admin.id,
      caseNumber: meta.caseNumber ?? `REF-${String(count + 1).padStart(4, "0")}`,
      clientName: name,
      caseType: meta.caseType ?? "PERSONAL_INJURY",
      side: meta.side ?? "PLAINTIFF",
      status: "RECORDS",
      dateOfBirth: meta.dateOfBirth ? new Date(meta.dateOfBirth) : null,
      sex: meta.sex ?? "UNKNOWN",
      diagnosis: meta.primaryDiagnosis ?? "",
      icd10Code: meta.icd10Code ?? "",
    },
  });
  console.log(`Case created: ${c.caseNumber} (${c.id})`);

  // ── Records: real extraction path, file by file ────────────────────────────
  const recordsDir = existsSync(join(dir, "records")) ? join(dir, "records") : dir;
  const files = readdirSync(recordsDir)
    .filter((f) => RECORD_EXTS.has(extname(f).toLowerCase()) && !f.startsWith("final-report") && statSync(join(recordsDir, f)).isFile());
  if (files.length === 0) console.warn("No record files found — the case will be an empty shell.");
  for (const f of files) {
    const buffer = readFileSync(join(recordsDir, f));
    try {
      const res = await ingestDocument({ caseId: c.id, firmId: firm.id, uploadedById: admin.id, filename: f, buffer });
      console.log(`  ingested ${f} → ${res.document.type} (${res.pages} pp, ${res.method})`);
    } catch (e) {
      console.error(`  FAILED ${f}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // ── Finalized professional report, clearly labeled as reference ────────────
  const finalReport = readdirSync(dir).find((f) => f.startsWith("final-report") && RECORD_EXTS.has(extname(f).toLowerCase()));
  if (finalReport) {
    const buffer = readFileSync(join(dir, finalReport));
    await ingestDocument({
      caseId: c.id, firmId: firm.id, uploadedById: admin.id,
      filename: `REFERENCE-${basename(finalReport)}`,
      buffer,
      forcedType: "EXPERT_REPORT",
    });
    console.log(`  reference report attached: ${finalReport} (type EXPERT_REPORT — excluded from clinical extraction by type)`);
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────
  console.log("Running AI pipeline…");
  await generatePlan(c.id, { userId: admin.id, role: "ADMIN" });
  await persistCaseValidation(c.id, firm.id).catch((e) => console.warn("validation:", (e as Error).message.slice(0, 80)));
  await persistCaseReasoning(c.id, firm.id, {}).catch((e) => console.warn("reasoning:", (e as Error).message.slice(0, 80)));

  const [items, findings] = await Promise.all([
    prisma.futureCareItem.count({ where: { caseId: c.id, supersededAt: null } }),
    prisma.validationFinding.count({ where: { caseId: c.id } }),
  ]);
  console.log(`\nDone: ${items} future-care items, ${findings} validation findings.`);
  console.log(`\nNext steps to make this a gold exemplar:`);
  console.log(`  1. Open the case, review the Intake tab's suggested diagnoses (approve/adjust).`);
  console.log(`  2. Re-run the pipeline if diagnoses changed, then complete physician review`);
  console.log(`     (approve/modify/reject each item against the finalized report's answers).`);
  console.log(`  3. Capture it: npx tsx scripts/gold-capture.ts ${c.id} "<gold-name>"`);
  console.log(`  4. Score generation against it: npx tsx scripts/gold-harness.ts "<gold-name>"`);
  console.log(`  5. Fold the corrections into learned priors: npx tsx scripts/learn.ts`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
