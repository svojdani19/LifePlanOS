// ─────────────────────────────────────────────────────────────────────────────
// Apply the CURRENT deterministic audit rules to a case, with no model calls.
//
//   npm run records:reaudit -- <caseId|caseNumber>
//   npm run records:reaudit -- <caseId|caseNumber> --dry-run
//
// Corrected deterministic rules should not require hours of re-extraction to
// take effect: everything the audit reads is already persisted. Extracted
// facts, human review states, verification hashes and history are untouched;
// only machine rows move between AI_DRAFT and AI_AUDIT_PASSED, and only where
// the current rules justify it.
//
// Prints aggregate, PHI-free counts only.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@/generated/prisma";
import { CURRENT_OUTPUT_WHERE } from "@/lib/records/encounterLifecycle";
import { planReaudit, AUDIT_VERSION, type ReauditDocument } from "@/lib/records/reaudit";
import { writeFindings } from "@/lib/records/recordFindings";

const db = new PrismaClient();

async function main() {
  const key = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!key) {
    console.error("usage: npm run records:reaudit -- <caseId|caseNumber> [--dry-run]");
    process.exit(1);
  }
  const theCase = await db.case.findFirst({
    where: { OR: [{ id: key }, { caseNumber: key }] },
    select: { id: true, caseNumber: true, firmId: true },
  });
  if (!theCase) {
    console.error(`no case matches "${key}"`);
    process.exit(1);
  }

  const documents = await db.document.findMany({ where: { caseId: theCase.id }, select: { id: true, segments: true } });
  const failedDocs = await db.recordExtraction.count({
    where: { caseId: theCase.id, status: { in: ["EXTRACTION_FAILED", "BLOCKED_OCR"] } },
  });

  const built: ReauditDocument[] = [];
  for (const doc of documents) {
    const rows = await db.extractedEncounter.findMany({
      where: { caseId: theCase.id, sourceDocumentId: doc.id, ...CURRENT_OUTPUT_WHERE },
      select: {
        id: true, sourceDocumentId: true, status: true, auditResult: true, auditVersion: true, dateStatus: true,
        encounterDate: true, provider: true, encounterType: true, factualSummary: true, synthesis: true,
        claims: true, page: true, unresolvedDisputes: true, contradictedFields: true,
      },
    });
    if (!rows.length) continue;
    const pages = await db.sourcePage.findMany({
      where: { sourceDocumentId: doc.id },
      select: { pageNumber: true, status: true, ocrConfidence: true },
    }).catch(() => [] as { pageNumber: number; status: string; ocrConfidence: number | null }[]);
    const run = await db.recordExtraction.findFirst({
      where: { sourceDocumentId: doc.id, status: "COMPLETE" },
      orderBy: { createdAt: "desc" },
      select: { coverageGaps: true, truncated: true },
    });
    built.push({
      id: doc.id,
      firmId: theCase.firmId,
      caseId: theCase.id,
      segments: doc.segments,
      rows: rows as never,
      pages,
      // failedSections is not persisted as a count; the deterministic rules
      // read it from findings once those exist. Zero here is honest: this pass
      // never invents a blocker it cannot see.
      run: { coverageGaps: run?.coverageGaps ?? 0, failedSections: 0, truncated: run?.truncated ?? false },
    });
  }

  const plan = planReaudit(built, { failedExtractions: failedDocs, allDocumentsProcessed: failedDocs === 0 });

  console.log(`case ${theCase.caseNumber} — deterministic re-audit at ${AUDIT_VERSION}${dryRun ? " (dry run)" : ""}`);
  console.log(`  rows examined        ${plan.summary.rows}`);
  console.log(`  audit result changed ${plan.summary.changedResult}`);
  console.log(`  row status changed   ${plan.summary.changedStatus}`);
  console.log(`  human rows untouched ${plan.summary.humanRowsUntouched}`);
  console.log(`  scoped findings      ${plan.summary.findingsDerived}`);

  const before = tally(plan.results.map((r) => r.before ?? "none"));
  const after = tally(plan.results.map((r) => r.after));
  console.log("\n  before:", render(before));
  console.log("  after :", render(after));

  if (dryRun) {
    console.log("\ndry run: nothing written");
    return;
  }

  for (const r of plan.results) {
    if (r.before === r.after && r.statusBefore === r.statusAfter) continue;
    await db.extractedEncounter.update({
      where: { id: r.id },
      data: { auditResult: r.after, status: r.statusAfter, auditVersion: AUDIT_VERSION },
    });
  }
  const written = await writeFindings(db as never, plan.findings, {
    caseId: theCase.id,
    sources: ["DETERMINISTIC_VALIDATOR"],
  });
  console.log(`\nwrote ${written.written} finding(s); ${written.resolved} stale finding(s) resolved`);
}

const tally = (values: string[]) => {
  const t = new Map<string, number>();
  for (const v of values) t.set(v, (t.get(v) ?? 0) + 1);
  return t;
};
const render = (t: Map<string, number>) => [...t].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
